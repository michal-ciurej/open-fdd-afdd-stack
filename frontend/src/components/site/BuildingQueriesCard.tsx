"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Code, Cog, FileUp, Play, Wind } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import type { SparqlResponse } from "@/types/api";
import { PREDEFINED_QUERIES, DEFAULT_SPARQL } from "@/data/data-model-testing-queries";

/**
 * Predefined + freeform SPARQL console over the building model. Lives on the
 * admin Data Model page; the underlying query data comes from
 * data-model-testing-queries.ts.
 */
export function BuildingQueriesCard() {
  const [sparqlQuery, setSparqlQuery] = useState(DEFAULT_SPARQL);
  const [sparqlError, setSparqlError] = useState<string | null>(null);
  const [includeBacnetRefs, setIncludeBacnetRefs] = useState(false);
  const [queryCategory, setQueryCategory] = useState<"hvac" | "engineering">("hvac");
  // Test signal that increments on every settle (success or error) so E2E
  // can wait for the table to refresh without polling DOM text.
  const [sparqlFinishedGen, setSparqlFinishedGen] = useState(0);
  const sparqlFileInputRef = useRef<HTMLInputElement>(null);

  const sparqlMutation = useMutation<SparqlResponse, Error, string>({
    mutationFn: (query) =>
      apiFetch<SparqlResponse>("/data-model/sparql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }),
    onSuccess: () => setSparqlError(null),
    onError: (err: Error) => setSparqlError(err.message),
    onSettled: () => setSparqlFinishedGen((g) => g + 1),
  });

  const runPredefined = (query: string, queryWithBacnet?: string) => {
    const q = includeBacnetRefs && queryWithBacnet ? queryWithBacnet : query;
    setSparqlQuery(q);
    sparqlMutation.mutate(q);
  };

  const sparqlBindings: Record<string, string | null>[] =
    sparqlMutation.data?.bindings ?? [];
  const sparqlColumns =
    sparqlBindings.length > 0
      ? Array.from(new Set(sparqlBindings.flatMap((r) => Object.keys(r)))).sort()
      : [];

  return (
    <Card>
      <span
        data-testid="sparql-finished-generation"
        data-gen={sparqlFinishedGen}
        className="hidden"
        aria-hidden={true}
      />
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Wind className="h-5 w-5 shrink-0" />
          Building model queries
        </CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          Predefined SPARQL summaries plus a freeform query box. Results show below the
          form. AI-assisted queries land in a future revision.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Predefined */}
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setQueryCategory("hvac")}
              data-testid="category-hvac-button"
              aria-pressed={queryCategory === "hvac"}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                queryCategory === "hvac"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              HVAC
            </button>
            <button
              type="button"
              onClick={() => setQueryCategory("engineering")}
              data-testid="category-engineering-button"
              aria-pressed={queryCategory === "engineering"}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                queryCategory === "engineering"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              Engineering
            </button>
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={includeBacnetRefs}
                onChange={(e) => setIncludeBacnetRefs(e.target.checked)}
                className="h-4 w-4 rounded border-input"
                data-testid="include-bacnet-refs-checkbox"
              />
              <span>Include BACnet device + point IDs</span>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PREDEFINED_QUERIES.filter(
              (q) => (q.category ?? "hvac") === queryCategory,
            ).map(({ id, label, shortLabel, query, queryWithBacnet, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => runPredefined(query, queryWithBacnet)}
                disabled={sparqlMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60"
                title={label}
              >
                <Icon className="h-4 w-4" />
                {shortLabel}
              </button>
            ))}
            {sparqlMutation.isPending && (
              <span
                className="inline-flex items-center gap-2 text-sm text-primary"
                data-testid="sparql-running-indicator"
                role="status"
                aria-live="polite"
                aria-busy="true"
              >
                <Cog className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                Running SPARQL…
              </span>
            )}
          </div>
        </section>

        {/* Custom SPARQL */}
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Code className="h-3.5 w-3.5" />
            Custom SPARQL
          </h3>
          <input
            ref={sparqlFileInputRef}
            type="file"
            accept=".sparql,text/plain"
            className="hidden"
            data-testid="sparql-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                const text = typeof reader.result === "string" ? reader.result : "";
                setSparqlQuery(text);
              };
              reader.readAsText(file);
              e.target.value = "";
            }}
          />
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="sparql-upload-file-button"
              onClick={() => sparqlFileInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted/80"
            >
              <FileUp className="h-4 w-4" />
              Upload .sparql
            </button>
            <button
              type="button"
              data-testid="sparql-run-button"
              onClick={() => sparqlMutation.mutate(sparqlQuery)}
              disabled={sparqlMutation.isPending || !sparqlQuery.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {sparqlMutation.isPending ? (
                <Cog className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              {sparqlMutation.isPending ? "Running…" : "Run SPARQL"}
            </button>
          </div>
          <textarea
            data-testid="sparql-query-textarea"
            value={sparqlQuery}
            onChange={(e) => setSparqlQuery(e.target.value)}
            className="h-40 w-full rounded-lg border border-border/60 bg-card px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            spellCheck={false}
          />
          {sparqlError && (
            <p className="mt-2 text-sm text-destructive" data-testid="sparql-error">
              {sparqlError}
            </p>
          )}
        </section>

        {/* Results */}
        {sparqlBindings.length > 0 && sparqlColumns.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Results
            </h3>
            <div
              className="overflow-x-auto rounded-lg border border-border/60"
              data-testid="sparql-results-table"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    {sparqlColumns.map((key) => (
                      <TableHead key={key} className="font-mono text-xs">
                        {key}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sparqlBindings.map((row: Record<string, string | null>, i: number) => (
                    <TableRow key={i}>
                      {sparqlColumns.map((key) => (
                        <TableCell key={key} className="font-mono text-xs">
                          {row[key] ?? "—"}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
        {sparqlMutation.isSuccess && sparqlBindings.length === 0 && (
          <p className="text-sm text-muted-foreground">No bindings (empty result).</p>
        )}
      </CardContent>
    </Card>
  );
}
