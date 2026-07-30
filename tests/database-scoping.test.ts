import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'
import { buildConnectionDetails, DatabaseNotAllowedError } from '../server/lib/db'
import { getSchemaCache, refreshSchemaCache, clearSchemaCache } from '../server/lib/schema-cache'
import { loadConfigFromString } from '../server/lib/config'
import { migrate, closeStore, lockStore, setMasterPassword, createStoredConnection } from '../server/lib/store'

// buildSchemaContext issues real catalog queries, so stub the client it opens. Everything
// else in lib/db — notably buildConnectionDetails, under test above — stays real.
vi.mock('../server/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/lib/db')>()
  return {
    ...actual,
    createClient: () => {
      const sql = () => Promise.resolve([])
      sql.end = () => Promise.resolve()
      return sql
    },
  }
})

let dataDir: string

const TOML = `
[[connections]]
id = "single"
name = "Single DB"
host = "localhost"
port = 5432
database = "appdb"
username = "app"
lazy = true
`

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'pgconsole-dbscope-test-'))
  delete process.env.PGCONSOLE_SECRET_KEY
  lockStore()
  migrate(dataDir)
  setMasterPassword('master-password')
  await loadConfigFromString(TOML)
  clearSchemaCache()
})

afterEach(() => {
  closeStore()
  lockStore()
  clearSchemaCache()
  rmSync(dataDir, { recursive: true, force: true })
})

const BASE = {
  name: 'Server',
  host: 'db.example.com',
  port: 5432,
  database: 'maintenance',
  username: 'app',
}

describe('buildConnectionDetails database override', () => {
  it('returns null for an unknown connection', () => {
    expect(buildConnectionDetails('ghost')).toBeNull()
  })

  it('uses the configured database when no override is given', () => {
    expect(buildConnectionDetails('single')?.database).toBe('appdb')
  })

  it('allows an override that equals the configured database, even without all_databases', () => {
    // Not a widening, so it must not be treated as one.
    expect(buildConnectionDetails('single', 'appdb')?.database).toBe('appdb')
  })

  it('treats blank and whitespace-only overrides as absent', () => {
    expect(buildConnectionDetails('single', '')?.database).toBe('appdb')
    expect(buildConnectionDetails('single', '   ')?.database).toBe('appdb')
  })

  it('REJECTS a different database when all_databases is off', () => {
    // The security-critical case: an IAM grant scoped to one database must not be
    // widenable by a crafted request.
    expect(() => buildConnectionDetails('single', 'otherdb')).toThrow(DatabaseNotAllowedError)
    expect(() => buildConnectionDetails('single', 'otherdb')).toThrow(/not available on connection/)
  })

  it('defaults store connections to all_databases off', () => {
    createStoredConnection({ ...BASE, id: 'stored' })
    expect(() => buildConnectionDetails('stored', 'otherdb')).toThrow(DatabaseNotAllowedError)
  })

  it('honours a different database once all_databases is on', () => {
    createStoredConnection({ ...BASE, id: 'server', all_databases: true })
    expect(buildConnectionDetails('server')?.database).toBe('maintenance')
    expect(buildConnectionDetails('server', 'otherdb')?.database).toBe('otherdb')
  })

  it('carries the rest of the connection through unchanged when overriding', () => {
    createStoredConnection({
      ...BASE,
      id: 'server',
      all_databases: true,
      password: 'pw',
      ssl_mode: 'require',
      lock_timeout: '5s',
    })
    expect(buildConnectionDetails('server', 'otherdb')).toEqual({
      host: 'db.example.com',
      port: 5432,
      database: 'otherdb',
      username: 'app',
      password: 'pw',
      sslMode: 'require',
      lockTimeout: '5s',
      statementTimeout: undefined,
    })
  })
})

