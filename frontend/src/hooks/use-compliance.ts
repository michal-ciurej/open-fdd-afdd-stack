import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  ComplianceEquipmentAnalyticsResponse,
  ComplianceSummaryResponse,
} from "@/types/api";

export function useComplianceSummary(siteId: string | null) {
  return useQuery<ComplianceSummaryResponse>({
    queryKey: ["compliance", "summary", siteId ?? "all"],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (siteId) sp.set("site_id", siteId);
      const q = sp.toString();
      return apiFetch<ComplianceSummaryResponse>(
        `/compliance/summary${q ? `?${q}` : ""}`,
      );
    },
    staleTime: 30 * 1000,
  });
}

export function useComplianceEquipmentAnalytics(
  siteId: string | null,
  startIso: string,
  endIso: string,
) {
  return useQuery<ComplianceEquipmentAnalyticsResponse>({
    queryKey: ["compliance", "equipment-analytics", siteId ?? "all", startIso, endIso],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (siteId) sp.set("site_id", siteId);
      sp.set("start", startIso);
      sp.set("end", endIso);
      return apiFetch<ComplianceEquipmentAnalyticsResponse>(
        `/compliance/equipment-analytics?${sp.toString()}`,
      );
    },
    staleTime: 60 * 1000,
  });
}
