import { describe, it, expect } from 'vitest'
import { needsQuoting, quoteIdent, qualifiedName } from '../server/lib/identifiers'
import { TEXT_TO_SQL } from '../server/ai/prompts'

/**
 * A schema whose tables are all named like AWS_New_Batch_4_fs is only usable if the AI
 * context shows those names quoted — unquoted they fold to lower case and don't resolve —
 * and if the model is told which table the user actually has open, since a schema full of
 * same-shaped tables gives it nothing else to go on.
 */

describe('identifier quoting', () => {
  it('leaves plain lowercase names bare', () => {
    for (const name of ['users', 'user_id', 'a', '_private', 'tbl$1', 'x2']) {
      expect(needsQuoting(name), name).toBe(false)
      expect(quoteIdent(name)).toBe(name)
    }
  })

  it('quotes names that would be case-folded', () => {
    expect(quoteIdent('AWS_New_Batch_4_fs')).toBe('"AWS_New_Batch_4_fs"')
    expect(quoteIdent('AB_SMB_2026')).toBe('"AB_SMB_2026"')
    expect(quoteIdent('Users')).toBe('"Users"')
  })

  it('quotes names with characters that need it', () => {
    expect(quoteIdent('my table')).toBe('"my table"')
    expect(quoteIdent('order-count')).toBe('"order-count"')
    expect(quoteIdent('2fast')).toBe('"2fast"')
    expect(quoteIdent('café')).toBe('"café"')
  })

  it('quotes reserved words', () => {
    expect(quoteIdent('order')).toBe('"order"')
    expect(quoteIdent('select')).toBe('"select"')
    expect(quoteIdent('user')).toBe('"user"')
    expect(quoteIdent('table')).toBe('"table"')
    // Not reserved, and safe bare.
    expect(quoteIdent('name')).toBe('name')
  })

  it('escapes embedded double quotes by doubling them', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"')
  })

  it('qualifies each part independently', () => {
    expect(qualifiedName('public', 'AWS_New_Batch_4_fs')).toBe('public."AWS_New_Batch_4_fs"')
    expect(qualifiedName('public', 'users')).toBe('public.users')
    expect(qualifiedName('My Schema', 'users')).toBe('"My Schema".users')
  })
})

describe('TEXT_TO_SQL focus hint', () => {
  it('passes the prompt through untouched when nothing is selected', () => {
    expect(TEXT_TO_SQL.user({ prompt: 'fetch 10 most recent records', focus: '' })).toBe(
      'fetch 10 most recent records'
    )
  })

  it('names the selected table and keeps the request last', () => {
    const out = TEXT_TO_SQL.user({
      prompt: 'fetch 10 most recent records',
      focus: 'public."AWS_New_Batch_4_fs"',
    })
    expect(out).toContain('public."AWS_New_Batch_4_fs"')
    expect(out).toContain('fetch 10 most recent records')
    // The user's own words come last so they aren't buried by the hint.
    expect(out.trimEnd().endsWith('fetch 10 most recent records')).toBe(true)
    // The hint must not override an explicit table in the request.
    expect(out.toLowerCase()).toContain('unless the request')
  })
})

describe('TEXT_TO_SQL system prompt', () => {
  it('tells the model to preserve the quotes it is shown', () => {
    expect(TEXT_TO_SQL.system).toMatch(/double quotes/i)
    expect(TEXT_TO_SQL.system).toMatch(/folded to\s+lower case/i)
  })

  it('tells the model to use the selected table when the request names none', () => {
    expect(TEXT_TO_SQL.system).toMatch(/selected table/i)
  })
})
