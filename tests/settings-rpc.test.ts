import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'
import { ConnectError, Code } from '@connectrpc/connect'
import { aiServiceHandlers } from '../server/services/ai-service'
import { settingsServiceHandlers } from '../server/services/settings-service'
import { requireInstanceAdmin } from '../server/lib/iam'
import { loadConfigFromString, getAIProviderById } from '../server/lib/config'
import { migrate, closeStore, lockStore, setMasterPassword, isUnlocked } from '../server/lib/store'

let dataDir: string

/** Minimal stand-in for a ConnectRPC handler context. */
function ctx(user: { email: string } | null = { email: 'owner@example.com' }) {
  return { values: new Map<string, unknown>([['user', user]]) } as never
}

const NO_AUTH_TOML = `
[[connections]]
id = "local"
name = "Local"
host = "localhost"
port = 5432
database = "postgres"
username = "postgres"
lazy = true
`

const AUTH_TOML = `
[auth]
jwt_secret = "0123456789abcdef0123456789abcdef"

[[users]]
email = "owner@example.com"
owner = true

[[users]]
email = "member@example.com"

[[ai.providers]]
id = "managed"
vendor = "openai"
model = "gpt-4o"
api_key = "sk-toml"
`

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'pgconsole-rpc-test-'))
  delete process.env.PGCONSOLE_SECRET_KEY
  lockStore()
  migrate(dataDir)
  await loadConfigFromString(NO_AUTH_TOML)
})

afterEach(() => {
  closeStore()
  lockStore()
  rmSync(dataDir, { recursive: true, force: true })
})

function codeOf(err: unknown): Code | undefined {
  return err instanceof ConnectError ? err.code : undefined
}

describe('requireInstanceAdmin', () => {
  it('allows any principal when auth is disabled (desktop / single operator)', async () => {
    await loadConfigFromString(NO_AUTH_TOML)
    expect(() => requireInstanceAdmin({ email: 'guest' }, 'x')).not.toThrow()
    expect(() => requireInstanceAdmin(null, 'x')).not.toThrow()
  })

  it('allows the instance owner when auth is enabled', async () => {
    await loadConfigFromString(AUTH_TOML)
    expect(() => requireInstanceAdmin({ email: 'owner@example.com' }, 'x')).not.toThrow()
  })

  it('denies a non-owner and an anonymous caller when auth is enabled', async () => {
    await loadConfigFromString(AUTH_TOML)
    try {
      requireInstanceAdmin({ email: 'member@example.com' }, 'doing a thing')
      expect.unreachable()
    } catch (err) {
      expect(codeOf(err)).toBe(Code.PermissionDenied)
      expect((err as ConnectError).message).toMatch(/instance owner/)
    }
    expect(codeOf(tryCatch(() => requireInstanceAdmin(null, 'x')))).toBe(Code.Unauthenticated)
  })
})

function tryCatch(fn: () => void): unknown {
  try {
    fn()
    return undefined
  } catch (err) {
    return err
  }
}

