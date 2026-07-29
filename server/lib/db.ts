import postgres from "postgres";
import { getConnectionById } from "./config";

export interface ConnectionDetails {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string | undefined;
  sslMode: string;
  lockTimeout?: string;
  statementTimeout?: string;
}

/**
 * Raised when a caller asks for a database the connection isn't allowed to reach.
 * Distinguished from "unknown connection" so callers can map it to the right RPC code.
 */
export class DatabaseNotAllowedError extends Error {
  constructor(connectionId: string, database: string) {
    super(`Database "${database}" is not available on connection "${connectionId}"`);
    this.name = "DatabaseNotAllowedError";
  }
}

// Map a configured connection to the details needed to open a client.
// Returns null when the connection ID is unknown; callers raise their own error.
//
// `database` overrides the connection's configured (maintenance) database, which is how
// one connection browses many databases on the same server, pgAdmin-style. The override
// is only honoured when the connection opted into `all_databases`; otherwise asking for
// anything other than the configured database is rejected rather than silently ignored,
// so an IAM grant scoped to one database can't be widened by a crafted request.
export function buildConnectionDetails(
  connectionId: string,
  database?: string
): ConnectionDetails | null {
  const conn = getConnectionById(connectionId);
  if (!conn) return null;

  let resolvedDatabase = conn.database;
  const requested = database?.trim();
  if (requested && requested !== conn.database) {
    if (!conn.all_databases) {
      throw new DatabaseNotAllowedError(connectionId, requested);
    }
    resolvedDatabase = requested;
  }

  return {
    host: conn.host,
    port: conn.port,
    database: resolvedDatabase,
    username: conn.username,
    password: conn.password,
    sslMode: conn.ssl_mode || "prefer",
    lockTimeout: conn.lock_timeout,
    statementTimeout: conn.statement_timeout,
  };
}

export function formatAppName(appUser?: string): string {
  if (!appUser) return "pgconsole";
  // PostgreSQL application_name has a 63 character limit
  const maxUserLen = 63 - "pgconsole/".length;
  const truncated = appUser.length > maxUserLen ? appUser.slice(0, maxUserLen) : appUser;
  return `pgconsole/${truncated}`;
}

export function createClient(details: ConnectionDetails, appUser?: string) {
  return postgres({
    host: details.host,
    port: details.port,
    database: details.database,
    username: details.username,
    password: details.password,
    ssl: details.sslMode === "disable" ? false : details.sslMode,
    connect_timeout: 10,
    max: 1,
    onnotice: () => {},
    connection: {
      application_name: formatAppName(appUser),
      ...(details.lockTimeout && { lock_timeout: details.lockTimeout }),
      ...(details.statementTimeout && { statement_timeout: details.statementTimeout }),
    },
  });
}

export async function withConnection<T>(
  details: ConnectionDetails,
  fn: (sql: ReturnType<typeof postgres>) => Promise<T>,
  appUser?: string
): Promise<T> {
  const client = createClient(details, appUser);

  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
