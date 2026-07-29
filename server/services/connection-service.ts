import { ConnectError, Code } from "@connectrpc/connect"
import type { ServiceImpl } from "@connectrpc/connect"
import { ConnectionService } from "../../src/gen/connection_connect"
import { getConnections, getConnectionById, getLabels } from "../lib/config"
import type { ConnectionConfig } from "../lib/config"
import { createClient, buildConnectionDetails } from "../lib/db"
import { tryGetConnectionInfo, testAndCacheConnection, clearConnectionCache } from "../lib/connection-cache"
import { clearSchemaCache } from "../lib/schema-cache"
import { getUserFromContext } from "../lib/rpc-context"
import {
  getAccessibleConnectionIds,
  getUserPermissions,
  requireAnyPermission,
  requireInstanceAdmin,
  type Permission,
} from "../lib/iam"
import {
  createStoredConnection,
  updateStoredConnection,
  deleteStoredConnection,
  getStoredConnection,
  listStoredConnectionGroups,
  upsertStoredConnectionGroup,
  deleteStoredConnectionGroup,
} from "../lib/store"
import { SecretsLockedError } from "../lib/secrets"
import { auditConfigChange } from "../lib/audit"
import type { ConnectionInput as ConnectionInputMessage } from "../../src/gen/connection_pb"

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const VALID_SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

function toConnectionResponse(conn: ConnectionConfig, userPermissions: Set<Permission>) {
  const allLabels = getLabels()
  const connectionLabelIds = conn.labels || []
  const hydratedLabels = connectionLabelIds
    .map(labelId => allLabels.find(l => l.id === labelId))
    .filter((l): l is NonNullable<typeof l> => l !== undefined)

  const info = tryGetConnectionInfo(conn.id)

  return {
    id: conn.id,
    name: conn.name,
    description: '',
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.username,
    hasPassword: !!conn.password,
    sslMode: conn.ssl_mode || 'prefer',
    labels: hydratedLabels,
    version: info.version || '',
    permissions: Array.from(userPermissions),
    color: conn.color || '',
    source: conn.source ?? 'toml',
    groupId: conn.group_id ?? '',
    allDatabases: conn.all_databases ?? false,
    sslCa: conn.ssl_ca ?? '',
    sslCert: conn.ssl_cert ?? '',
    sslKey: conn.ssl_key ?? '',
    lockTimeout: conn.lock_timeout ?? '',
    statementTimeout: conn.statement_timeout ?? '',
  }
}

/**
 * Validate connection form input. Mirrors the TOML validation in config.ts so a
 * connection created through the UI is held to the same rules as one written to the file.
 */
function validateConnectionInput(input: ConnectionInputMessage | undefined) {
  if (!input) {
    throw new ConnectError('connection is required', Code.InvalidArgument)
  }
  const id = input.id?.trim()
  if (!id) throw new ConnectError('id is required', Code.InvalidArgument)
  if (!ID_RE.test(id)) {
    throw new ConnectError(
      'id must start with a letter or digit and contain only letters, digits, dots, dashes, and underscores',
      Code.InvalidArgument
    )
  }

  const host = input.host?.trim()
  if (!host) throw new ConnectError('host is required', Code.InvalidArgument)

  const port = input.port || 5432
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectError('port must be an integer between 1 and 65535', Code.InvalidArgument)
  }

  const database = input.database?.trim()
  if (!database) throw new ConnectError('database is required', Code.InvalidArgument)

  const username = input.username?.trim()
  if (!username) throw new ConnectError('username is required', Code.InvalidArgument)

  const sslMode = input.sslMode?.trim() || 'prefer'
  if (!VALID_SSL_MODES.includes(sslMode)) {
    throw new ConnectError(
      `Invalid ssl_mode: ${sslMode}. Must be one of: ${VALID_SSL_MODES.join(', ')}`,
      Code.InvalidArgument
    )
  }

  return {
    id,
    name: input.name?.trim() || id,
    host,
    port,
    database,
    username,
    password: input.password,
    ssl_mode: sslMode,
    ssl_ca: input.sslCa?.trim() || undefined,
    ssl_cert: input.sslCert?.trim() || undefined,
    ssl_key: input.sslKey?.trim() || undefined,
    lock_timeout: input.lockTimeout?.trim() || undefined,
    statement_timeout: input.statementTimeout?.trim() || undefined,
    color: input.color?.trim() || undefined,
    group_id: input.groupId?.trim() || undefined,
    labels: input.labels ?? [],
    all_databases: input.allDatabases ?? false,
  }
}

