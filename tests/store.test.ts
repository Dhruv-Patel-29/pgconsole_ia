import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import path from 'path'
import os from 'os'
import {
  migrate,
  closeStore,
  isStoreOpen,
  resolveDataDir,
  getMeta,
  hasMasterPassword,
  setMasterPassword,
  unlockStore,
  lockStore,
  isUnlocked,
  initSecretsFromEnv,
  createStoredConnection,
  getStoredConnection,
  listStoredConnections,
  updateStoredConnection,
  deleteStoredConnection,
  createStoredAIProvider,
  listStoredAIProviders,
  updateStoredAIProvider,
  deleteStoredAIProvider,
  upsertStoredLabel,
  upsertStoredConnectionGroup,
  listStoredConnectionGroups,
  deleteStoredConnectionGroup,
} from '../server/lib/store'
import { SecretsLockedError } from '../server/lib/secrets'
import { loadConfigFromString, getConnections, getConnectionById, getAIProviders, getAIProviderById, getLabels } from '../server/lib/config'

let dataDir: string

const CONN = {
  id: 'prod',
  name: 'Production',
  host: 'db.example.com',
  port: 5432,
  database: 'appdb',
  username: 'app',
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'pgconsole-store-test-'))
  delete process.env.PGCONSOLE_SECRET_KEY
  lockStore()
  migrate(dataDir)
})

afterEach(() => {
  closeStore()
  lockStore()
  delete process.env.PGCONSOLE_SECRET_KEY
  rmSync(dataDir, { recursive: true, force: true })
})

describe('migrate', () => {
  it('creates the database file and records the schema version', () => {
    expect(existsSync(path.join(dataDir, 'pgconsole.db'))).toBe(true)
    expect(getMeta('schema_version')).toBe('1')
    expect(isStoreOpen()).toBe(true)
  })

  it('is idempotent and preserves existing rows', () => {
    setMasterPassword('pw')
    createStoredConnection(CONN)
    migrate(dataDir)
    migrate(dataDir)
    expect(getMeta('schema_version')).toBe('1')
    expect(listStoredConnections()).toHaveLength(1)
  })

  it('closeStore leaves the store unusable until reopened', () => {
    closeStore()
    expect(isStoreOpen()).toBe(false)
    expect(() => listStoredConnections()).toThrow(/Store not initialized/)
  })
})

describe('resolveDataDir', () => {
  it('honours PGCONSOLE_DATA_DIR above all else', () => {
    process.env.PGCONSOLE_DATA_DIR = '/custom/path'
    expect(resolveDataDir()).toBe('/custom/path')
    delete process.env.PGCONSOLE_DATA_DIR
  })

  it('falls back to an XDG or home config path', () => {
    delete process.env.PGCONSOLE_DATA_DIR
    expect(resolveDataDir()).toContain('pgconsole')
  })
})

describe('master password', () => {
  it('starts with no master password and locked', () => {
    expect(hasMasterPassword()).toBe(false)
    expect(isUnlocked()).toBe(false)
  })

  it('setMasterPassword persists a salt and key check, and unlocks', () => {
    setMasterPassword('hunter2')
    expect(hasMasterPassword()).toBe(true)
    expect(isUnlocked()).toBe(true)
    expect(getMeta('kdf_salt')).toBeTruthy()
    expect(getMeta('key_check')).toBeTruthy()
  })

  it('refuses to overwrite an existing master password', () => {
    setMasterPassword('first')
    expect(() => setMasterPassword('second')).toThrow(/already set/)
  })

  it('unlockStore accepts the right password after a restart', () => {
    setMasterPassword('hunter2')
    createStoredConnection({ ...CONN, password: 'dbpass' })

    // Simulate a restart: drop the key, reopen the store.
    lockStore()
    closeStore()
    migrate(dataDir)

    expect(isUnlocked()).toBe(false)
    unlockStore('hunter2')
    expect(isUnlocked()).toBe(true)
    expect(getStoredConnection('prod')?.password).toBe('dbpass')
  })

  it('unlockStore rejects a wrong password and leaves the store locked', () => {
    setMasterPassword('hunter2')
    lockStore()
    expect(() => unlockStore('wrong')).toThrow(/Incorrect master password/)
    // Critical: a failed attempt must not leave a derived key behind.
    expect(isUnlocked()).toBe(false)
  })

  it('unlockStore throws when no master password was ever set', () => {
    expect(() => unlockStore('anything')).toThrow(/No master password/)
  })

  it('adopts PGCONSOLE_SECRET_KEY and records a key check on first use', () => {
    process.env.PGCONSOLE_SECRET_KEY = 'b'.repeat(64)
    expect(initSecretsFromEnv()).toBe(true)
    expect(isUnlocked()).toBe(true)
    expect(hasMasterPassword()).toBe(true)  // key_check now exists
  })

  it('initSecretsFromEnv is a no-op when the variable is unset', () => {
    expect(initSecretsFromEnv()).toBe(false)
    expect(isUnlocked()).toBe(false)
  })
})