describe('AI provider CRUD', () => {
  beforeEach(() => setMasterPassword('master-password'))

  const VALID = {
    id: 'ollama',
    name: 'Ollama Cloud',
    vendor: 'ollama-cloud',
    model: 'gpt-oss:120b',
    baseUrl: '',
    apiKey: 'ok-key',
  }

  it('creates a store-backed provider and never returns the key', async () => {
    const res = await aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx())
    expect(res.provider).toMatchObject({
      id: 'ollama',
      vendor: 'ollama-cloud',
      model: 'gpt-oss:120b',
      source: 'store',
      hasApiKey: true,
    })
    expect(JSON.stringify(res.provider)).not.toContain('ok-key')
  })

  it('surfaces the new provider through the merged getter', async () => {
    await aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx())
    expect(getAIProviderById('ollama')).toMatchObject({ source: 'store', api_key: 'ok-key' })
  })

  it('rejects a duplicate id, including one that collides with TOML', async () => {
    await aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx())
    expect(
      codeOf(await catchAsync(() => aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx())))
    ).toBe(Code.AlreadyExists)

    await loadConfigFromString(AUTH_TOML)
    expect(
      codeOf(
        await catchAsync(() =>
          aiServiceHandlers.createAIProvider({ provider: { ...VALID, id: 'managed' } } as never, ctx())
        )
      )
    ).toBe(Code.AlreadyExists)
  })

  it('rejects an unknown vendor', async () => {
    expect(
      codeOf(
        await catchAsync(() =>
          aiServiceHandlers.createAIProvider({ provider: { ...VALID, vendor: 'ollama' } } as never, ctx())
        )
      )
    ).toBe(Code.InvalidArgument)
  })

  it('requires a model and a well-formed id', async () => {
    expect(
      codeOf(await catchAsync(() => aiServiceHandlers.createAIProvider({ provider: { ...VALID, model: '  ' } } as never, ctx())))
    ).toBe(Code.InvalidArgument)
    expect(
      codeOf(await catchAsync(() => aiServiceHandlers.createAIProvider({ provider: { ...VALID, id: 'has spaces' } } as never, ctx())))
    ).toBe(Code.InvalidArgument)
  })

  it('requires base_url for openai-compatible but not for ollama-cloud', async () => {
    expect(
      codeOf(
        await catchAsync(() =>
          aiServiceHandlers.createAIProvider(
            { provider: { ...VALID, id: 'compat', vendor: 'openai-compatible', baseUrl: '' } } as never,
            ctx()
          )
        )
      )
    ).toBe(Code.InvalidArgument)

    // ollama-cloud defaults its endpoint, so a blank base_url is fine.
    await expect(
      aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx())
    ).resolves.toBeDefined()
  })

  it('rejects a non-http base_url', async () => {
    expect(
      codeOf(
        await catchAsync(() =>
          aiServiceHandlers.createAIProvider(
            { provider: { ...VALID, id: 'compat', vendor: 'openai-compatible', baseUrl: 'ftp://x' } } as never,
            ctx()
          )
        )
      )
    ).toBe(Code.InvalidArgument)
  })

  it('updates a store provider and keeps the key when apiKey is omitted', async () => {
    await aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx())
    const res = await aiServiceHandlers.updateAIProvider(
      { provider: { ...VALID, apiKey: undefined, name: 'Renamed' } } as never,
      ctx()
    )
    expect(res.provider).toMatchObject({ name: 'Renamed', hasApiKey: true })
    expect(getAIProviderById('ollama')?.api_key).toBe('ok-key')
  })

  it('refuses to update or delete a TOML-defined provider', async () => {
    await loadConfigFromString(AUTH_TOML)
    const managed = { id: 'managed', name: 'x', vendor: 'openai', model: 'gpt-4o', baseUrl: '' }
    expect(
      codeOf(await catchAsync(() => aiServiceHandlers.updateAIProvider({ provider: managed } as never, ctx())))
    ).toBe(Code.FailedPrecondition)
    expect(
      codeOf(await catchAsync(() => aiServiceHandlers.deleteAIProvider({ id: 'managed' } as never, ctx())))
    ).toBe(Code.FailedPrecondition)
  })

  it('deletes a store provider, and 404s for an unknown one', async () => {
    await aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx())
    await aiServiceHandlers.deleteAIProvider({ id: 'ollama' } as never, ctx())
    expect(getAIProviderById('ollama')).toBeUndefined()
    expect(
      codeOf(await catchAsync(() => aiServiceHandlers.deleteAIProvider({ id: 'ghost' } as never, ctx())))
    ).toBe(Code.NotFound)
  })

  it('reports a locked store as FailedPrecondition rather than crashing', async () => {
    lockStore()
    expect(
      codeOf(await catchAsync(() => aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx())))
    ).toBe(Code.FailedPrecondition)
  })

  it('denies a non-owner when auth is enabled', async () => {
    await loadConfigFromString(AUTH_TOML)
    expect(
      codeOf(
        await catchAsync(() =>
          aiServiceHandlers.createAIProvider({ provider: VALID } as never, ctx({ email: 'member@example.com' }))
        )
      )
    ).toBe(Code.PermissionDenied)
  })
})

