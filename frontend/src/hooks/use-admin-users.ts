import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { AdminUser } from "@/types/api";

const USERS_KEY = ["admin", "users"] as const;

export function useAdminUsers() {
  return useQuery<AdminUser[]>({
    queryKey: USERS_KEY,
    queryFn: () => apiFetch<AdminUser[]>("/admin/users"),
  });
}

interface SiteGrantVars {
  oid: string;
  siteId: string;
}

/** Grant (PUT) or revoke (DELETE) one user's access to one site. */
export function useSiteGrant() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, SiteGrantVars & { grant: boolean }>({
    mutationFn: ({ oid, siteId, grant }) =>
      apiFetch<void>(
        `/admin/users/${encodeURIComponent(oid)}/sites/${encodeURIComponent(siteId)}`,
        { method: grant ? "PUT" : "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}