/** Reject mutations aimed at a TOML-defined connection, which the UI must not edit. */
function requireStoreBacked(id: string): ConnectionConfig {
  const existing = getConnectionById(id)
  if (!existing) {
    throw new ConnectError('Connection not found', Code.NotFound)
  }
  if (existing.source !== 'store') {
    throw new ConnectError(
      `Connection "${id}" is defined in pgconsole.toml and can only be changed there`,
      Code.FailedPrecondition
    )
  }
  return existing
}

function withStoreErrors<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof SecretsLockedError) {
      throw new ConnectError(err.message, Code.FailedPrecondition)
    }
    throw err
  }
}

export const connectionServiceHandlers: ServiceImpl<typeof ConnectionService> = {
  async listConnections(_req, context) {
    const user = await getUserFromContext(context.values)
    const connections = getConnections()

    // If no user (shouldn't happen if auth is enabled), return empty
    if (!user) {
      return { connections: [] }
    }

    // Filter connections by IAM permissions
    const allIds = connections.map(c => c.id)
    const accessibleIds = new Set(getAccessibleConnectionIds(user.email, allIds))

    const filtered = connections.filter(c => accessibleIds.has(c.id))

    return {
      connections: filtered.map((c) => {
        const perms = getUserPermissions(user.email, c.id)
        return toConnectionResponse(c, perms)
      }),
    }
  },

  async getConnection(req, context) {
    if (!req.id) {
      throw new ConnectError('id is required', Code.InvalidArgument)
    }

    const conn = getConnectionById(req.id)
    if (!conn) {
      throw new ConnectError('Connection not found', Code.NotFound)
    }

    const user = await getUserFromContext(context.values)
    const perms = requireAnyPermission(user, req.id)

    return { connection: toConnectionResponse(conn, perms) }
  },

  async testConnection(req, context) {
    if (!req.id) {
      throw new ConnectError('id is required', Code.InvalidArgument)
    }

    const conn = getConnectionById(req.id)
    if (!conn) {
      throw new ConnectError('Connection not found', Code.NotFound)
    }

    const user = await getUserFromContext(context.values)
    requireAnyPermission(user, req.id)

    const start = Date.now()
    const client = createClient({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      username: conn.username,
      password: conn.password,
      sslMode: conn.ssl_mode || 'prefer',
    }, user?.email)

    try {
      // Test connection and cache PostgreSQL version
      await testAndCacheConnection(client, req.id)

      const latencyMs = Date.now() - start

      return { success: true, error: '', latencyMs }
    } catch (err) {
      const latencyMs = Date.now() - start
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        latencyMs,
      }
    } finally {
      await client.end()
    }
  },

  /**
   * Test parameters that may not be saved yet — the "Test" button in the connection
   * dialog. Owner-only, because it makes the server open an outbound connection to a
   * caller-supplied host; an owner can already do that by editing pgconsole.toml.
   */
  async testConnectionParams(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'testing connection parameters')

    const host = req.host?.trim()
    const database = req.database?.trim()
    const username = req.username?.trim()
    if (!host || !database || !username) {
      throw new ConnectError('host, database, and username are required', Code.InvalidArgument)
    }
    const port = req.port || 5432
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConnectError('port must be an integer between 1 and 65535', Code.InvalidArgument)
    }

    // An omitted password means "reuse the one already stored for req.id", so editing a
    // saved connection can be tested without the client ever holding the secret.
    let password = req.password
    if (password === undefined && req.id) {
      password = getStoredConnection(req.id)?.password
    }

    const start = Date.now()
    const client = createClient(
      { host, port, database, username, password, sslMode: req.sslMode?.trim() || 'prefer' },
      user?.email
    )
    try {
      await client`SELECT 1`
      return { success: true, error: '', latencyMs: Date.now() - start }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        latencyMs: Date.now() - start,
      }
    } finally {
      await client.end()
    }
  },

  async createConnection(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'creating a connection')
    const input = validateConnectionInput(req.connection)

    // Check the merged namespace so a store row can never shadow a TOML entry.
    if (getConnectionById(input.id)) {
      throw new ConnectError(`A connection with id "${input.id}" already exists`, Code.AlreadyExists)
    }

    const created = withStoreErrors(() =>
      createStoredConnection({ ...input, created_by: user?.email })
    )
    auditConfigChange(user?.email, 'connection.create', created.id)

    const conn = getConnectionById(created.id)!
    return { connection: toConnectionResponse(conn, getUserPermissions(user?.email ?? 'guest', created.id)) }
  },

  async updateConnection(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'updating a connection')
    const input = validateConnectionInput(req.connection)
    requireStoreBacked(input.id)

    withStoreErrors(() => updateStoredConnection(input.id, input))
    // Host, database, or credentials may all have moved, so the cached server version and
    // schema context for this connection are no longer trustworthy.
    clearConnectionCache(input.id)
    clearSchemaCache(input.id)
    auditConfigChange(user?.email, 'connection.update', input.id)

    const conn = getConnectionById(input.id)!
    return { connection: toConnectionResponse(conn, getUserPermissions(user?.email ?? 'guest', input.id)) }
  },

  async deleteConnection(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'deleting a connection')
    if (!req.id) {
      throw new ConnectError('id is required', Code.InvalidArgument)
    }
    requireStoreBacked(req.id)

    deleteStoredConnection(req.id)
    clearConnectionCache(req.id)
    clearSchemaCache(req.id)
    auditConfigChange(user?.email, 'connection.delete', req.id)
    return {}
  },

  /**
   * Databases on the server behind this connection. Returns just the configured database
   * unless the connection opted into all_databases, so server-wide browsing is always a
   * deliberate act rather than a default.
   */
  async listDatabases(req, context) {
    if (!req.connectionId) {
      throw new ConnectError('connection_id is required', Code.InvalidArgument)
    }
    const conn = getConnectionById(req.connectionId)
    if (!conn) {
      throw new ConnectError('Connection not found', Code.NotFound)
    }

    const user = await getUserFromContext(context.values)
    requireAnyPermission(user, req.connectionId)

    if (!conn.all_databases) {
      return { databases: [conn.database] }
    }

    const details = buildConnectionDetails(req.connectionId)
    if (!details) {
      throw new ConnectError('Connection not found', Code.NotFound)
    }
    const client = createClient(details, user?.email)
    try {
      // datallowconn excludes databases that reject connections; templates are internal.
      const rows = await client`
        SELECT datname
        FROM pg_database
        WHERE NOT datistemplate AND datallowconn
        ORDER BY datname
      `
      return { databases: rows.map((r) => r.datname as string) }
    } catch (err) {
      throw new ConnectError(
        err instanceof Error ? err.message : 'Failed to list databases',
        Code.Unavailable
      )
    } finally {
      await client.end()
    }
  },

  async listConnectionGroups(_req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'listing connection groups')
    return {
      groups: listStoredConnectionGroups().map((g) => ({
        id: g.id,
        name: g.name,
        sortOrder: g.sort_order,
      })),
    }
  },

  async upsertConnectionGroup(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'saving a connection group')

    const id = req.group?.id?.trim()
    const name = req.group?.name?.trim()
    if (!id || !name) {
      throw new ConnectError('group id and name are required', Code.InvalidArgument)
    }
    if (!ID_RE.test(id)) {
      throw new ConnectError('group id must be alphanumeric with dots, dashes, or underscores', Code.InvalidArgument)
    }
    const sortOrder = req.group?.sortOrder ?? 0

    upsertStoredConnectionGroup({ id, name, sort_order: sortOrder })
    auditConfigChange(user?.email, 'connection_group.upsert', id)
    return { group: { id, name, sortOrder } }
  },

  async deleteConnectionGroup(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'deleting a connection group')
    if (!req.id) {
      throw new ConnectError('id is required', Code.InvalidArgument)
    }
    // Connections in the group are not deleted — the FK is ON DELETE SET NULL, so they
    // simply become ungrouped.
    if (!deleteStoredConnectionGroup(req.id)) {
      throw new ConnectError('Connection group not found', Code.NotFound)
    }
    auditConfigChange(user?.email, 'connection_group.delete', req.id)
    return {}
  },
}
