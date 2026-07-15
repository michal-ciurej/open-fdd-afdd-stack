#requires -Version 7.0
<#
.SYNOPSIS
    Sequential Azure deploy for the AFDD stack: build images, roll the API,
    roll both fdd-loop jobs, then build + deploy the frontend.

.DESCRIPTION
    Runs the per-change deploy workflow documented in README.md ("Azure deployment",
    steps 0-5) one step at a time. Each step streams its output to the console AND to
    a log file, waits for the step to actually finish, and checks the exit code before
    moving on. The FIRST failing step aborts the whole run and prints what went wrong
    plus the log path. Nothing is committed - that is left to you.

    Order: pre-flight -> build API image -> build fdd-loop image -> roll API (wait for
    Healthy) -> update BOTH jobs in lockstep -> smoke-start + await jobs -> build
    frontend -> deploy frontend. Both backend images are built BEFORE any live roll, so
    a build failure never leaves a half-deployed stack.

.NOTES
    Image tags are git short-SHAs (README footgun: a SHA tag on uncommitted code makes
    rollbacks lie). A dirty tree therefore stops the run. Commit first (your job), or
    pass -AllowDirty to build a unique dev-<UTC> tag instead.

.EXAMPLE
    pwsh ./scripts/deploy-azure.ps1
        Full deploy from a clean tree, with a confirmation prompt.

.EXAMPLE
    pwsh ./scripts/deploy-azure.ps1 -AllowDirty -Yes
        Deploy uncommitted work under a dev-<UTC> tag, no prompt.

.EXAMPLE
    pwsh ./scripts/deploy-azure.ps1 -JobSmoke loop
        Update both jobs but only smoke-run predmain-fdd-loop (skip nightly-sync run).
#>
[CmdletBinding()]
param(
    # Proceed with a dirty working tree by tagging images 'dev-<UTC>' instead of the SHA.
    [switch]$AllowDirty,

    # Skip the "about to deploy" confirmation prompt.
    [switch]$Yes,

    # Which jobs to smoke-start after the lockstep update:
    #   both = fdd-loop + nightly-sync (README default, catches the historical
    #          "nightly-sync image lacks run_nightly_sync.py" silent failure)
    #   loop = only predmain-fdd-loop
    #   none = update jobs but do not run them
    [ValidateSet('both', 'loop', 'none')]
    [string]$JobSmoke = 'both',

    [string]$ResourceGroup      = 'Live_Services',
    [string]$Registry           = '3mseContainers',
    [string]$RegistryLoginServer = '3msecontainers.azurecr.io',
    [string]$BaseImage          = '3msecontainers.azurecr.io/python:3.14-slim',
    [string]$TenantId           = 'fce6e120-a4ac-468f-bce8-0a9efa296639',

    [int]$ApiHealthyTimeoutMin  = 10,   # how long to wait for the new API revision to run
    [int]$JobTimeoutMin         = 20,   # how long to wait for a smoke job execution to finish

    # Where run logs go. Defaults to a temp dir so the repo working tree stays clean.
    [string]$LogDir = (Join-Path $env:TEMP 'predmain-deploy')
)

# ---------------------------------------------------------------------------
# Shell setup: stop on cmdlet errors, but let US handle native exit codes so a
# failing az/npm/git routes through our logging instead of a raw throw.
# ---------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false   # PS 7.3+: don't auto-throw on native non-zero

$OrigLocation = Get-Location

# Component names (README "What lives where").
$ApiApp        = 'predmain-api'
$LoopJob       = 'predmain-fdd-loop'
$SyncJob       = 'predmain-nightly-sync'
$ApiImageRepo  = 'predmain-api'
$LoopImageRepo = 'predmain-fdd-loop'      # ONE image shared by both jobs
$SwaApp        = 'predmain-frontend'