describe('schema cache database keying', () => {
  const DETAILS = (database: string) => ({
    host: 'h',
    port: 5432,
    database,
    username: 'u',
    password: undefined,
    sslMode: 'prefer',
  })

  // buildSchemaContext would need a live server, so seed the cache through the same
  // public entry point the service uses, with an empty schema list.
  async function seed(connectionId: string, database: string) {
    return refreshSchemaCache(connectionId, DETAILS(database), [], '16')
  }

  it('files an entry under the database actually queried', async () => {
    await seed('conn', 'db_one')
    expect(await getSchemaCache('conn', 'db_one')).not.toBeNull()
  })

  it('does NOT serve one database’s schema for another', async () => {
    // The whole point of the re-key: a stale hit here would silently feed the AI the
    // wrong database's schema.
    await seed('conn', 'db_one')
    expect(await getSchemaCache('conn', 'db_two')).toBeNull()
  })

  it('keeps entries for the same database on different connections separate', async () => {
    await seed('conn_a', 'shared')
    expect(await getSchemaCache('conn_a', 'shared')).not.toBeNull()
    expect(await getSchemaCache('conn_b', 'shared')).toBeNull()
  })

  it('clearSchemaCache(id) drops every database for that connection only', async () => {
    await seed('conn_a', 'db_one')
    await seed('conn_a', 'db_two')
    await seed('conn_b', 'db_one')

    clearSchemaCache('conn_a')
    expect(await getSchemaCache('conn_a', 'db_one')).toBeNull()
    expect(await getSchemaCache('conn_a', 'db_two')).toBeNull()
    expect(await getSchemaCache('conn_b', 'db_one')).not.toBeNull()
  })

  it('clearSchemaCache() with no id drops everything', async () => {
    await seed('conn_a', 'db_one')
    await seed('conn_b', 'db_two')
    clearSchemaCache()
    expect(await getSchemaCache('conn_a', 'db_one')).toBeNull()
    expect(await getSchemaCache('conn_b', 'db_two')).toBeNull()
  })

  it('does not let a connection id prefix clear an unrelated connection', async () => {
    // "conn" is a prefix of "conn_extra"; the NUL separator is what keeps them distinct.
    await seed('conn', 'db')
    await seed('conn_extra', 'db')
    clearSchemaCache('conn')
    expect(await getSchemaCache('conn', 'db')).toBeNull()
    expect(await getSchemaCache('conn_extra', 'db')).not.toBeNull()
  })

  it('does not serve a context built for one schema when another is requested', async () => {
    // The context text only describes the schemas it was built for. Handing back the wrong
    // one means the model is asked about tables it was never shown.
    await refreshSchemaCache('conn', DETAILS('db'), ['public'], '16')
    expect(await getSchemaCache('conn', 'db', ['public'])).not.toBeNull()
    expect(await getSchemaCache('conn', 'db', ['reporting'])).toBeNull()
    expect(await getSchemaCache('conn', 'db', ['public', 'reporting'])).toBeNull()
    // "every schema" is its own request, not a superset that any named set satisfies.
    expect(await getSchemaCache('conn', 'db', [])).toBeNull()
  })

  it('treats schema order and duplicates as the same request', async () => {
    await refreshSchemaCache('conn', DETAILS('db'), ['public', 'app'], '16')
    expect(await getSchemaCache('conn', 'db', ['app', 'public'])).not.toBeNull()
    expect(await getSchemaCache('conn', 'db', ['public', 'app', 'public'])).not.toBeNull()
  })

  it('expires entries so externally created tables eventually appear', async () => {
    // Nothing clears this cache except a connection edit, so a table created by a batch job
    // would otherwise stay invisible to the AI for the life of the process while the object
    // tree, which queries live, shows it.
    await seed('conn', 'db')
    expect(await getSchemaCache('conn', 'db')).not.toBeNull()

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000)
      expect(await getSchemaCache('conn', 'db')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps entries that are still fresh', async () => {
    await seed('conn', 'db')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 60 * 1000)
      expect(await getSchemaCache('conn', 'db')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
