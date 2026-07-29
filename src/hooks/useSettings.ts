import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PartialMessage } from '@bufbuild/protobuf'
import { aiClient, settingsClient } from '@/lib/connect-client'
import type { AIProviderInput } from '@/gen/ai_pb'

export const settingsKeys = {
  all: ['settings'] as const,
  storeStatus: () => [...settingsKeys.all, 'storeStatus'] as const,
  aiProviders: () => [...settingsKeys.all, 'aiProviders'] as const,
  vendorModels: (vendor: string, baseUrl: string, providerId: string) =>
    [...settingsKeys.all, 'vendorModels', vendor, baseUrl, providerId] as const,
}

// ---------------------------------------------------------------------------
// store lock state
// ---------------------------------------------------------------------------

export function useStoreStatus() {
  return useQuery({
    queryKey: settingsKeys.storeStatus(),
    queryFn: () => settingsClient.getStoreStatus({}),
  })
}

export function useSetMasterPassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (password: string) => settingsClient.setMasterPassword({ password }),
    onSuccess: () => invalidateStoreDependents(qc),
  })
}

export function useUnlockStore() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (password: string) => settingsClient.unlockStore({ password }),
    onSuccess: () => invalidateStoreDependents(qc),
  })
}

export function useLockStore() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => settingsClient.lockStore({}),
    onSuccess: () => invalidateStoreDependents(qc),
  })
}

// Lock state changes which secrets are readable, so anything derived from the store
// has to be refetched — not just the status itself.
function invalidateStoreDependents(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: settingsKeys.storeStatus() })
  qc.invalidateQueries({ queryKey: settingsKeys.aiProviders() })
  qc.invalidateQueries({ queryKey: ['connections'] })
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

export function useAIProviders() {
  return useQuery({
    queryKey: settingsKeys.aiProviders(),
    queryFn: async () => (await aiClient.listAIProviders({})).providers,
  })
}

/**
 * Discover models for an OpenAI-wire provider. Disabled for vendors with no /models
 * endpoint, and never retried — a bad key shouldn't hammer the provider.
 */
export function useVendorModels(args: {
  vendor: string
  baseUrl?: string
  apiKey?: string
  providerId?: string
}) {
  const { vendor, baseUrl = '', apiKey, providerId = '' } = args
  const discoverable = vendor === 'ollama-cloud' || vendor === 'openai-compatible'
  return useQuery({
    queryKey: settingsKeys.vendorModels(vendor, baseUrl, providerId),
    queryFn: async () =>
      (await aiClient.listVendorModels({ vendor, baseUrl, apiKey, providerId })).models,
    enabled: discoverable && (vendor !== 'openai-compatible' || !!baseUrl),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useCreateAIProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (provider: PartialMessage<AIProviderInput>) => aiClient.createAIProvider({ provider }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.aiProviders() }),
  })
}

export function useUpdateAIProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (provider: PartialMessage<AIProviderInput>) => aiClient.updateAIProvider({ provider }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.aiProviders() }),
  })
}

export function useDeleteAIProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => aiClient.deleteAIProvider({ id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.aiProviders() }),
  })
}

export function useTestAIProvider() {
  return useMutation({
    mutationFn: (args: {
      vendor: string
      model: string
      baseUrl?: string
      apiKey?: string
      providerId?: string
    }) => aiClient.testAIProvider(args),
  })
}
