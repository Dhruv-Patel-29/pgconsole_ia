import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { queryClient, connectionClient, aiClient } from '../lib/connect-client';
import { AUDIT_LOG_FETCH_LIMIT, LIVE_QUERY_REFETCH_INTERVAL_MS } from '../lib/constants';
import type { ColumnMetadata } from '../components/sql-editor/hooks/useEditorTabs';
import { useSelectedDatabase } from '../lib/database-context';

// Query keys
export const queryKeys = {
  all: ['query'] as const,
  schemas: (connectionId: string, database = '') => [...queryKeys.all, 'schemas', connectionId, database] as const,
  tables: (connectionId: string, schema: string, database = '') => [...queryKeys.all, 'tables', connectionId, schema, database] as const,
  columns: (connectionId: string, schema: string, table: string, database = '') => [...queryKeys.all, 'columns', connectionId, schema, table, database] as const,
  tableInfo: (connectionId: string, schema: string, table: string, database = '') => [...queryKeys.all, 'tableInfo', connectionId, schema, table, database] as const,
  indexes: (connectionId: string, schema: string, table: string, database = '') => [...queryKeys.all, 'indexes', connectionId, schema, table, database] as const,
  constraints: (connectionId: string, schema: string, table: string, database = '') => [...queryKeys.all, 'constraints', connectionId, schema, table, database] as const,
  triggers: (connectionId: string, schema: string, table: string, database = '') => [...queryKeys.all, 'triggers', connectionId, schema, table, database] as const,
  policies: (connectionId: string, schema: string, table: string, database = '') => [...queryKeys.all, 'policies', connectionId, schema, table, database] as const,
  grants: (connectionId: string, schema: string, table: string, database = '') => [...queryKeys.all, 'grants', connectionId, schema, table, database] as const,
  materializedViews: (connectionId: string, schema: string, database = '') => [...queryKeys.all, 'materializedViews', connectionId, schema, database] as const,
  functions: (connectionId: string, schema: string, database = '') => [...queryKeys.all, 'functions', connectionId, schema, database] as const,
  procedures: (connectionId: string, schema: string, database = '') => [...queryKeys.all, 'procedures', connectionId, schema, database] as const,
  functionInfo: (connectionId: string, schema: string, name: string, args?: string, database = '') => [...queryKeys.all, 'functionInfo', connectionId, schema, name, args, database] as const,
  functionDependencies: (connectionId: string, schema: string, name: string, args?: string, database = '') => [...queryKeys.all, 'functionDependencies', connectionId, schema, name, args, database] as const,
  processes: (connectionId: string, database = '') => [...queryKeys.all, 'processes', connectionId, database] as const,
  auditLog: (connectionId: string, database = '') => [...queryKeys.all, 'auditLog', connectionId, database] as const,
  systemAuditLog: () => [...queryKeys.all, 'systemAuditLog'] as const,
};

export function invalidateSchemaQueries(qc: QueryClient, connectionId: string) {
  qc.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey
      return Array.isArray(key) && key[0] === 'query' && key[1] !== 'processes' && key.includes(connectionId)
    },
  })
}

export const connectionKeys = {
  all: ['connections'] as const,
  list: () => [...connectionKeys.all, 'list'] as const,
  detail: (id: string) => [...connectionKeys.all, 'detail', id] as const,
};

// Get schemas for a connection
export function useSchemas(connectionId: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.schemas(connectionId, database),
    queryFn: async () => {
      const response = await queryClient.getSchemas({ connectionId, database });
      return response.schemas;
    },
    enabled: enabled && !!connectionId,
  });
}

// Get tables for a schema
export function useTables(connectionId: string, schema: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.tables(connectionId, schema, database),
    queryFn: async () => {
      const response = await queryClient.getTables({ connectionId, schema, database });
      return response.tables;
    },
    enabled: enabled && !!connectionId && !!schema,
  });
}

// Get columns for a table
export function useColumns(connectionId: string, schema: string, table: string) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.columns(connectionId, schema, table, database),
    queryFn: async () => {
      const response = await queryClient.getColumns({ connectionId, schema, table, database });
      return response.columns;
    },
    enabled: !!connectionId && !!schema && !!table,
  });
}

// Get table metadata (owner, size, encoding, collation, etc.)
export function useTableInfo(connectionId: string, schema: string, table: string) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.tableInfo(connectionId, schema, table, database),
    queryFn: async () => {
      const response = await queryClient.getTableInfo({ connectionId, schema, table, database });
      return response.metadata;
    },
    enabled: !!connectionId && !!schema && !!table,
  });
}

