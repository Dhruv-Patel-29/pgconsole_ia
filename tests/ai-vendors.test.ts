import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveBaseUrl, listVendorModels, OLLAMA_CLOUD_BASE_URL } from '../server/ai/vendors'
import { loadConfigFromString, getAIProviders, getAIProviderById } from '../server/lib/config'

describe('resolveBaseUrl', () => {
  it('defaults ollama-cloud to the Ollama Cloud endpoint', () => {
    expect(resolveBaseUrl('ollama-cloud')).toBe(OLLAMA_CLOUD_BASE_URL)
    expect(OLLAMA_CLOUD_BASE_URL).toBe('https://ollama.com/v1')
  })

  it('lets an explicit base_url override the ollama-cloud default', () => {
    expect(resolveBaseUrl('ollama-cloud', 'https://proxy.internal/v1')).toBe('https://proxy.internal/v1')
  })

  it('returns the given base_url for openai-compatible, null when absent', () => {
    expect(resolveBaseUrl('openai-compatible', 'http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(resolveBaseUrl('openai-compatible')).toBeNull()
  })

  it('returns null for first-party SDK vendors, which manage their own endpoints', () => {
    expect(resolveBaseUrl('openai')).toBeNull()
    expect(resolveBaseUrl('anthropic')).toBeNull()
    expect(resolveBaseUrl('google')).toBeNull()
  })
})

describe('listVendorModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(body: unknown, ok = true, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: ok ? 'OK' : 'Unauthorized',
      json: async () => body,
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('parses the OpenAI { data: [{ id }] } shape', async () => {
    stubFetch({ data: [{ id: 'gpt-oss:120b' }, { id: 'deepseek-v3.1:671b' }] })
    const models = await listVendorModels('ollama-cloud', 'key')
    expect(models).toEqual(['deepseek-v3.1:671b', 'gpt-oss:120b'])
  })

  it('parses a bare array of objects and of strings', async () => {
    stubFetch([{ id: 'b' }, { id: 'a' }])
    expect(await listVendorModels('ollama-cloud', 'key')).toEqual(['a', 'b'])

    stubFetch(['z', 'y'])
    expect(await listVendorModels('ollama-cloud', 'key')).toEqual(['y', 'z'])
  })

  it('dedupes, sorts, and drops non-string ids', async () => {
    stubFetch({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: 42 }, {}, { id: '' }] })
    expect(await listVendorModels('ollama-cloud', 'key')).toEqual(['a', 'b'])
  })

  it('hits {base_url}/models and sends the API key as a bearer token', async () => {
    const fetchMock = stubFetch({ data: [] })
    await listVendorModels('ollama-cloud', 'secret-key')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ollama.com/v1/models')
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-key' })
  })

  it('omits the Authorization header for keyless local providers', async () => {
    const fetchMock = stubFetch({ data: [] })
    await listVendorModels('openai-compatible', undefined, 'http://localhost:11434/v1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/v1/models')
    expect(init.headers).toEqual({})
  })

  it('does not double up the slash when base_url has a trailing one', async () => {
    const fetchMock = stubFetch({ data: [] })
    await listVendorModels('openai-compatible', undefined, 'http://localhost:11434/v1/')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/models')
  })

  it('returns [] without fetching for vendors that have no /models endpoint', async () => {
    const fetchMock = stubFetch({ data: [{ id: 'nope' }] })
    expect(await listVendorModels('openai', 'key')).toEqual([])
    expect(await listVendorModels('anthropic', 'key')).toEqual([])
    expect(await listVendorModels('openai-compatible', 'key')).toEqual([])  // no base_url
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws with the status when the provider rejects the request', async () => {
    stubFetch({}, false, 401)
    await expect(listVendorModels('ollama-cloud', 'bad-key')).rejects.toThrow(/401 Unauthorized/)
  })
})

describe('ollama-cloud provider config', () => {
  it('accepts a provider with only model and api_key, defaulting base_url', async () => {
    await loadConfigFromString(`
[[ai.providers]]
id = "ollama"
name = "Ollama GPT-OSS"
vendor = "ollama-cloud"
model = "gpt-oss:120b"
api_key = "ollama-key"
`)
    const provider = getAIProviderById('ollama')
    expect(provider).toMatchObject({ vendor: 'ollama-cloud', model: 'gpt-oss:120b', api_key: 'ollama-key' })
    // base_url is left unset so the vendor layer applies the default at call time.
    expect(provider?.base_url).toBeUndefined()
    expect(resolveBaseUrl('ollama-cloud', provider?.base_url)).toBe(OLLAMA_CLOUD_BASE_URL)
  })

  it('accepts an explicit base_url override', async () => {
    await loadConfigFromString(`
[[ai.providers]]
id = "ollama"
vendor = "ollama-cloud"
model = "gpt-oss:120b"
api_key = "k"
base_url = "https://proxy.internal/v1"
`)
    expect(getAIProviderById('ollama')?.base_url).toBe('https://proxy.internal/v1')
  })

  it('requires an api_key, unlike keyless local openai-compatible', async () => {
    await expect(loadConfigFromString(`
[[ai.providers]]
id = "ollama"
vendor = "ollama-cloud"
model = "gpt-oss:120b"
`)).rejects.toThrow(/missing required field: api_key/)
  })

  it('rejects a non-http base_url', async () => {
    await expect(loadConfigFromString(`
[[ai.providers]]
id = "ollama"
vendor = "ollama-cloud"
model = "gpt-oss:120b"
api_key = "k"
base_url = "ftp://nope"
`)).rejects.toThrow(/must use http or https/)
  })

  it('still rejects an unknown vendor', async () => {
    await expect(loadConfigFromString(`
[[ai.providers]]
id = "x"
vendor = "ollama"
model = "m"
api_key = "k"
`)).rejects.toThrow(/invalid vendor: ollama/)
  })

  it('keeps keyless local Ollama working via openai-compatible', async () => {
    await loadConfigFromString(`
[[ai.providers]]
id = "local"
vendor = "openai-compatible"
model = "llama3.3"
base_url = "http://localhost:11434/v1"
`)
    expect(getAIProviders()[0]).toMatchObject({ vendor: 'openai-compatible', api_key: undefined })
  })
})
