import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PartialMessage } from '@bufbuild/protobuf'
import { connectionClient } from '@/lib/connect-client'
import { connectionKeys } from '@/hooks/useQuery'
import type { ConnectionInput, ConnectionGroup } from '@/gen/connection_pb'

export const connectionAdminKeys = {
  groups: () => [...connectionKeys.all, 'groups'] as const,
  databases: (connectionId: string) => [...connectionKeys.all, 'databases', connectionId] as const,
}

/**
 * Databases available on the connection's server. Returns just the configured database
 * unless the connection opted into all_databases, so this is safe to call unconditionally.
 */
export function useDatabases(connectionId: string, enabled = true) {
  return useQuery({
    queryKey: connectionAdminKeys.databases(connectionId),
    queryFn: async () => (await connectionClient.listDatabases({ connectionId })).databases,
    enabled: enabled && !!connectionId,
    staleTime: 60 * 1000,
  })
}

export function useConnectionGroups(enabled = true) {
  return useQuery({
    queryKey: connectionAdminKeys.groups(),
    queryFn: async () => (await connectionClient.listConnectionGroups({})).groups,
    enabled,
    // Group management is owner-only; a non-owner gets PermissionDenied, which is not
    // worth retrying.
    retry: false,
  })
}

function useInvalidateConnections() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: connectionKeys.all })
  }
}

export function useCreateConnection() {
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: (connection: PartialMessage<ConnectionInput>) =>
      connectionClient.createConnection({ connection }),
    onSuccess: invalidate,
  })
}

export function useUpdateConnection() {
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: (connection: PartialMessage<ConnectionInput>) =>
      connectionClient.updateConnection({ connection }),
    onSuccess: invalidate,
  })
}

export function useDeleteConnection() {
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: (id: string) => connectionClient.deleteConnection({ id }),
    onSuccess: invalidate,
  })
}

/** Test unsaved form input. Pass `id` to reuse a saved connection's stored password. */
export function useTestConnectionParams() {
  return useMutation({
    mutationFn: (args: {
      host: string
      port: number
      database: string
      username: string
      password?: string
      sslMode?: string
      id?: string
    }) => connectionClient.testConnectionParams(args),
  })
}

export function useUpsertConnectionGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (group: PartialMessage<ConnectionGroup>) =>
      connectionClient.upsertConnectionGroup({ group }),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionAdminKeys.groups() }),
  })
}

export function useDeleteConnectionGroup() {
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: (id: string) => connectionClient.deleteConnectionGroup({ id }),
    // Connections in the group become ungrouped, so the connection list changes too.
    onSuccess: invalidate,
  })
}