// Get indexes for a table
export function useIndexes(connectionId: string, schema: string, table: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.indexes(connectionId, schema, table, database),
    queryFn: async () => {
      const response = await queryClient.getIndexes({ connectionId, schema, table, database });
      return response.indexes;
    },
    enabled: enabled && !!connectionId && !!schema && !!table,
  });
}

// Get constraints for a table (includes reverse FKs in referencedBy)
export function useConstraints(connectionId: string, schema: string, table: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.constraints(connectionId, schema, table, database),
    queryFn: async () => {
      const response = await queryClient.getConstraints({ connectionId, schema, table, database });
      return { constraints: response.constraints, referencedBy: response.referencedBy };
    },
    enabled: enabled && !!connectionId && !!schema && !!table,
  });
}

// Get triggers for a table
export function useTriggers(connectionId: string, schema: string, table: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.triggers(connectionId, schema, table, database),
    queryFn: async () => {
      const response = await queryClient.getTriggers({ connectionId, schema, table, database });
      return response.triggers;
    },
    enabled: enabled && !!connectionId && !!schema && !!table,
  });
}

// Get policies for a table
export function usePolicies(connectionId: string, schema: string, table: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.policies(connectionId, schema, table, database),
    queryFn: async () => {
      const response = await queryClient.getPolicies({ connectionId, schema, table, database });
      return response.policies;
    },
    enabled: enabled && !!connectionId && !!schema && !!table,
  });
}

// Get grants for a table
export function useGrants(connectionId: string, schema: string, table: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.grants(connectionId, schema, table, database),
    queryFn: async () => {
      const response = await queryClient.getGrants({ connectionId, schema, table, database });
      return response.grants;
    },
    enabled: enabled && !!connectionId && !!schema && !!table,
  });
}

// Get materialized views for a schema
export function useMaterializedViews(connectionId: string, schema: string) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.materializedViews(connectionId, schema, database),
    queryFn: async () => {
      const response = await queryClient.getMaterializedViews({ connectionId, schema, database });
      return response.materializedViews;
    },
    enabled: !!connectionId && !!schema,
  });
}

// Get functions for a schema
export function useFunctions(connectionId: string, schema: string) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.functions(connectionId, schema, database),
    queryFn: async () => {
      const response = await queryClient.getFunctions({ connectionId, schema, database });
      return response.functions;
    },
    enabled: !!connectionId && !!schema,
  });
}

// Get procedures for a schema
export function useProcedures(connectionId: string, schema: string) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.procedures(connectionId, schema, database),
    queryFn: async () => {
      const response = await queryClient.getProcedures({ connectionId, schema, database });
      return response.procedures;
    },
    enabled: !!connectionId && !!schema,
  });
}

// Get function/procedure info (detailed metadata + definition)
export function useFunctionInfo(connectionId: string, schema: string, name: string, args?: string) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.functionInfo(connectionId, schema, name, args, database),
    queryFn: async () => {
      const response = await queryClient.getFunctionInfo({ connectionId, schema, name, arguments: args, database });
      return response.metadata;
    },
    enabled: !!connectionId && !!schema && !!name,
  });
}

// Get function/procedure dependencies
export function useFunctionDependencies(connectionId: string, schema: string, name: string, args?: string) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.functionDependencies(connectionId, schema, name, args, database),
    queryFn: async () => {
      const response = await queryClient.getFunctionDependencies({ connectionId, schema, name, arguments: args, database });
      return response.dependencies;
    },
    enabled: !!connectionId && !!schema && !!name,
  });
}