describe('stored connections', () => {
  beforeEach(() => setMasterPassword('pw'))

  it('creates and reads back a connection', () => {
    const created = createStoredConnection({ ...CONN, password: 'secret' })
    expect(created).toMatchObject({ id: 'prod', name: 'Production', port: 5432, hasPassword: true })
    expect(created.password).toBe('secret')
    expect(getStoredConnection('prod')?.password).toBe('secret')
  })

  it('stores the password encrypted, not in the clear', () => {
    createStoredConnection({ ...CONN, password: 'plaintext-canary' })
    expect(listStoredConnections()[0].hasPassword).toBe(true)
    // The decrypted view returns the secret, but the on-disk file must never contain it.
    const bytes = readFileSync(path.join(dataDir, 'pgconsole.db'))
    expect(bytes.includes(Buffer.from('plaintext-canary'))).toBe(false)
  })

  it('records a connection with no password as hasPassword false', () => {
    const created = createStoredConnection(CONN)
    expect(created.hasPassword).toBe(false)
    expect(created.password).toBeUndefined()
  })

  it('refuses to store a password while locked, but allows a passwordless row', () => {
    lockStore()
    expect(() => createStoredConnection({ ...CONN, password: 'nope' })).toThrow(SecretsLockedError)
    expect(() => createStoredConnection({ ...CONN, id: 'nopass' })).not.toThrow()
  })

  it('hides the password but keeps the row readable when locked', () => {
    createStoredConnection({ ...CONN, password: 'secret' })
    lockStore()
    const conn = getStoredConnection('prod')
    expect(conn).toBeDefined()
    expect(conn?.hasPassword).toBe(true)
    expect(conn?.password).toBeUndefined()  // not decryptable, but not an error either
  })

  it('rejects a duplicate id', () => {
    createStoredConnection(CONN)
    expect(() => createStoredConnection(CONN)).toThrow()
  })

  it('update leaves the password alone when omitted', () => {
    createStoredConnection({ ...CONN, password: 'keep-me' })
    const updated = updateStoredConnection('prod', { ...CONN, name: 'Renamed' })
    expect(updated.name).toBe('Renamed')
    expect(updated.password).toBe('keep-me')
  })

  it('update replaces the password when given a new one', () => {
    createStoredConnection({ ...CONN, password: 'old' })
    expect(updateStoredConnection('prod', { ...CONN, password: 'new' }).password).toBe('new')
  })

  it('update clears the password when given an empty string', () => {
    createStoredConnection({ ...CONN, password: 'old' })
    const updated = updateStoredConnection('prod', { ...CONN, password: '' })
    expect(updated.hasPassword).toBe(false)
    expect(updated.password).toBeUndefined()
  })

  it('update throws for an unknown id', () => {
    expect(() => updateStoredConnection('ghost', CONN)).toThrow(/not found/)
  })

  it('delete removes the row and reports whether anything was removed', () => {
    createStoredConnection(CONN)
    expect(deleteStoredConnection('prod')).toBe(true)
    expect(getStoredConnection('prod')).toBeUndefined()
    expect(deleteStoredConnection('prod')).toBe(false)
  })

  it('round-trips optional fields including all_databases and group', () => {
    upsertStoredConnectionGroup({ id: 'grp', name: 'Group', sort_order: 1 })
    const created = createStoredConnection({
      ...CONN,
      ssl_mode: 'require',
      ssl_ca: '/certs/ca.pem',
      lock_timeout: '5s',
      color: '#dc2626',
      group_id: 'grp',
      all_databases: true,
      created_by: 'alice@example.com',
    })
    expect(created).toMatchObject({
      ssl_mode: 'require',
      ssl_ca: '/certs/ca.pem',
      lock_timeout: '5s',
      color: '#dc2626',
      group_id: 'grp',
      all_databases: true,
      created_by: 'alice@example.com',
    })
  })

  it('defaults all_databases to false', () => {
    expect(createStoredConnection(CONN).all_databases).toBe(false)
  })

  it('associates labels and returns them sorted', () => {
    upsertStoredLabel({ id: 'prod-label', name: 'Production', color: '#f00' })
    upsertStoredLabel({ id: 'critical', name: 'Critical' })
    const created = createStoredConnection({ ...CONN, labels: ['prod-label', 'critical'] })
    expect(created.labels).toEqual(['critical', 'prod-label'])
  })

  it('replaces labels on update', () => {
    upsertStoredLabel({ id: 'a', name: 'A' })
    upsertStoredLabel({ id: 'b', name: 'B' })
    createStoredConnection({ ...CONN, labels: ['a'] })
    expect(updateStoredConnection('prod', { ...CONN, labels: ['b'] }).labels).toEqual(['b'])
  })

  it('clearing a group leaves the connection intact', () => {
    upsertStoredConnectionGroup({ id: 'grp', name: 'Group', sort_order: 0 })
    createStoredConnection({ ...CONN, group_id: 'grp' })
    deleteStoredConnectionGroup('grp')
    // ON DELETE SET NULL: the connection survives, ungrouped.
    expect(getStoredConnection('prod')?.group_id).toBeUndefined()
    expect(listStoredConnectionGroups()).toHaveLength(0)
  })
})

