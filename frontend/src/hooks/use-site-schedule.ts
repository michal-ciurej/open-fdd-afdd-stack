import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSiteSchedule, updateSiteSchedule } from "@/lib/crud-api";
import type { SiteScheduleBody } from "@/types/api";

const scheduleKey = (siteId: string | undefined) =>
  ["site-schedule", siteId] as const;

export function useSiteSchedule(siteId: string | undefined) {
  return useQuery<SiteScheduleBody>({
    queryKey: scheduleKey(siteId),
    queryFn: () => getSiteSchedule(siteId as string),
    enabled: !!siteId,
  });
}

export function useUpdateSiteSchedule(siteId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SiteScheduleBody) =>
      updateSiteSchedule(siteId as string, body),
    onSuccess: (data) => {
      queryClient.setQueryData(scheduleKey(siteId), data);
    },
  });
}
