import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import path from 'path'
import os from 'os'
import {
  encryptSecret,
  decryptSecret,
  generateSalt,
  loadKeyFromEnv,
  unlockWithPassword,
  isUnlocked,
  lock,
  makeKeyCheck,
  verifyKeyCheck,
  WrongMasterPasswordError,
} from './secrets'
import type { Vendor } from '../ai/vendors'

/**
 * Persistence for config the user manages from the UI: database connections and AI
 * providers. Deliberately additive — pgconsole.toml remains the source for
 * operator-managed entries, and this store layers on top (see config.ts merge).
 *
 * node:sqlite's DatabaseSync is synchronous, which is what lets the config getters keep
 * their existing synchronous signatures instead of forcing an async refactor through
 * every call site in query-service, iam, and mcp.
 */

const SCHEMA_VERSION = 1

export interface StoredConnection {
  id: string
  name: string
  host: string
  port: number
  database: string
  username: string
  password?: string          // decrypted on read; undefined when locked or unset
  hasPassword: boolean
  ssl_mode?: string
  ssl_ca?: string
  ssl_cert?: string
  ssl_key?: string
  lock_timeout?: string
  statement_timeout?: string
  color?: string
  group_id?: string
  labels: string[]
  all_databases: boolean
  created_by?: string
}

export interface StoredAIProvider {
  id: string
  name: string
  vendor: Vendor
  model: string
  base_url?: string
  api_key?: string           // decrypted on read; undefined when locked or unset
  hasApiKey: boolean
  created_by?: string
}

export interface StoredConnectionGroup {
  id: string
  name: string
  sort_order: number
}

let db: DatabaseSync | null = null

/** Resolve the per-install data directory. Electron passes its userData path via env. */
export function resolveDataDir(): string {
  const explicit = process.env.PGCONSOLE_DATA_DIR?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) return path.join(appData, 'pgconsole')
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) return path.join(xdg, 'pgconsole')
  return path.join(os.homedir(), '.config', 'pgconsole')
}

function requireDb(): DatabaseSync {
  if (!db) throw new Error('Store not initialized — call migrate() first')
  return db
}

/** Open the store and bring the schema up to date. Idempotent. */
export function migrate(dataDir = resolveDataDir()): void {
  mkdirSync(dataDir, { recursive: true })
  db = new DatabaseSync(path.join(dataDir, 'pgconsole.db'))

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connection_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT
    );
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      database TEXT NOT NULL,
      username TEXT NOT NULL,
      password_enc TEXT,
      ssl_mode TEXT,
      ssl_ca TEXT,
      ssl_cert TEXT,
      ssl_key TEXT,
      lock_timeout TEXT,
      statement_timeout TEXT,
      color TEXT,
      group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
      all_databases INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connection_labels (
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (connection_id, label_id)
    );
    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      vendor TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url TEXT,
      api_key_enc TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  setMeta('schema_version', String(SCHEMA_VERSION))
}

/** Close the store. Used on shutdown and by tests. */
export function closeStore(): void {
  db?.close()
  db = null
  keyFromEnv = false
}

