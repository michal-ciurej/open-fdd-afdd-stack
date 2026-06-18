import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSiteContext } from "@/contexts/site-context";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllPoints, useAllEquipment, usePoints, useEquipment, useSites } from "@/hooks/use-sites";
import { useTimeseriesLatest } from "@/hooks/use-timeseries-latest";
import { PointsTree } from "@/components/site/PointsTree";
import { deletePoint, deleteEquipment, deleteSite, updatePoint, unassignPoints } from "@/lib/crud-api";
import type { Point } from "@/types/api";

function useTreeMutations(points: Point[]) {
  const queryClient = useQueryClient();
  const deletePointMutation = useMutation<{ status: string }, Error, string>({
    mutationFn: deletePoint,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["points"] });
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });
  const deleteEquipmentMutation = useMutation<{ status: string }, Error, string>({
    mutationFn: deleteEquipment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      queryClient.invalidateQueries({ queryKey: ["points"] });
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });
  const deleteSiteMutation = useMutation<{ status: string }, Error, string>({
    mutationFn: deleteSite,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      queryClient.invalidateQueries({ queryKey: ["points"] });
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });
  const setPollingMutation = useMutation({
    mutationFn: ({ pointId, polling }: { pointId: string; polling: boolean }) =>
      updatePoint(pointId, { polling }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["points"] });
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });
  // Dissolve = detach every point from the equipment (equipment_id -> null), then
  // delete the now-empty shell. Points and their history are kept; they return to
  // Unassigned so they can be re-tagged. Order matters: unassign before delete so
  // the equipment delete does not cascade the points away. The unassign is a single
  // bulk request (one UPDATE) so this stays fast even for thousands of points.
  const dissolveEquipmentMutation = useMutation<
    { status: string },
    Error,
    { equipmentId: string; pointIds: string[] }
  >({
    mutationFn: async ({ equipmentId }) => {
      await unassignPoints({ equipment_id: equipmentId });
      await deleteEquipment(equipmentId);
      return { status: "ok" };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      queryClient.invalidateQueries({ queryKey: ["points"] });
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });
  return {
    onSetPolling: (id: string, polling: boolean) =>
      setPollingMutation.mutate({ pointId: id, polling }),
    onDeletePoint: (id: string) => {
      if (window.confirm("Delete this point? Timeseries for this point will be removed.")) {
        deletePointMutation.mutate(id);
      }
    },
    onDeleteEquipment: (id: string, name: string) => {
      if (window.confirm(`Delete equipment "${name}"? This will delete all points under it.`)) {
        deleteEquipmentMutation.mutate(id);
      }
    },
    onDeleteSite: (id: string, name: string) => {
      if (window.confirm(`Delete site "${name}"? This removes all equipment, points, timeseries, and faults.`)) {
        deleteSiteMutation.mutate(id);
      }
    },
    onDissolveEquipment: (id: string, name: string) => {
      const pointIds = points.filter((p) => p.equipment_id === id).map((p) => p.id);
      if (
        window.confirm(
          `Dissolve "${name}"? Its ${pointIds.length} point(s) return to Unassigned and the empty ` +
            `equipment is removed. Points and their history are kept — use this to re-tag.`,
        )
      ) {
        dissolveEquipmentMutation.mutate({ equipmentId: id, pointIds });
      }
    },
  };
}

function AllPointsView() {
  const { data: points, isLoading } = useAllPoints();
  const treeMutations = useTreeMutations(points ?? []);
  const { data: equipment = [] } = useAllEquipment();
  const { data: sites = [] } = useSites();
  const { data: latestList = [] } = useTimeseriesLatest(undefined);
  const siteMap = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const latestByPointId = useMemo(
    () =>
      new Map(
        latestList.map((r) => [r.point_id, { value: r.value, ts: r.ts }]),
      ),
    [latestList],
  );

  if (isLoading) return <Skeleton className="h-72 w-full rounded-2xl" />;

  return (
    <PointsTree
      points={points ?? []}
      equipment={equipment}
      siteMap={siteMap}
      latestByPointId={latestByPointId}
      {...treeMutations}
    />
  );
}

function SitePointsView({ siteId }: { siteId: string }) {
  const { data: points = [], isLoading } = usePoints(siteId);
  const treeMutations = useTreeMutations(points);
  const { data: equipment = [] } = useEquipment(siteId);
  const { data: latestList = [] } = useTimeseriesLatest(siteId);
  const latestByPointId = useMemo(
    () =>
      new Map(
        latestList.map((r) => [r.point_id, { value: r.value, ts: r.ts }]),
      ),
    [latestList],
  );

  if (isLoading) return <Skeleton className="h-72 w-full rounded-2xl" />;

  return (
    <PointsTree
      points={points}
      equipment={equipment}
      latestByPointId={latestByPointId}
      {...treeMutations}
    />
  );
}

export function PointsPage() {
  const { selectedSiteId } = useSiteContext();

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Points</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Replicating Niagara's polling point situation but with auto historising. each point has a last value which comes from the latest entry into its history. Right-click a point for Poll true, Poll false, or Delete; right-click an equipment to Dissolve it (returns its points to Unassigned, keeping points + history) ready for re-tagging, or Delete it. BACnet discovery is on the Data model page.
      </p>
      {selectedSiteId ? <SitePointsView siteId={selectedSiteId} /> : <AllPointsView />}
    </div>
  );
}