# Run-wide state.
$script:StepIndex = 0
$script:Results   = [System.Collections.Generic.List[object]]::new()
$script:Warnings  = [System.Collections.Generic.List[string]]::new()
$script:TAG       = '(unset)'   # set once the tag is resolved
$script:RevName   = '(unset)'   # set once the API revision name is built
$script:LogFile   = $null       # set once the log file is opened

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function San {
    # Sanitize into a valid ACA revision suffix: lower alphanumerics + single dashes,
    # must start with a letter and end alphanumeric.
    param([string]$s)
    $s = $s.ToLower() -replace '[^a-z0-9-]', '-'
    $s = $s -replace '-{2,}', '-'
    $s = $s.Trim('-')
    if ($s -notmatch '^[a-z]') { $s = "r$s" }
    return $s
}

function Log {
    param([string]$msg)
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $script:LogFile -Value $line
}

function Assert-Native {
    # Turn a non-zero $LASTEXITCODE from the immediately preceding native command
    # into a terminating error that Invoke-Step catches.
    param([string]$What)
    if ($LASTEXITCODE -ne 0) { throw "native command failed (exit $LASTEXITCODE): $What" }
}

function Show-Summary {
    Write-Host ""
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host " SUMMARY" -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host ("  Tag deployed : {0}" -f $script:TAG)
    Write-Host ("  Resource grp : {0}" -f $ResourceGroup)
    Write-Host ("  API revision : {0}" -f $script:RevName)
    Write-Host ""
    if ($script:Results.Count) {
        $script:Results | Format-Table -AutoSize @(
            @{ Label = '#';      Expression = { $_.Index } },
            @{ Label = 'Step';   Expression = { $_.Step } },
            @{ Label = 'Status'; Expression = { $_.Status } },
            @{ Label = 'Secs';   Expression = { $_.Seconds } }
        ) | Out-String | Write-Host
    }
    if ($script:Warnings.Count) {
        Write-Host "  Warnings:" -ForegroundColor Yellow
        foreach ($w in $script:Warnings) { Write-Host "    - $w" -ForegroundColor Yellow }
        Write-Host ""
    }
    Write-Host "  Log: $script:LogFile"
}

function Stop-Deploy {
    param([string]$Step, [string]$Detail)
    Add-Content -Path $script:LogFile -Value "`n===== FAILURE at: $Step =====`n$Detail"
    Write-Host ""
    Write-Host ('#' * 72) -ForegroundColor Red
    Write-Host " DEPLOY ABORTED at: $Step" -ForegroundColor Red
    Write-Host ('#' * 72) -ForegroundColor Red
    if ($Detail) { Write-Host ($Detail.Trim()) -ForegroundColor Yellow }
    Show-Summary
    Write-Host ""
    Write-Host " Fix the above, then re-run. Nothing was committed." -ForegroundColor Red
    Set-Location $OrigLocation
    exit 1
}

function Invoke-Step {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Action
    )
    $script:StepIndex++
    $idx   = $script:StepIndex
    $start = Get-Date
    Write-Host ""
    Write-Host (("-- [{0}] {1} " -f $idx, $Name).PadRight(72, '-')) -ForegroundColor Cyan
    Add-Content -Path $script:LogFile -Value "`n`n########## [$idx] $Name  ($(Get-Date -Format s)) ##########"
    try {
        & $Action
    }
    catch {
        $sec = [int]((Get-Date) - $start).TotalSeconds
        $script:Results.Add([pscustomobject]@{ Index = $idx; Step = $Name; Status = 'FAILED'; Seconds = $sec })
        Stop-Deploy -Step $Name -Detail ($_ | Out-String)
    }
    $sec = [int]((Get-Date) - $start).TotalSeconds
    $script:Results.Add([pscustomobject]@{ Index = $idx; Step = $Name; Status = 'OK'; Seconds = $sec })
    Write-Host ("OK [{0}] {1}  ({2}s)" -f $idx, $Name, $sec) -ForegroundColor Green
}

