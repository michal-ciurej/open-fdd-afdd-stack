param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [ValidateSet('auto', 'http', 'tls')]
  [string]$Mode = 'auto',

  [switch]$StrictTls
)

function Get-Code {
  param(
    [string]$Url,
    [switch]$Insecure
  )

  try {
    if ($Insecure) {
      $code = & curl.exe -k -sS -o NUL -w "%{http_code}" $Url 2>$null
    } else {
      $code = & curl.exe -sS -o NUL -w "%{http_code}" $Url 2>$null
    }
    if (-not $code) { return '000' }
    return $code
  } catch {
    return '000'
  }
}

function Get-Note {
  param([string]$Code)
  switch ($Code) {
    '200' { 'reachable' }
    '301' { 'redirect' }
    '302' { 'redirect' }
    '401' { 'auth-gated but alive' }
    '403' { 'forbidden but alive' }
    '404' { 'service up, path missing' }
    '502' { 'proxy/upstream failure' }
    '000' { 'connect or TLS failure' }
    default { 'inspect manually if important' }
  }
}

$urls = @(
  @{ Check = 'HTTP root'; Url = "http://$HostName/"; Insecure = $false },
  @{ Check = 'HTTP API health'; Url = "http://$HostName:8000/health"; Insecure = $false },
  @{ Check = 'HTTP API docs'; Url = "http://$HostName:8000/docs"; Insecure = $false },
  @{ Check = 'HTTP BACnet docs'; Url = "http://$HostName:8080/docs"; Insecure = $false },
  @{ Check = 'HTTP raw frontend'; Url = "http://$HostName:5173/"; Insecure = $false },
  @{ Check = 'HTTP alternate Caddy'; Url = "http://$HostName:8880/"; Insecure = $false },
  @{ Check = 'HTTPS root'; Url = "https://$HostName/"; Insecure = (-not $StrictTls) },
  @{ Check = 'HTTPS API via Caddy'; Url = "https://$HostName/api/health"; Insecure = (-not $StrictTls) }
)

"# Open-FDD LAN probe"
""
"- Host: $HostName"
"- Mode hint: $Mode"
""
"| Check | URL | Code | Note |"
"|---|---|---:|---|"
foreach ($u in $urls) {
  $code = Get-Code -Url $u.Url -Insecure:$u.Insecure
  "| $($u.Check) | ``$($u.Url)`` | $code | $(Get-Note $code) |"
}
""
"Interpretation hints:"
"- HTTP mode often means HTTP root = 200 and direct :8000/health = 200."
"- TLS mode often means HTTPS root = 200, HTTPS /api/health = 200, HTTP root = 301/302, and direct :8000 may fail from the client."
"- 401/403 on docs usually means auth-gated, not necessarily down."