// Execute SQL (streaming - first message has PID, last has results)
export function useExecuteSQL() {
  const database = useSelectedDatabase();
  return useMutation({
    mutationFn: async ({
      connectionId,
      sql,
      queryId,
      searchPath,
      onPid,
    }: {
      connectionId: string
      sql: string
      queryId?: string
      searchPath?: string  // PostgreSQL search_path (e.g., "myschema, public")
      onPid?: (pid: number) => void
    }) => {
      let lastResponse: {
        columns: ColumnMetadata[]
        rows: Record<string, unknown>[]
        rowCount: number
        executionTime: number
        error: string
        backendPid: number
      } | null = null;

      // Iterate over the stream
      for await (const response of queryClient.executeSQL({ connectionId, sql, queryId, searchPath, database })) {
        // First message contains just the PID
        if (response.backendPid && onPid && response.columns.length === 0 && !response.error) {
          onPid(response.backendPid);
        }

        // Map the response
        const mappedRows = response.rows.map(row => {
          const obj: Record<string, unknown> = {};
          response.columns.forEach((col, i) => {
            obj[col.name] = row.values[i];
          });
          return obj;
        });

        lastResponse = {
          columns: response.columns.map(col => ({
            name: col.name,
            type: col.type,
            tableName: col.tableName,
            schemaName: col.schemaName,
            isPrimaryKey: col.isPrimaryKey,
            isNullable: col.isNullable,
            hasDefault: col.hasDefault,
          })),
          rows: mappedRows,
          rowCount: response.rowCount,
          executionTime: response.executionTimeMs,
          error: response.error,
          backendPid: response.backendPid,
        };
      }

      if (!lastResponse) {
        throw new Error('No response received from server');
      }

      return lastResponse;
    },
  });
}

// Cancel a running query
export function useCancelQuery() {
  const database = useSelectedDatabase();
  return useMutation({
    mutationFn: async ({ connectionId, queryId }: { connectionId: string; queryId: string }) => {
      const response = await queryClient.cancelQuery({ connectionId, queryId, database });
      return {
        cancelled: response.cancelled,
        error: response.error,
      };
    },
  });
}

// List connections from config
export function useConnections() {
  return useQuery({
    queryKey: connectionKeys.list(),
    queryFn: async () => {
      const response = await connectionClient.listConnections({});
      return response.connections;
    },
  });
}

// Get active processes for a connection
export function useActiveProcesses(connectionId: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.processes(connectionId, database),
    queryFn: async () => {
      const response = await queryClient.getActiveSessions({ connectionId, database });
      if (response.error) throw new Error(response.error);
      return response.sessions;
    },
    enabled: enabled && !!connectionId,
    refetchInterval: LIVE_QUERY_REFETCH_INTERVAL_MS,
  });
}

// Terminate a process
export function useTerminateProcess() {
  const database = useSelectedDatabase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, pid }: { connectionId: string; pid: number }) => {
      const response = await queryClient.terminateSession({ connectionId, pid, database });
      if (response.error) throw new Error(response.error);
      return response.success;
    },
    onSuccess: (_, { connectionId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.processes(connectionId, database) });
    },
  });
}

export function useAuditLogEntries(connectionId: string, enabled = true) {
  const database = useSelectedDatabase();
  return useQuery({
    queryKey: queryKeys.auditLog(connectionId, database),
    queryFn: async () => {
      const response = await queryClient.getAuditLogEntries({ connectionId, limit: AUDIT_LOG_FETCH_LIMIT, database });
      return response.entries;
    },
    enabled: enabled && !!connectionId,
    refetchInterval: LIVE_QUERY_REFETCH_INTERVAL_MS,
  });
}

// System-level audit entries (auth.login / auth.logout). Owner-gated server-side, so
// only enable the query for instance owners.
export function useSystemAuditLogEntries(enabled = true) {
  return useQuery({
    queryKey: queryKeys.systemAuditLog(),
    queryFn: async () => {
      const response = await queryClient.getSystemAuditLogEntries({ limit: AUDIT_LOG_FETCH_LIMIT });
      return response.entries;
    },
    enabled,
    refetchInterval: LIVE_QUERY_REFETCH_INTERVAL_MS,
  });
}

// Refresh AI schema cache
export function useRefreshSchemaCache() {
  const database = useSelectedDatabase();
  return useMutation({
    mutationFn: async ({ connectionId, schemas }: { connectionId: string; schemas?: string[] }) => {
      const response = await aiClient.refreshSchemaCache({
        connectionId,
        schemas: schemas || [],
        // The AI schema cache is keyed by database, so refresh the one in view.
        database,
      });
      if (response.error) throw new Error(response.error);
      return response.success;
    },
  });
}

// Test connection health (returns success/error/latency)
export function useConnectionHealth(connectionId: string, enabled = true) {
  return useQuery({
    queryKey: [...connectionKeys.all, 'health', connectionId],
    queryFn: async () => {
      const response = await connectionClient.testConnection({ id: connectionId });
      return {
        success: response.success,
        error: response.error,
        latencyMs: response.latencyMs,
      };
    },
    enabled: enabled && !!connectionId,
    staleTime: 60000, // Cache for 60 seconds
    retry: 1, // Only retry once on failure
  });
}
