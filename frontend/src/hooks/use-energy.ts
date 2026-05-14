import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createEnergyOpportunity,
  deleteEnergyOpportunity,
  getEquipmentEnergyProfile,
  getSiteEnergyRates,
  listEnergyOpportunities,
  previewEnergyOpportunity,
  recomputeEnergyOpportunity,
  updateEnergyOpportunity,
  updateEquipmentEnergyProfile,
  updateSiteEnergyRates,
} from "@/lib/crud-api";
import type {
  EnergyOpportunity,
  EnergyOpportunityCreateBody,
  EnergyOpportunityPatchBody,
  EquipmentEnergyProfile,
  EquipmentEnergyProfileUpdateBody,
  SiteEnergyRates,
  SiteEnergyRatesUpdateBody,
} from "@/types/api";

const opportunitiesKey = (scope: { equipmentId?: string; siteId?: string }) =>
  scope.equipmentId
    ? (["energy-opportunities", "equipment", scope.equipmentId] as const)
    : (["energy-opportunities", "site", scope.siteId] as const);

export function useSiteEnergyRates(siteId: string | undefined) {
  return useQuery<SiteEnergyRates>({
    queryKey: ["site-energy-rates", siteId],
    queryFn: () => getSiteEnergyRates(siteId as string),
    enabled: !!siteId,
  });
}

export function useUpdateSiteEnergyRates(siteId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SiteEnergyRatesUpdateBody) =>
      updateSiteEnergyRates(siteId as string, body),
    onSuccess: (data) => {
      queryClient.setQueryData(["site-energy-rates", siteId], data);
    },
  });
}

export function useEquipmentEnergyProfile(equipmentId: string | undefined) {
  return useQuery<EquipmentEnergyProfile>({
    queryKey: ["equipment-energy-profile", equipmentId],
    queryFn: () => getEquipmentEnergyProfile(equipmentId as string),
    enabled: !!equipmentId,
  });
}

export function useUpdateEquipmentEnergyProfile(equipmentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EquipmentEnergyProfileUpdateBody) =>
      updateEquipmentEnergyProfile(equipmentId as string, body),
    onSuccess: (data) => {
      queryClient.setQueryData(["equipment-energy-profile", equipmentId], data);
    },
  });
}

export function useEquipmentOpportunities(equipmentId: string | undefined) {
  return useQuery<EnergyOpportunity[]>({
    queryKey: opportunitiesKey({ equipmentId }),
    queryFn: () => listEnergyOpportunities({ equipmentId: equipmentId as string }),
    enabled: !!equipmentId,
  });
}

export function useSiteOpportunities(siteId: string | undefined) {
  return useQuery<EnergyOpportunity[]>({
    queryKey: opportunitiesKey({ siteId }),
    queryFn: () => listEnergyOpportunities({ siteId: siteId as string }),
    enabled: !!siteId,
  });
}

export function useCreateOpportunity(equipmentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EnergyOpportunityCreateBody) => createEnergyOpportunity(body),
    onSuccess: () => {
      if (equipmentId) {
        queryClient.invalidateQueries({
          queryKey: opportunitiesKey({ equipmentId }),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["energy-opportunities", "site"] });
    },
  });
}

export function useUpdateOpportunity(equipmentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: EnergyOpportunityPatchBody }) =>
      updateEnergyOpportunity(id, body),
    onSuccess: () => {
      if (equipmentId) {
        queryClient.invalidateQueries({
          queryKey: opportunitiesKey({ equipmentId }),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["energy-opportunities", "site"] });
    },
  });
}

export function useDeleteOpportunity(equipmentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteEnergyOpportunity(id),
    onSuccess: () => {
      if (equipmentId) {
        queryClient.invalidateQueries({
          queryKey: opportunitiesKey({ equipmentId }),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["energy-opportunities", "site"] });
    },
  });
}

export function useRecomputeOpportunity(equipmentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => recomputeEnergyOpportunity(id),
    onSuccess: () => {
      if (equipmentId) {
        queryClient.invalidateQueries({
          queryKey: opportunitiesKey({ equipmentId }),
        });
      }
    },
  });
}

export function usePreviewOpportunity() {
  return useMutation({ mutationFn: previewEnergyOpportunity });
}
