import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'

/**
 * End-to-end over the generateSQL handler: what the model actually receives.
 *
 * The reported bug was AI-generated SQL naming a different table than the one the user had
 * open, in a schema where every table has the same column shape. Two things have to be true
 * to prevent it — the selected table has to reach the prompt, and the table names in the
 * schema context have to be quoted so they can be used verbatim — and both are only visible
 * from here, at the seam between the request and the vendor call.
 */

// Captures what would have gone to the provider.
const vendorCalls: Array<{
  systemPrompt: string | null
  userPrompt: string
  sessionId: string
}> = []

vi.mock('../server/ai/vendors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/ai/vendors')>()
  return {
    ...actual,
    generateWithVendor: (
      _vendor: string,
      _apiKey: string,
      _model: string,
      systemPrompt: string | null,
      userPrompt: string,
      sessionId: string
    ) => {
      vendorCalls.push({ systemPrompt, userPrompt, sessionId })
      return Promise.resolve({ sql: 'SELECT 1', sessionId: 'sess-1' })
    },
  }
})

// buildSchemaContext runs real catalog queries; feed it a schema whose table and column
// names would be destroyed by case folding.
vi.mock('../server/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/lib/db')>()
  return {
    ...actual,
    createClient: () => {
      // Identified by query text rather than call order: the builder also tags small
      // fragments (`client`AND n.nspname = ANY(...)``) which would throw off a counter.
      const sql = (strings: TemplateStringsArray = [''] as never) => {
        const text = Array.isArray(strings) ? strings.join(' ') : String(strings)
        const isTables = text.includes('pg_attribute') && text.includes('relkind')
        if (isTables) {
          return Promise.resolve([
            {
              schema_name: 'public',
              table_name: 'AWS_New_Batch_4_fs',
              table_comment: null,
              object_type: 'TABLE',
              columns: [
                { name: 'id', type: 'integer', nullable: false, default: null, comment: null },
                { name: 'file_name', type: 'character varying', nullable: true, default: null, comment: null },
                { name: 'Model_Response', type: 'text', nullable: true, default: null, comment: null },
              ],
            },
            {
              schema_name: 'public',
              table_name: 'AB_SMB_2026',
              table_comment: null,
              object_type: 'TABLE',
              columns: [
                { name: 'id', type: 'integer', nullable: false, default: null, comment: null },
                { name: 'file_name', type: 'character varying', nullable: true, default: null, comment: null },
              ],
            },
            {
              schema_name: 'public',
              table_name: 'plain_table',
              table_comment: null,
              object_type: 'TABLE',
              columns: [
                { name: 'id', type: 'integer', nullable: false, default: null, comment: null },
              ],
            },
          ])
        }
        return Promise.resolve([])
      }
      sql.end = () => Promise.resolve()
      return sql
    },
  }
})

// Reported version lookups shouldn't need a live server.
vi.mock('../server/lib/connection-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/lib/connection-cache')>()
  return {
    ...actual,
    getConnectionInfo: () => ({ version: '17.0', connected: true }),
    tryGetConnectionInfo: () => ({ version: '17.0', connected: true }),
  }
})

const TOML = `
[[connections]]
id = "srv"
name = "Server"
host = "localhost"
port = 5432
database = "postgres"
username = "app"
all_databases = true
lazy = true

[[ai.providers]]
id = "prov"
vendor = "openai"
model = "gpt-4o"
api_key = "sk-test"
`

let dataDir: string
let generateSQL: (req: Record<string, unknown>) => Promise<{ sql: string; error: string }>

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'pgconsole-gensql-test-'))
  vendorCalls.length = 0

  const { migrate, lockStore } = await import('../server/lib/store')
  const { loadConfigFromString } = await import('../server/lib/config')
  const { clearSchemaCache } = await import('../server/lib/schema-cache')
  const { aiServiceHandlers } = await import('../server/services/ai-service')

  delete process.env.PGCONSOLE_SECRET_KEY
  lockStore()
  migrate(dataDir)
  await loadConfigFromString(TOML)
  clearSchemaCache()

  const handlers = aiServiceHandlers as unknown as {
    generateSQL: (req: Record<string, unknown>) => Promise<{ sql: string; error: string }>
  }
  generateSQL = (req) => handlers.generateSQL(req)
})

afterEach(async () => {
  const { closeStore } = await import('../server/lib/store')
  closeStore()
  rmSync(dataDir, { recursive: true, force: true })
})

const BASE = {
  connectionId: 'srv',
  providerId: 'prov',
  prompt: 'fetch 10 most recent records',
  schemas: ['public'],
  sessionId: '',
  database: '',
  focusSchema: '',
  focusTable: '',
}

describe('generateSQL prompt assembly', () => {
  it('names the selected table in the user message', async () => {
    const res = await generateSQL({ ...BASE, focusSchema: 'public', focusTable: 'AWS_New_Batch_4_fs' })
    expect(res.error).toBe('')
    expect(vendorCalls).toHaveLength(1)

    const { userPrompt } = vendorCalls[0]
    // Quoted, because unquoted it would resolve to aws_new_batch_4_fs and fail.
    expect(userPrompt).toContain('public."AWS_New_Batch_4_fs"')
    expect(userPrompt).toContain('fetch 10 most recent records')
  })

  it('sends the prompt alone when nothing is selected', async () => {
    await generateSQL(BASE)
    expect(vendorCalls[0].userPrompt).toBe('fetch 10 most recent records')
  })

  it('quotes case-sensitive identifiers in the schema context', async () => {
    await generateSQL(BASE)
    const system = vendorCalls[0].systemPrompt ?? ''

    expect(system).toContain('public."AWS_New_Batch_4_fs"')
    expect(system).toContain('public."AB_SMB_2026"')
    expect(system).toContain('"Model_Response"')
    // Names that are safe bare stay bare, so the model isn't taught to quote everything.
    expect(system).toContain('public.plain_table')
    expect(system).toMatch(/^\s+file_name:/m)
  })

  it('defaults an unqualified selection to public', async () => {
    await generateSQL({ ...BASE, focusSchema: '', focusTable: 'AB_SMB_2026' })
    expect(vendorCalls[0].userPrompt).toContain('public."AB_SMB_2026"')
  })

  it('still carries the selection on a follow-up turn, when the schema is not resent', async () => {
    await generateSQL({
      ...BASE,
      sessionId: 'sess-1',
      prompt: 'now only the last 3',
      focusSchema: 'public',
      focusTable: 'AWS_New_Batch_4_fs',
    })
    // The system prompt is deliberately skipped mid-session...
    expect(vendorCalls[0].systemPrompt).toBeNull()
    // ...so the focus has to travel with the user message or it is lost for the rest of the
    // conversation, which is exactly when the user is most likely to switch tables.
    expect(vendorCalls[0].userPrompt).toContain('public."AWS_New_Batch_4_fs"')
    expect(vendorCalls[0].userPrompt).toContain('now only the last 3')
  })
})