describe('stored AI providers', () => {
  beforeEach(() => setMasterPassword('pw'))

  it('creates and reads back a provider with an encrypted key', () => {
    const created = createStoredAIProvider({
      id: 'ollama',
      name: 'Ollama Cloud',
      vendor: 'ollama-cloud',
      model: 'gpt-oss:120b',
      api_key: 'ok-12345',
    })
    expect(created).toMatchObject({ id: 'ollama', vendor: 'ollama-cloud', hasApiKey: true })
    expect(created.api_key).toBe('ok-12345')
    const bytes = readFileSync(path.join(dataDir, 'pgconsole.db'))
    expect(bytes.includes(Buffer.from('ok-12345'))).toBe(false)
  })

  it('supports a keyless provider (local Ollama)', () => {
    const created = createStoredAIProvider({
      id: 'local',
      name: 'Local',
      vendor: 'openai-compatible',
      model: 'llama3.3',
      base_url: 'http://localhost:11434/v1',
    })
    expect(created.hasApiKey).toBe(false)
    expect(created.base_url).toBe('http://localhost:11434/v1')
  })

  it('api_key is tri-state on update', () => {
    createStoredAIProvider({ id: 'p', name: 'P', vendor: 'openai', model: 'gpt-4o', api_key: 'old' })
    const base = { name: 'P', vendor: 'openai' as const, model: 'gpt-4o' }

    expect(updateStoredAIProvider('p', base).api_key).toBe('old')                      // omitted: keep
    expect(updateStoredAIProvider('p', { ...base, api_key: 'new' }).api_key).toBe('new')  // set: replace
    expect(updateStoredAIProvider('p', { ...base, api_key: '' }).hasApiKey).toBe(false)   // empty: clear
  })

  it('lists and deletes providers', () => {
    createStoredAIProvider({ id: 'a', name: 'A', vendor: 'openai', model: 'm', api_key: 'k' })
    createStoredAIProvider({ id: 'b', name: 'B', vendor: 'openai', model: 'm', api_key: 'k' })
    expect(listStoredAIProviders().map((p) => p.id)).toEqual(['a', 'b'])
    expect(deleteStoredAIProvider('a')).toBe(true)
    expect(deleteStoredAIProvider('a')).toBe(false)
    expect(listStoredAIProviders()).toHaveLength(1)
  })

  it('refuses to store a key while locked', () => {
    lockStore()
    expect(() =>
      createStoredAIProvider({ id: 'p', name: 'P', vendor: 'openai', model: 'm', api_key: 'k' })
    ).toThrow(SecretsLockedError)
  })
})