function Start-AndWaitJob {
    # Start one ACA job and poll its execution to a terminal state.
    param([string]$Job)
    $exec = az containerapp job start -g $ResourceGroup -n $Job -o json 2>>$script:LogFile | ConvertFrom-Json
    Assert-Native "job start $Job"
    $execName = $exec.name
    if (-not $execName) {
        $execName = (az containerapp job execution list -g $ResourceGroup --name $Job --query '[0].name' -o tsv 2>>$script:LogFile)
    }
    Log "  ${Job}: started execution $execName"

    $deadline = (Get-Date).AddMinutes($JobTimeoutMin)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 10
        $status = az containerapp job execution list -g $ResourceGroup --name $Job `
            --query "[?name=='$execName'].properties.status | [0]" -o tsv 2>>$script:LogFile
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($status)) { continue }
        Log "  $Job/$execName : $status"
        switch ($status) {
            'Succeeded' { return }
            'Failed'    { throw "job $Job execution $execName FAILED (see Log Analytics / README 'Pulling logs')" }
            'Degraded'  { throw "job $Job execution $execName DEGRADED" }
        }
    }
    $msg = "job $Job execution $execName still running after ${JobTimeoutMin}m - continuing (not a failure)"
    Write-Warning $msg
    $script:Warnings.Add($msg)
}

# ---------------------------------------------------------------------------
# Setup: locate repo, open log, resolve SHA / tag, decide on dirty tree.
# ---------------------------------------------------------------------------
try {
    $RepoRoot = (git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($RepoRoot)) {
        throw "not inside a git repository - run this from the AFDD stack checkout"
    }
    $RepoRoot = $RepoRoot.Trim()
    Set-Location $RepoRoot

    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $RunStamp        = Get-Date -Format 'yyyyMMdd-HHmmss'
    $script:LogFile  = Join-Path $LogDir "deploy-$RunStamp.log"
    New-Item -ItemType File -Path $script:LogFile -Force | Out-Null

    Log "AFDD Azure deploy - repo=$RepoRoot"

    # README step 0 pre-flight env (colorama/cp1252 + ACR base pull).
    $env:PYTHONUTF8       = '1'
    $env:PYTHONIOENCODING = 'utf-8'

    # --- git status (the "from git status" starting point) ---
    Write-Host ""
    Write-Host "git status:" -ForegroundColor Cyan
    git status --short --branch 2>&1 | Tee-Object -FilePath $script:LogFile -Append
    Assert-Native "git status"

    $SHA       = (git rev-parse --short HEAD).Trim()
    $porcelain = (git status --porcelain) -join "`n"
    $dirty     = -not [string]::IsNullOrWhiteSpace($porcelain)

    if ($dirty) {
        if ($AllowDirty) {
            $utc = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
            $script:TAG = "dev-$utc"
            $tagNote = "DIRTY tree -> dev tag '$($script:TAG)' (SHA $SHA NOT used; re-tag with the SHA once committed)"
        }
        else {
            Log "Working tree is DIRTY."
            Write-Host ""
            Write-Host "Working tree is DIRTY - refusing to tag an image with SHA $SHA." -ForegroundColor Red
            Write-Host "Image tags are git SHAs; a SHA tag on uncommitted code makes rollbacks lie (README)." -ForegroundColor Red
            Write-Host "  * Commit your changes (that's your job), then re-run, OR" -ForegroundColor Yellow
            Write-Host "  * re-run with -AllowDirty to build a unique dev-<UTC> tag instead." -ForegroundColor Yellow
            Set-Location $OrigLocation
            exit 1
        }
    }
    else {
        $script:TAG = $SHA
        $tagNote = "clean tree -> tag = SHA '$SHA'"
    }

    $RevSuffix       = San "api-$($script:TAG)-$RunStamp"
    $script:RevName  = "$ApiApp--$RevSuffix"

    # --- confirmation ---
    Write-Host ""
    Write-Host "About to deploy to Azure resource group '$ResourceGroup':" -ForegroundColor Cyan
    Write-Host "  Image tag       : $($script:TAG)"
    Write-Host "                    ($tagNote)"
    Write-Host "  Build           : $ApiImageRepo + $LoopImageRepo  (via az acr build, ACR '$Registry')"
    Write-Host "  Roll API        : $ApiApp  ->  revision $($script:RevName)"
    Write-Host "  Update jobs     : $LoopJob + $SyncJob  (lockstep, same image)"
    Write-Host "  Smoke jobs      : $JobSmoke"
    Write-Host "  Frontend        : npm run build:swa  ->  swa deploy ./dist (production)"
    Write-Host "  Log             : $($script:LogFile)"
    Write-Host ""
    if (-not $Yes) {
        $ans = Read-Host "Proceed? (y/N)"
        if ($ans -notmatch '^(y|yes)$') {
            Write-Host "Aborted by user (nothing changed)."
            Set-Location $OrigLocation
            exit 2
        }
    }

    # =======================================================================
    # STEP 1 - Pre-flight: confirm we're logged into the right Azure context.
    # =======================================================================
    Invoke-Step "Pre-flight: az account" {
        $acctJson = az account show -o json 2>>$script:LogFile
        Assert-Native "az account show (run 'az login' first?)"
        $a = $acctJson | ConvertFrom-Json
        Log "Azure account: $($a.name)  sub=$($a.id)  tenant=$($a.tenantId)  user=$($a.user.name)"
        if ($a.tenantId -ne $TenantId) {
            $w = "signed-in tenant $($a.tenantId) != expected $TenantId"
            Write-Warning $w
            $script:Warnings.Add($w)
        }
    }

    # =======================================================================
    # STEP 2 - Build the API image (README step 1).
    # =======================================================================
    Invoke-Step "Build image: ${ApiImageRepo}:$($script:TAG)" {
        az acr build -r $Registry `
            -t "${ApiImageRepo}:$($script:TAG)" -t "${ApiImageRepo}:latest" `
            --build-arg "BASE_IMAGE=$BaseImage" `
            --no-logs -f stack/Dockerfile.api . 2>&1 | Tee-Object -FilePath $script:LogFile -Append
        Assert-Native "az acr build $ApiImageRepo"
    }

    # =======================================================================
    # STEP 3 - Build the fdd-loop image (shared by BOTH jobs) (README step 1).
    # =======================================================================
    Invoke-Step "Build image: ${LoopImageRepo}:$($script:TAG)" {
        az acr build -r $Registry `
            -t "${LoopImageRepo}:$($script:TAG)" -t "${LoopImageRepo}:latest" `
            --build-arg "BASE_IMAGE=$BaseImage" `
            --no-logs -f stack/Dockerfile.fdd_loop . 2>&1 | Tee-Object -FilePath $script:LogFile -Append
        Assert-Native "az acr build $LoopImageRepo"
    }

    # =======================================================================
    # STEP 4 - Roll the API container app and wait for the new revision (README step 2).
    # =======================================================================
    Invoke-Step "Roll API -> $($script:RevName), await Healthy" {
        az containerapp update -g $ResourceGroup -n $ApiApp `
            --image "$RegistryLoginServer/${ApiImageRepo}:$($script:TAG)" `
            --revision-suffix $RevSuffix 2>&1 | Tee-Object -FilePath $script:LogFile -Append
        Assert-Native "containerapp update $ApiApp"

        Log "Waiting for $($script:RevName) to run (timeout ${ApiHealthyTimeoutMin}m)..."
        $deadline = (Get-Date).AddMinutes($ApiHealthyTimeoutMin)
        $ok = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 8
            $raw = az containerapp revision show -g $ResourceGroup -n $ApiApp --revision $script:RevName `
                --query '{p:properties.provisioningState,r:properties.runningState,h:properties.healthState}' -o json 2>>$script:LogFile
            if ($LASTEXITCODE -ne 0) { continue }   # revision may not be queryable for a moment
            $st = $raw | ConvertFrom-Json
            Log "  prov=$($st.p) running=$($st.r) health=$($st.h)"
            if ($st.p -eq 'Failed') { throw "API revision provisioning FAILED (running=$($st.r))" }
            if ($st.p -eq 'Provisioned' -and $st.r -in @('Running', 'RunningAtMaxScale', 'Scaling')) { $ok = $true; break }
        }
        if (-not $ok) { throw "API revision $($script:RevName) did not reach Running within ${ApiHealthyTimeoutMin}m" }
    }

    # =======================================================================
    # STEP 5 - Update BOTH jobs in lockstep (README step 3 + critical warning).
    # =======================================================================
    Invoke-Step "Update jobs (lockstep): $LoopJob + $SyncJob -> :$($script:TAG)" {
        foreach ($job in @($LoopJob, $SyncJob)) {
            az containerapp job update -g $ResourceGroup -n $job `
                --image "$RegistryLoginServer/${LoopImageRepo}:$($script:TAG)" 2>&1 | Tee-Object -FilePath $script:LogFile -Append
            Assert-Native "containerapp job update $job"
        }
    }

    # =======================================================================
    # STEP 6 - Smoke-start + await job executions (README step 3, optional).
    # =======================================================================
    if ($JobSmoke -eq 'none') {
        $script:Warnings.Add("jobs updated but NOT smoke-started (-JobSmoke none)")
        Write-Host "Skipping job smoke-start (-JobSmoke none)." -ForegroundColor Yellow
    }
    else {
        $jobsToStart = if ($JobSmoke -eq 'both') { @($LoopJob, $SyncJob) } else { @($LoopJob) }
        Invoke-Step "Smoke-start + await: $($jobsToStart -join ', ')" {
            foreach ($j in $jobsToStart) { Start-AndWaitJob -Job $j }
        }
    }

    # =======================================================================
    # STEP 7 - Build the frontend bundle (README step 4).
    # =======================================================================
    Invoke-Step "Build frontend (npm run build:swa)" {
        Push-Location frontend
        try {
            $env:AAD_TENANT_ID = $TenantId
            npm run build:swa 2>&1 | Tee-Object -FilePath $script:LogFile -Append
            Assert-Native "npm run build:swa"
        }
        finally { Pop-Location }
    }

    # =======================================================================
    # STEP 8 - Deploy the frontend to SWA production (README step 4).
    # =======================================================================
    Invoke-Step "Deploy frontend -> SWA $SwaApp (production)" {
        $swaToken = az staticwebapp secrets list -g $ResourceGroup -n $SwaApp `
            --query properties.apiKey -o tsv 2>>$script:LogFile
        Assert-Native "staticwebapp secrets list $SwaApp"
        if ([string]::IsNullOrWhiteSpace($swaToken)) { throw "SWA deployment token was empty" }

        Push-Location frontend
        try {
            npx -y '@azure/static-web-apps-cli@latest' deploy ./dist `
                --deployment-token $swaToken --env production 2>&1 | Tee-Object -FilePath $script:LogFile -Append
            Assert-Native "swa deploy"
        }
        finally { Pop-Location }
    }

    # =======================================================================
    # Done.
    # =======================================================================
    Write-Host ""
    Write-Host ('=' * 72) -ForegroundColor Green
    Write-Host " DEPLOY COMPLETE" -ForegroundColor Green
    Write-Host ('=' * 72) -ForegroundColor Green
    Show-Summary

    Write-Host ""
    Write-Host " Verify (README step 5):" -ForegroundColor Cyan
    Write-Host "   - API      : hit a changed endpoint, check the Network tab."
    Write-Host "   - Rules    : Faults page shows new fault_results from the smoke FDD run."
    Write-Host "   - Sync     : new point_readings rows from each site (nightly-sync window)."
    Write-Host "   - Frontend : HARD-REFRESH (Ctrl+Shift+R) or incognito; new roles need sign-out/in."
    Write-Host ""
    Write-Host " Reminder: commit your changes when ready - this script does not commit." -ForegroundColor Yellow

    Set-Location $OrigLocation
    exit 0
}
catch {
    # Any error outside a step (setup / cmdlet failures) lands here.
    $detail = $_ | Out-String
    if ($script:LogFile) {
        Stop-Deploy -Step 'setup' -Detail $detail
    }
    else {
        Write-Host "Setup failed before logging started:" -ForegroundColor Red
        Write-Host $detail -ForegroundColor Yellow
        Set-Location $OrigLocation
        exit 1
    }
}