describe('listVendorModels gating', () => {
  it('returns [] for vendors with no /models endpoint instead of erroring', async () => {
    expect(await aiServiceHandlers.listVendorModels({ vendor: 'openai' } as never, ctx())).toEqual({ models: [] })
    expect(await aiServiceHandlers.listVendorModels({ vendor: 'anthropic' } as never, ctx())).toEqual({ models: [] })
  })

  it('requires base_url for openai-compatible', async () => {
    expect(
      codeOf(await catchAsync(() => aiServiceHandlers.listVendorModels({ vendor: 'openai-compatible' } as never, ctx())))
    ).toBe(Code.InvalidArgument)
  })

  it('404s for an unknown provider_id', async () => {
    expect(
      codeOf(
        await catchAsync(() =>
          aiServiceHandlers.listVendorModels({ vendor: 'ollama-cloud', providerId: 'ghost' } as never, ctx())
        )
      )
    ).toBe(Code.NotFound)
  })

  it('denies a non-owner when auth is enabled', async () => {
    await loadConfigFromString(AUTH_TOML)
    expect(
      codeOf(
        await catchAsync(() =>
          aiServiceHandlers.listVendorModels({ vendor: 'ollama-cloud' } as never, ctx({ email: 'member@example.com' }))
        )
      )
    ).toBe(Code.PermissionDenied)
  })
})

describe('SettingsService', () => {
  it('reports an unlocked-capable store with no master password yet', async () => {
    const status = await settingsServiceHandlers.getStoreStatus({} as never, ctx())
    expect(status).toMatchObject({ available: true, hasMasterPassword: false, unlocked: false, keyFromEnv: false })
  })

  it('sets a master password and reports unlocked', async () => {
    await settingsServiceHandlers.setMasterPassword({ password: 'master-password' } as never, ctx())
    const status = await settingsServiceHandlers.getStoreStatus({} as never, ctx())
    expect(status).toMatchObject({ hasMasterPassword: true, unlocked: true })
  })

  it('enforces a minimum master password length', async () => {
    expect(
      codeOf(await catchAsync(() => settingsServiceHandlers.setMasterPassword({ password: 'short' } as never, ctx())))
    ).toBe(Code.InvalidArgument)
  })

  it('refuses to set a second master password', async () => {
    await settingsServiceHandlers.setMasterPassword({ password: 'master-password' } as never, ctx())
    expect(
      codeOf(await catchAsync(() => settingsServiceHandlers.setMasterPassword({ password: 'another-one' } as never, ctx())))
    ).toBe(Code.FailedPrecondition)
  })

  it('lock then unlock round-trips', async () => {
    await settingsServiceHandlers.setMasterPassword({ password: 'master-password' } as never, ctx())
    await settingsServiceHandlers.lockStore({} as never, ctx())
    expect(isUnlocked()).toBe(false)

    await settingsServiceHandlers.unlockStore({ password: 'master-password' } as never, ctx())
    expect(isUnlocked()).toBe(true)
  })

  it('rejects a wrong password with PermissionDenied and stays locked', async () => {
    await settingsServiceHandlers.setMasterPassword({ password: 'master-password' } as never, ctx())
    await settingsServiceHandlers.lockStore({} as never, ctx())
    expect(
      codeOf(await catchAsync(() => settingsServiceHandlers.unlockStore({ password: 'wrong-password' } as never, ctx())))
    ).toBe(Code.PermissionDenied)
    expect(isUnlocked()).toBe(false)
  })

  it('denies a non-owner when auth is enabled', async () => {
    await loadConfigFromString(AUTH_TOML)
    expect(
      codeOf(
        await catchAsync(() => settingsServiceHandlers.getStoreStatus({} as never, ctx({ email: 'member@example.com' })))
      )
    ).toBe(Code.PermissionDenied)
  })
})

async function catchAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  } catch (err) {
    return err
  }
}
