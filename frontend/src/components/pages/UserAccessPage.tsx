import { Fragment, useMemo, useState } from "react";
import {
  Users,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminUsers, useSiteGrant } from "@/hooks/use-admin-users";
import { useSites } from "@/hooks/use-sites";
import type { AdminUser, Site } from "@/types/api";
import { cn, timeAgo } from "@/lib/utils";

function roleVariant(role: string): BadgeProps["variant"] {
  switch (role) {
    case "admin":
      return "default";
    case "engineer":
      return "secondary";
    default:
      return "outline";
  }
}

/** Per-user panel of toggleable site chips. Each toggle is an immediate grant/revoke. */
function SiteAccessManager({ user, sites }: { user: AdminUser; sites: Site[] }) {
  const grant = useSiteGrant();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const granted = useMemo(() => new Set(user.site_ids), [user.site_ids]);

  if (user.roles.includes("admin")) {
    return (
      <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        Full Admin privilege: sees everything.
      </div>
    );
  }
  if (sites.length === 0) {
    return (
      <p className="py-1 text-sm text-muted-foreground">No sites configured yet.</p>
    );
  }

  function toggle(site: Site) {
    if (pending.has(site.id)) return;
    const nextGranted = !granted.has(site.id);
    setPending((p) => new Set(p).add(site.id));
    grant.mutate(
      { oid: user.oid, siteId: site.id, grant: nextGranted },
      {
        onSettled: () =>
          setPending((p) => {
            const n = new Set(p);
            n.delete(site.id);
            return n;
          }),
      },
    );
  }

  return (
    <div className="flex flex-wrap gap-2 py-1">
      {sites.map((site) => {
        const on = granted.has(site.id);
        const busy = pending.has(site.id);
        return (
          <button
            key={site.id}
            type="button"
            onClick={() => toggle(site)}
            disabled={busy}
            aria-pressed={on}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              on
                ? "border-success/30 bg-success/10 text-success hover:bg-success/15"
                : "border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              busy && "cursor-wait opacity-50",
            )}
          >
            {on ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Building2 className="h-3.5 w-3.5" />
            )}
            {site.name}
          </button>
        );
      })}
    </div>
  );
}

export function UserAccessPage() {
  const usersQuery = useAdminUsers();
  const sitesQuery = useSites();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const users = usersQuery.data ?? [];
  const sites = sitesQuery.data ?? [];

  function toggleRow(oid: string) {
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(oid)) n.delete(oid);
      else n.add(oid);
      return n;
    });
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">User access</h1>
        <Badge variant="outline">
          {users.length} user{users.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" />
            Users & site access
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Everyone who has signed in at least once. The role tier
            (admin/engineer/user) is managed in Entra; here you control which
            sites each engineer/user can see. Expand a row to grant or revoke
            sites — changes apply immediately.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {usersQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-48 w-full rounded-xl" />
            </div>
          ) : usersQuery.isError ? (
            <div className="px-6 py-6 text-sm text-destructive">
              Failed to load users: {usersQuery.error.message}
            </div>
          ) : users.length === 0 ? (
            <div className="px-6 py-6 text-sm text-muted-foreground">
              No users yet. Users appear here after their first sign-in.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="text-right">Sites</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const open = expanded.has(u.oid);
                  const isAdmin = u.roles.includes("admin");
                  return (
                    <Fragment key={u.oid}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => toggleRow(u.oid)}
                      >
                        <TableCell className="text-muted-foreground">
                          {open ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">
                            {u.email ?? "(no email)"}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {u.oid}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {u.roles.length === 0 ? (
                              <Badge variant="outline">none</Badge>
                            ) : (
                              u.roles.map((r) => (
                                <Badge key={r} variant={roleVariant(r)}>
                                  {r}
                                </Badge>
                              ))
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {timeAgo(u.last_seen)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {isAdmin ? (
                            <span className="text-muted-foreground">all</span>
                          ) : (
                            u.site_ids.length
                          )}
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell />
                          <TableCell colSpan={4} className="pt-0">
                            <SiteAccessManager user={u} sites={sites} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