export function isStoreOpen(): boolean {
  return db !== null
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export function getMeta(key: string): string | undefined {
  const row = requireDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setMeta(key: string, value: string): void {
  requireDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

// ---------------------------------------------------------------------------
// key management
// ---------------------------------------------------------------------------

let keyFromEnv = false

/**
 * Adopt PGCONSOLE_SECRET_KEY if present and record a key check on first use.
 * Returns true when the store ends up unlocked.
 */
export function initSecretsFromEnv(): boolean {
  if (!loadKeyFromEnv()) return false
  ensureKeyCheck()
  keyFromEnv = true
  return true
}

/** True when the active key came from the environment, so there's no password to prompt for. */
export function isKeyFromEnv(): boolean {
  return keyFromEnv
}

/** Whether a master password (or env key) has ever been established for this store. */
export function hasMasterPassword(): boolean {
  return getMeta('key_check') !== undefined
}

/**
 * Set the master password for a store that has none yet. Fails if one already exists —
 * changing it has to re-encrypt every secret, which is a separate operation.
 */
export function setMasterPassword(password: string): void {
  if (hasMasterPassword()) {
    throw new Error('A master password is already set for this store')
  }
  const salt = generateSalt()
  setMeta('kdf_salt', salt)
  unlockWithPassword(password, salt)
  setMeta('key_check', makeKeyCheck())
}

/** Unlock an existing store. Throws WrongMasterPasswordError on a bad password. */
export function unlockStore(password: string): void {
  const salt = getMeta('kdf_salt')
  const check = getMeta('key_check')
  if (!salt || !check) {
    throw new Error('No master password has been set for this store')
  }
  unlockWithPassword(password, salt)
  if (!verifyKeyCheck(check)) {
    // Drop the derived key so a failed attempt can't leave the store half-unlocked.
    lock()
    throw new WrongMasterPasswordError()
  }
}

/** Drop the in-memory key. An env-provided key is forgotten too, so status stays honest. */
export function lockStore(): void {
  lock()
  keyFromEnv = false
}

export { isUnlocked }

/** Record a key check the first time a key is established (env-key path). */
function ensureKeyCheck(): void {
  if (!getMeta('key_check') && isUnlocked()) {
    setMeta('key_check', makeKeyCheck())
  }
}

/**
 * Decrypt a stored secret, returning undefined rather than throwing when the store is
 * locked or the blob no longer matches the active key. Callers treat a missing secret
 * as "not available", which keeps a re-keyed store browsable instead of erroring
 * everywhere.
 */
function tryDecrypt(blob: string | null): string | undefined {
  if (!blob) return undefined
  if (!isUnlocked()) return undefined
  try {
    return decryptSecret(blob)
  } catch {
    return undefined
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

interface ConnectionRow {
  id: string
  name: string
  host: string
  port: number
  database: string
  username: string
  password_enc: string | null
  ssl_mode: string | null
  ssl_ca: string | null
  ssl_cert: string | null
  ssl_key: string | null
  lock_timeout: string | null
  statement_timeout: string | null
  color: string | null
  group_id: string | null
  all_databases: number
  created_by: string | null
}

function rowToConnection(row: ConnectionRow, labels: string[]): StoredConnection {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    password: tryDecrypt(row.password_enc),
    hasPassword: row.password_enc !== null,
    ssl_mode: row.ssl_mode ?? undefined,
    ssl_ca: row.ssl_ca ?? undefined,
    ssl_cert: row.ssl_cert ?? undefined,
    ssl_key: row.ssl_key ?? undefined,
    lock_timeout: row.lock_timeout ?? undefined,
    statement_timeout: row.statement_timeout ?? undefined,
    color: row.color ?? undefined,
    group_id: row.group_id ?? undefined,
    labels,
    all_databases: row.all_databases === 1,
    created_by: row.created_by ?? undefined,
  }
}

function labelsFor(connectionId: string): string[] {
  return (
    requireDb()
      .prepare('SELECT label_id FROM connection_labels WHERE connection_id = ? ORDER BY label_id')
      .all(connectionId) as { label_id: string }[]
  ).map((r) => r.label_id)
}

export function listStoredConnections(): StoredConnection[] {
  const rows = requireDb().prepare('SELECT * FROM connections ORDER BY name').all() as unknown as ConnectionRow[]
  return rows.map((row) => rowToConnection(row, labelsFor(row.id)))
}

export function getStoredConnection(id: string): StoredConnection | undefined {
  const row = requireDb().prepare('SELECT * FROM connections WHERE id = ?').get(id) as unknown as
    | ConnectionRow
    | undefined
  return row ? rowToConnection(row, labelsFor(row.id)) : undefined
}

export interface ConnectionInput {
  id: string
  name: string
  host: string
  port: number
  database: string
  username: string
  password?: string
  ssl_mode?: string
  ssl_ca?: string
  ssl_cert?: string
  ssl_key?: string
  lock_timeout?: string
  statement_timeout?: string
  color?: string
  group_id?: string
  labels?: string[]
  all_databases?: boolean
  created_by?: string
}

export function createStoredConnection(input: ConnectionInput): StoredConnection {
  const d = requireDb()
  const ts = nowIso()
  // encryptSecret throws SecretsLockedError when no key is configured, which is the
  // signal the UI turns into "set a master password first".
  const passwordEnc = input.password ? encryptSecret(input.password) : null

  d.exec('BEGIN')
  try {
    d.prepare(
      `INSERT INTO connections (id, name, host, port, database, username, password_enc,
        ssl_mode, ssl_ca, ssl_cert, ssl_key, lock_timeout, statement_timeout,
        color, group_id, all_databases, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      input.id, input.name, input.host, input.port, input.database, input.username, passwordEnc,
      input.ssl_mode ?? null, input.ssl_ca ?? null, input.ssl_cert ?? null, input.ssl_key ?? null,
      input.lock_timeout ?? null, input.statement_timeout ?? null,
      input.color ?? null, input.group_id ?? null, input.all_databases ? 1 : 0,
      input.created_by ?? null, ts, ts
    )
    replaceLabels(input.id, input.labels ?? [])
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  return getStoredConnection(input.id)!
}

/**
 * Update a stored connection. `password` is tri-state: undefined leaves the stored one
 * alone (the UI never round-trips a secret back to us), empty string clears it, and a
 * value replaces it.
 */
export function updateStoredConnection(
  id: string,
  input: Omit<ConnectionInput, 'id' | 'created_by'>
): StoredConnection {
  const d = requireDb()
  const existing = d.prepare('SELECT password_enc FROM connections WHERE id = ?').get(id) as
    | { password_enc: string | null }
    | undefined
  if (!existing) throw new Error(`Connection not found: ${id}`)

  const passwordEnc =
    input.password === undefined
      ? existing.password_enc
      : input.password === ''
        ? null
        : encryptSecret(input.password)

  d.exec('BEGIN')
  try {
    d.prepare(
      `UPDATE connections SET name=?, host=?, port=?, database=?, username=?, password_enc=?,
        ssl_mode=?, ssl_ca=?, ssl_cert=?, ssl_key=?, lock_timeout=?, statement_timeout=?,
        color=?, group_id=?, all_databases=?, updated_at=? WHERE id=?`
    ).run(
      input.name, input.host, input.port, input.database, input.username, passwordEnc,
      input.ssl_mode ?? null, input.ssl_ca ?? null, input.ssl_cert ?? null, input.ssl_key ?? null,
      input.lock_timeout ?? null, input.statement_timeout ?? null,
      input.color ?? null, input.group_id ?? null, input.all_databases ? 1 : 0,
      nowIso(), id
    )
    replaceLabels(id, input.labels ?? [])
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  return getStoredConnection(id)!
}

export function deleteStoredConnection(id: string): boolean {
  const info = requireDb().prepare('DELETE FROM connections WHERE id = ?').run(id)
  return Number(info.changes) > 0
}

function replaceLabels(connectionId: string, labelIds: string[]): void {
  const d = requireDb()
  d.prepare('DELETE FROM connection_labels WHERE connection_id = ?').run(connectionId)
  const insert = d.prepare('INSERT INTO connection_labels (connection_id, label_id) VALUES (?, ?)')
  for (const labelId of labelIds) insert.run(connectionId, labelId)
}

// ---------------------------------------------------------------------------
// connection groups
// ---------------------------------------------------------------------------

export function listStoredConnectionGroups(): StoredConnectionGroup[] {
  return requireDb()
    .prepare('SELECT id, name, sort_order FROM connection_groups ORDER BY sort_order, name')
    .all() as unknown as StoredConnectionGroup[]
}

export function upsertStoredConnectionGroup(group: StoredConnectionGroup): void {
  requireDb()
    .prepare(
      `INSERT INTO connection_groups (id, name, sort_order) VALUES (?,?,?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order`
    )
    .run(group.id, group.name, group.sort_order)
}

export function deleteStoredConnectionGroup(id: string): boolean {
  const info = requireDb().prepare('DELETE FROM connection_groups WHERE id = ?').run(id)
  return Number(info.changes) > 0
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

export interface StoredLabel {
  id: string
  name: string
  color?: string
}

export function listStoredLabels(): StoredLabel[] {
  const rows = requireDb().prepare('SELECT id, name, color FROM labels ORDER BY name').all() as unknown as {
    id: string
    name: string
    color: string | null
  }[]
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color ?? undefined }))
}

export function upsertStoredLabel(label: StoredLabel): void {
  requireDb()
    .prepare(
      `INSERT INTO labels (id, name, color) VALUES (?,?,?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color`
    )
    .run(label.id, label.name, label.color ?? null)
}

export function deleteStoredLabel(id: string): boolean {
  const info = requireDb().prepare('DELETE FROM labels WHERE id = ?').run(id)
  return Number(info.changes) > 0
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

interface ProviderRow {
  id: string
  name: string
  vendor: string
  model: string
  base_url: string | null
  api_key_enc: string | null
  created_by: string | null
}

function rowToProvider(row: ProviderRow): StoredAIProvider {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor as Vendor,
    model: row.model,
    base_url: row.base_url ?? undefined,
    api_key: tryDecrypt(row.api_key_enc),
    hasApiKey: row.api_key_enc !== null,
    created_by: row.created_by ?? undefined,
  }
}

export function listStoredAIProviders(): StoredAIProvider[] {
  const rows = requireDb().prepare('SELECT * FROM ai_providers ORDER BY name').all() as unknown as ProviderRow[]
  return rows.map(rowToProvider)
}

export function getStoredAIProvider(id: string): StoredAIProvider | undefined {
  const row = requireDb().prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as unknown as
    | ProviderRow
    | undefined
  return row ? rowToProvider(row) : undefined
}

export interface AIProviderInput {
  id: string
  name: string
  vendor: Vendor
  model: string
  base_url?: string
  api_key?: string
  created_by?: string
}

export function createStoredAIProvider(input: AIProviderInput): StoredAIProvider {
  const ts = nowIso()
  const apiKeyEnc = input.api_key ? encryptSecret(input.api_key) : null
  requireDb()
    .prepare(
      `INSERT INTO ai_providers (id, name, vendor, model, base_url, api_key_enc, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(input.id, input.name, input.vendor, input.model, input.base_url ?? null, apiKeyEnc, input.created_by ?? null, ts, ts)
  return getStoredAIProvider(input.id)!
}

/** `api_key` is tri-state, same contract as connection passwords. */
export function updateStoredAIProvider(
  id: string,
  input: Omit<AIProviderInput, 'id' | 'created_by'>
): StoredAIProvider {
  const d = requireDb()
  const existing = d.prepare('SELECT api_key_enc FROM ai_providers WHERE id = ?').get(id) as
    | { api_key_enc: string | null }
    | undefined
  if (!existing) throw new Error(`AI provider not found: ${id}`)

  const apiKeyEnc =
    input.api_key === undefined
      ? existing.api_key_enc
      : input.api_key === ''
        ? null
        : encryptSecret(input.api_key)

  d.prepare(
    `UPDATE ai_providers SET name=?, vendor=?, model=?, base_url=?, api_key_enc=?, updated_at=? WHERE id=?`
  ).run(input.name, input.vendor, input.model, input.base_url ?? null, apiKeyEnc, nowIso(), id)
  return getStoredAIProvider(id)!
}

export function deleteStoredAIProvider(id: string): boolean {
  const info = requireDb().prepare('DELETE FROM ai_providers WHERE id = ?').run(id)
  return Number(info.changes) > 0
}