describe('config merge', () => {
  beforeEach(() => setMasterPassword('pw'))

  const TOML = `
[[connections]]
id = "toml-conn"
name = "From TOML"
host = "localhost"
port = 5432
database = "postgres"
username = "postgres"

[[ai.providers]]
id = "toml-provider"
vendor = "openai"
model = "gpt-4o"
api_key = "sk-toml"

[[labels]]
id = "toml-label"
name = "TOML Label"
color = "#111111"
`

  it('returns the union of TOML and store connections, tagged by source', async () => {
    await loadConfigFromString(TOML)
    createStoredConnection(CONN)

    const all = getConnections()
    expect(all.map((c) => c.id).sort()).toEqual(['prod', 'toml-conn'])
    expect(all.find((c) => c.id === 'toml-conn')?.source).toBe('toml')
    expect(all.find((c) => c.id === 'prod')?.source).toBe('store')
  })

  it('marks store connections lazy so they cannot fail startup', async () => {
    await loadConfigFromString(TOML)
    createStoredConnection(CONN)
    expect(getConnections().find((c) => c.id === 'prod')?.lazy).toBe(true)
  })

  it('getConnectionById resolves from either source', async () => {
    await loadConfigFromString(TOML)
    createStoredConnection(CONN)
    expect(getConnectionById('toml-conn')?.source).toBe('toml')
    expect(getConnectionById('prod')?.source).toBe('store')
    expect(getConnectionById('nope')).toBeUndefined()
  })

  it('TOML wins on a connection id collision', async () => {
    createStoredConnection({ ...CONN, id: 'toml-conn', name: 'Store version' })
    await loadConfigFromString(TOML)

    const all = getConnections()
    expect(all.filter((c) => c.id === 'toml-conn')).toHaveLength(1)
    expect(all.find((c) => c.id === 'toml-conn')?.name).toBe('From TOML')
    expect(getConnectionById('toml-conn')?.source).toBe('toml')
  })

  it('TOML wins on an AI provider id collision', async () => {
    createStoredAIProvider({ id: 'toml-provider', name: 'Store version', vendor: 'openai', model: 'm', api_key: 'k' })
    await loadConfigFromString(TOML)

    const all = getAIProviders()
    expect(all.filter((p) => p.id === 'toml-provider')).toHaveLength(1)
    expect(getAIProviderById('toml-provider')?.source).toBe('toml')
  })

  it('merges AI providers and exposes hasApiKey for both sources', async () => {
    await loadConfigFromString(TOML)
    createStoredAIProvider({ id: 'stored', name: 'Stored', vendor: 'ollama-cloud', model: 'gpt-oss:120b', api_key: 'k' })

    const all = getAIProviders()
    expect(all.map((p) => p.id).sort()).toEqual(['stored', 'toml-provider'])
    expect(all.find((p) => p.id === 'toml-provider')).toMatchObject({ source: 'toml', hasApiKey: true })
    expect(all.find((p) => p.id === 'stored')).toMatchObject({ source: 'store', hasApiKey: true })
  })

  it('merges labels, with TOML winning on collision', async () => {
    await loadConfigFromString(TOML)
    upsertStoredLabel({ id: 'store-label', name: 'Store Label', color: '#222222' })
    upsertStoredLabel({ id: 'toml-label', name: 'Shadowed' })

    const labels = getLabels()
    expect(labels.map((l) => l.id).sort()).toEqual(['store-label', 'toml-label'])
    expect(labels.find((l) => l.id === 'toml-label')?.name).toBe('TOML Label')
  })

  it('falls back to TOML only when the store is closed', async () => {
    await loadConfigFromString(TOML)
    createStoredConnection(CONN)
    expect(getConnections()).toHaveLength(2)

    closeStore()
    expect(getConnections().map((c) => c.id)).toEqual(['toml-conn'])
    expect(getConnectionById('prod')).toBeUndefined()
    expect(getAIProviders().map((p) => p.id)).toEqual(['toml-provider'])
    expect(getLabels().map((l) => l.id)).toEqual(['toml-label'])
  })
})
