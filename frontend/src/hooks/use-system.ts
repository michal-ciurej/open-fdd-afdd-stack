import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  Capabilities,
  SystemHostResponse,
  SystemHostSeriesResponse,
  SystemContainersResponse,
  SystemContainersSeriesResponse,
  SystemDiskResponse,
} from "@/types/api";

/** GET /capabilities - version + feature flags (incl. ai_available for AI tagging). */
export function useCapabilities() {
  return useQuery<Capabilities>({
    queryKey: ["capabilities"],
    queryFn: () => apiFetch<Capabilities>("/capabilities"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSystemHost() {
  return useQuery<SystemHostResponse>({
    queryKey: ["system", "host"],
    queryFn: () => apiFetch<SystemHostResponse>("/analytics/system/host"),
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useSystemHostSeries(fromIso: string, toIso: string) {
  return useQuery<SystemHostSeriesResponse>({
    queryKey: ["system", "host", "series", fromIso, toIso],
    queryFn: () =>
      apiFetch<SystemHostSeriesResponse>(
        `/analytics/system/host/series?from_ts=${encodeURIComponent(fromIso)}&to_ts=${encodeURIComponent(toIso)}`,
      ),
    enabled: !!fromIso && !!toIso,
    staleTime: 60 * 1000,
  });
}

export function useSystemContainers() {
  return useQuery<SystemContainersResponse>({
    queryKey: ["system", "containers"],
    queryFn: () => apiFetch<SystemContainersResponse>("/analytics/system/containers"),
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useSystemContainersSeries(fromIso: string, toIso: string) {
  return useQuery<SystemContainersSeriesResponse>({
    queryKey: ["system", "containers", "series", fromIso, toIso],
    queryFn: () =>
      apiFetch<SystemContainersSeriesResponse>(
        `/analytics/system/containers/series?from_ts=${encodeURIComponent(fromIso)}&to_ts=${encodeURIComponent(toIso)}`,
      ),
    enabled: !!fromIso && !!toIso,
    staleTime: 60 * 1000,
  });
}

export function useSystemDisk() {
  return useQuery<SystemDiskResponse>({
    queryKey: ["system", "disk"],
    queryFn: () => apiFetch<SystemDiskResponse>("/analytics/system/disk"),
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
}
