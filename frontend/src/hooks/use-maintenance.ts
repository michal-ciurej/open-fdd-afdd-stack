import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  MaintenanceEvent,
  MaintenanceEventCreateBody,
  MaintenanceOverviewResponse,
} from "@/types/api";

export function useMaintenanceOverview(periodDays = 30) {
  return useQuery<MaintenanceOverviewResponse>({
    queryKey: ["maintenance", "overview", periodDays],
    queryFn: () =>
      apiFetch<MaintenanceOverviewResponse>(
        `/maintenance/equipment?period_days=${periodDays}`,
      ),
    staleTime: 30 * 1000,
  });
}

export function useEquipmentMaintenanceEvents(equipmentId: string | undefined) {
  return useQuery<MaintenanceEvent[]>({
    queryKey: ["maintenance", "events", equipmentId ?? ""],
    queryFn: () =>
      apiFetch<MaintenanceEvent[]>(
        `/maintenance/events?equipment_id=${equipmentId}`,
      ),
    enabled: !!equipmentId,
  });
}

export function useLogMaintenanceEvent() {
  const queryClient = useQueryClient();
  return useMutation<MaintenanceEvent, Error, MaintenanceEventCreateBody>({
    mutationFn: (body) =>
      apiFetch<MaintenanceEvent>("/maintenance/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["maintenance"] });
    },
  });
}
