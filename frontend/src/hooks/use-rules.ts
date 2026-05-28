import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface RuleMeta {
  filename: string;
  name: string | null;
  equipment_types: string[];
  category: string | null;
  severity: string | null;
  description: string | null;
}

export interface RulesListResponse {
  rules_dir: string;
  files: string[];
  rules?: RuleMeta[];
  error?: string;
}

export function useRulesList() {
  return useQuery<RulesListResponse>({
    queryKey: ["rules", "list"],
    queryFn: () => apiFetch<RulesListResponse>("/rules"),
    staleTime: 60 * 1000,
  });
}
