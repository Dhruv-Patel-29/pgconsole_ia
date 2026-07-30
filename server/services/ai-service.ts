import { ConnectError, Code } from '@connectrpc/connect'
import type { ServiceImpl } from '@connectrpc/connect'
import { AIService } from '../../src/gen/ai_connect'
import { getAIProviders, getAIProviderById, type AIProviderConfig } from '../lib/config'
import { buildConnectionDetails, DatabaseNotAllowedError, type ConnectionDetails } from '../lib/db'
import { generateWithVendor, listVendorModels, OLLAMA_CLOUD_BASE_URL, type Vendor } from '../ai/vendors'
import { requireInstanceAdmin } from '../lib/iam'
import { getUserFromContext } from '../lib/rpc-context'
import { createStoredAIProvider, updateStoredAIProvider, deleteStoredAIProvider } from '../lib/store'
import { SecretsLockedError } from '../lib/secrets'
import { auditConfigChange } from '../lib/audit'
import type { AIProviderInput as AIProviderInputMessage } from '../../src/gen/ai_pb'
import { getConnectionInfo } from '../lib/connection-cache'
import { getSchemaCache, refreshSchemaCache } from '../lib/schema-cache'
import { qualifiedName } from '../lib/identifiers'
import {
  TEXT_TO_SQL,
  EXPLAIN_SQL,
  FIX_SQL,
  REWRITE_SQL,
  ASSESS_RISK,
  buildSystemPrompt,
} from '../ai/prompts'

// Helper: Remove markdown code blocks from SQL
function cleanSQLResponse(sql: string): string {
  return sql
    .replace(/^```sql\s*/i, '')  // Remove opening ```sql with any whitespace
    .replace(/^```\s*/, '')       // Remove opening ``` with any whitespace
    .replace(/\s*```\s*$/g, '')   // Remove closing ``` with any surrounding whitespace
    .trim()
}

// Delegates to the shared resolver so the `database` override and its all_databases
// check are enforced identically here and in query-service.
function getConnectionDetails(connectionId: string, database?: string): ConnectionDetails {
  let details: ConnectionDetails | null
  try {
    details = buildConnectionDetails(connectionId, database)
  } catch (err) {
    if (err instanceof DatabaseNotAllowedError) {
      throw new ConnectError(err.message, Code.InvalidArgument)
    }
    throw err
  }
  if (!details) {
    throw new ConnectError('Connection not found', Code.NotFound)
  }
  return details
}

async function getOrRefreshSchema(
  connectionId: string,
  schemas: string[],
  database?: string
): Promise<string> {
  // Resolve first: the cache is keyed by the database actually in use, so the override
  // has to be applied before the lookup, not after.
  const details = getConnectionDetails(connectionId, database)
  let cached = await getSchemaCache(connectionId, details.database, schemas)

  if (!cached) {
    const { version } = getConnectionInfo(connectionId)
    cached = await refreshSchemaCache(connectionId, details, schemas, version)
  }

  return cached.formatted
}

interface ParsedRiskAssessment {
  overallRisk: string
  findings: Array<{ severity: string; category: string; description: string }>
  dependencyGraph: string
}

function parseRiskAssessment(response: string): ParsedRiskAssessment {
  // Extract mermaid code block if present
  let dependencyGraph = ''
  const mermaidMatch = response.match(/```mermaid\n([\s\S]*?)```/)
  if (mermaidMatch) {
    dependencyGraph = mermaidMatch[1].trim()
    // Strip the mermaid block so it doesn't end up in finding descriptions
    response = response.replace(/```mermaid\n[\s\S]*?```/, '').trim()
  }

  const lines = response.trim().split('\n')

  // Extract overall risk from first line
  const firstLine = lines[0].trim().toUpperCase()
  const overallRisk = firstLine.match(/\b(HIGH|MODERATE|LOW)\b/)?.[1] || 'MODERATE'

  // Parse findings by finding ### headers
  const findings: Array<{ severity: string; category: string; description: string }> = []
  let currentFinding: { severity: string; category: string; description: string } | null = null

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const headerMatch = line.match(/^###\s*\[(HIGH|MODERATE|LOW)\]\s*(.+)$/i)

    if (headerMatch) {
      // Save previous finding if exists
      if (currentFinding) {
        findings.push(currentFinding)
      }
      // Start new finding
      currentFinding = {
        severity: headerMatch[1].toLowerCase(),
        category: headerMatch[2].trim(),
        description: ''
      }
    } else if (currentFinding && line.trim()) {
      // Accumulate description lines
      currentFinding.description += (currentFinding.description ? '\n' : '') + line
    }
  }

  // Save last finding
  if (currentFinding) {
    findings.push(currentFinding)
  }

  // If no findings parsed, create a default one
  if (findings.length === 0) {
    findings.push({
      severity: overallRisk.toLowerCase(),
      category: 'Assessment Result',
      description: response.substring(firstLine.length).trim() || 'Risk assessment completed.'
    })
  }

  return { overallRisk: overallRisk.toLowerCase(), findings, dependencyGraph }
}

const MODEL_DISCOVERY_VENDORS: Vendor[] = ['openai-compatible', 'ollama-cloud']
const VALID_VENDORS: Vendor[] = ['openai', 'anthropic', 'google', 'openai-compatible', 'ollama-cloud']
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Shape a merged provider for the wire. The API key itself is never included. */
function toProviderResponse(p: AIProviderConfig) {
  return {
    id: p.id,
    name: p.name ?? p.id,
    vendor: p.vendor,
    model: p.model,
    source: p.source ?? 'toml',
    baseUrl: p.base_url ?? '',
    hasApiKey: p.hasApiKey ?? !!p.api_key,
  }
}

/**
 * Validate provider form input. Mirrors the TOML validation in config.ts so a provider
 * created through the UI is held to the same rules as one written into the file.
 */
function validateProviderInput(provider: AIProviderInputMessage | undefined) {
  if (!provider) {
    throw new ConnectError('provider is required', Code.InvalidArgument)
  }
  const id = provider.id?.trim()
  if (!id) {
    throw new ConnectError('id is required', Code.InvalidArgument)
  }
  if (!ID_RE.test(id)) {
    throw new ConnectError(
      'id must start with a letter or digit and contain only letters, digits, dots, dashes, and underscores',
      Code.InvalidArgument
    )
  }

  const vendor = provider.vendor as Vendor
  if (!VALID_VENDORS.includes(vendor)) {
    throw new ConnectError(
      `Invalid vendor: ${provider.vendor}. Must be one of: ${VALID_VENDORS.join(', ')}`,
      Code.InvalidArgument
    )
  }

  const model = provider.model?.trim()
  if (!model) {
    throw new ConnectError('model is required', Code.InvalidArgument)
  }

  const baseUrl = provider.baseUrl?.trim() || undefined
  if (baseUrl) {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new ConnectError(`base_url is not a valid URL: ${baseUrl}`, Code.InvalidArgument)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConnectError('base_url must use http or https', Code.InvalidArgument)
    }
  }
  if (vendor === 'openai-compatible' && !baseUrl) {
    throw new ConnectError('base_url is required for openai-compatible providers', Code.InvalidArgument)
  }

  // api_key is optional only for openai-compatible, which covers keyless local runtimes.
  // On update, `undefined` means "keep the stored key", so absence isn't necessarily
  // missing — hence the hasApiKey check at the call site for creates.
  return {
    id,
    name: provider.name?.trim() || id,
    vendor,
    model,
    base_url: baseUrl,
    api_key: provider.apiKey,
  }
}

/** Reject mutations aimed at a TOML-defined provider, which the UI must not edit. */
function requireStoreBacked(id: string): void {
  const existing = getAIProviderById(id)
  if (!existing) {
    throw new ConnectError('AI provider not found', Code.NotFound)
  }
  if (existing.source !== 'store') {
    throw new ConnectError(
      `AI provider "${id}" is defined in pgconsole.toml and can only be changed there`,
      Code.FailedPrecondition
    )
  }
}

/** Translate a locked store into a typed error the UI can act on. */
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

export const aiServiceHandlers: ServiceImpl<typeof AIService> = {
  async listVendorModels(req, context) {
    // Gated on the instance owner. An owner can already point base_url at any host via
    // pgconsole.toml, so this grants no authority the config file didn't already — but it
    // must not be reachable by ordinary users, who cannot edit that file.
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'listing vendor models')

    const vendor = req.vendor as Vendor
    if (!MODEL_DISCOVERY_VENDORS.includes(vendor)) {
      // Not an error: the first-party SDK vendors have no discoverable /models endpoint,
      // so the UI falls back to a free-text model field.
      return { models: [] }
    }

    // Prefer a saved provider's stored key so the UI never has to echo one back to us.
    const saved = req.providerId ? getAIProviderById(req.providerId) : undefined
    if (req.providerId && !saved) {
      throw new ConnectError('AI provider not found', Code.NotFound)
    }
    const apiKey = req.apiKey?.trim() || saved?.api_key

    // ollama-cloud pins its own endpoint; only openai-compatible honours a caller URL.
    const baseUrl = vendor === 'ollama-cloud'
      ? OLLAMA_CLOUD_BASE_URL
      : req.baseUrl?.trim() || saved?.base_url
    if (vendor === 'openai-compatible' && !baseUrl) {
      throw new ConnectError('base_url is required for openai-compatible providers', Code.InvalidArgument)
    }

    try {
      return { models: await listVendorModels(vendor, apiKey, baseUrl) }
    } catch (err) {
      // Discovery is best-effort — surface the reason but let the UI degrade to free text.
      const message = err instanceof Error ? err.message : 'Model discovery failed'
      throw new ConnectError(message, Code.Unavailable)
    }
  },

  async createAIProvider(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'creating an AI provider')
    const input = validateProviderInput(req.provider)

    // Validate against the merged namespace so a store row can never shadow, or be
    // shadowed by, a TOML entry.
    if (getAIProviderById(input.id)) {
      throw new ConnectError(`An AI provider with id "${input.id}" already exists`, Code.AlreadyExists)
    }

    const created = withStoreErrors(() =>
      createStoredAIProvider({ ...input, created_by: user?.email })
    )
    auditConfigChange(user?.email, 'ai_provider.create', created.id)
    return { provider: toProviderResponse({ ...created, source: 'store' }) }
  },

  async updateAIProvider(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'updating an AI provider')
    const input = validateProviderInput(req.provider)
    requireStoreBacked(input.id)

    const updated = withStoreErrors(() => updateStoredAIProvider(input.id, input))
    auditConfigChange(user?.email, 'ai_provider.update', updated.id)
    return { provider: toProviderResponse({ ...updated, source: 'store' }) }
  },

  async deleteAIProvider(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'deleting an AI provider')
    if (!req.id) {
      throw new ConnectError('id is required', Code.InvalidArgument)
    }
    requireStoreBacked(req.id)

    deleteStoredAIProvider(req.id)
    auditConfigChange(user?.email, 'ai_provider.delete', req.id)
    return {}
  },

  async testAIProvider(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'testing an AI provider')

    const vendor = req.vendor as Vendor
    if (!VALID_VENDORS.includes(vendor)) {
      throw new ConnectError(`Unknown vendor: ${req.vendor}`, Code.InvalidArgument)
    }
    const saved = req.providerId ? getAIProviderById(req.providerId) : undefined
    if (req.providerId && !saved) {
      throw new ConnectError('AI provider not found', Code.NotFound)
    }

    const model = req.model?.trim() || saved?.model
    if (!model) {
      throw new ConnectError('model is required', Code.InvalidArgument)
    }
    const apiKey = req.apiKey?.trim() || saved?.api_key
    const baseUrl = vendor === 'ollama-cloud'
      ? (req.baseUrl?.trim() || saved?.base_url || OLLAMA_CLOUD_BASE_URL)
      : req.baseUrl?.trim() || saved?.base_url

    const start = Date.now()
    try {
      // Smallest useful round-trip: proves the key, endpoint, and model name all work.
      await generateWithVendor(vendor, apiKey, model, 'Reply with the single word: ok.', 'ok', '', baseUrl)
      return { success: true, error: '', latencyMs: Date.now() - start }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        latencyMs: Date.now() - start,
      }
    }
  },

  async listAIProviders() {
    const providers = getAIProviders()
    return {
      providers: providers.map(toProviderResponse),
    }
  },

  async generateSQL(req) {
    if (!req.connectionId) {
      throw new ConnectError('connection_id is required', Code.InvalidArgument)
    }
    if (!req.providerId) {
      throw new ConnectError('provider_id is required', Code.InvalidArgument)
    }
    if (!req.prompt?.trim()) {
      throw new ConnectError('prompt is required', Code.InvalidArgument)
    }

    const provider = getAIProviderById(req.providerId)
    if (!provider) {
      throw new ConnectError(`AI provider not found: ${req.providerId}`, Code.NotFound)
    }

    try {
      // Skip expensive schema fetch on subsequent messages - session already has context
      const schema = req.sessionId ? null : await getOrRefreshSchema(req.connectionId, req.schemas, req.database)
      const { version } = getConnectionInfo(req.connectionId)

      const systemPrompt = req.sessionId
        ? null
        : buildSystemPrompt(TEXT_TO_SQL.system, schema || '', version)

      const result = await generateWithVendor(
        provider.vendor,
        provider.api_key,
        provider.model,
        systemPrompt,
        TEXT_TO_SQL.user({
          prompt: req.prompt,
          // Sent every turn, since the user can select a different table mid-conversation
          // and the system prompt is only sent once per session.
          focus: req.focusTable
            ? qualifiedName(req.focusSchema || 'public', req.focusTable)
            : '',
        }),
        req.sessionId || '',
        provider.base_url
      )

      return { sql: cleanSQLResponse(result.sql), error: '', sessionId: result.sessionId }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate SQL'
      return { sql: '', error: message, sessionId: '' }
    }
  },

  async explainSQL(req) {
    if (!req.connectionId) {
      throw new ConnectError('connection_id is required', Code.InvalidArgument)
    }
    if (!req.providerId) {
      throw new ConnectError('provider_id is required', Code.InvalidArgument)
    }
    if (!req.sql?.trim()) {
      throw new ConnectError('sql is required', Code.InvalidArgument)
    }

    const provider = getAIProviderById(req.providerId)
    if (!provider) {
      throw new ConnectError(`AI provider not found: ${req.providerId}`, Code.NotFound)
    }

    try {
      // Skip expensive schema fetch on subsequent messages - session already has context
      const schema = req.sessionId ? null : await getOrRefreshSchema(req.connectionId, req.schemas, req.database)
      const { version } = getConnectionInfo(req.connectionId)

      const systemPrompt = req.sessionId
        ? null
        : buildSystemPrompt(EXPLAIN_SQL.system, schema || '', version)

      // For initial request, use the template
      // For follow-up questions (when sessionId exists), pass the message as-is
      const userPrompt = req.sessionId
        ? req.sql
        : EXPLAIN_SQL.user({ sql: req.sql })

      const result = await generateWithVendor(
        provider.vendor,
        provider.api_key,
        provider.model,
        systemPrompt,
        userPrompt,
        req.sessionId || '',
        provider.base_url
      )

      return { explanation: result.sql, error: '', sessionId: result.sessionId }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to explain SQL'
      return { explanation: '', error: message, sessionId: '' }
    }
  },

  async fixSQL(req) {
    if (!req.connectionId) {
      throw new ConnectError('connection_id is required', Code.InvalidArgument)
    }
    if (!req.providerId) {
      throw new ConnectError('provider_id is required', Code.InvalidArgument)
    }
    if (!req.sql?.trim()) {
      throw new ConnectError('sql is required', Code.InvalidArgument)
    }
    if (!req.errorMessage?.trim()) {
      throw new ConnectError('error_message is required', Code.InvalidArgument)
    }

    const provider = getAIProviderById(req.providerId)
    if (!provider) {
      throw new ConnectError(`AI provider not found: ${req.providerId}`, Code.NotFound)
    }

    try {
      const schema = await getOrRefreshSchema(req.connectionId, req.schemas, req.database)
      const { version } = getConnectionInfo(req.connectionId)

      const systemPrompt = buildSystemPrompt(FIX_SQL.system, schema, version)
      const userPrompt = FIX_SQL.user({ sql: req.sql, errorMessage: req.errorMessage })

      const result = await generateWithVendor(
        provider.vendor,
        provider.api_key,
        provider.model,
        systemPrompt,
        userPrompt,
        '',
        provider.base_url
      )

      return { sql: cleanSQLResponse(result.sql), error: '' }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fix SQL'
      return { sql: '', error: message }
    }
  },

  async rewriteSQL(req) {
    if (!req.connectionId) {
      throw new ConnectError('connection_id is required', Code.InvalidArgument)
    }
    if (!req.providerId) {
      throw new ConnectError('provider_id is required', Code.InvalidArgument)
    }
    if (!req.sql?.trim()) {
      throw new ConnectError('sql is required', Code.InvalidArgument)
    }

    const provider = getAIProviderById(req.providerId)
    if (!provider) {
      throw new ConnectError(`AI provider not found: ${req.providerId}`, Code.NotFound)
    }

    try {
      const schema = await getOrRefreshSchema(req.connectionId, req.schemas, req.database)
      const { version } = getConnectionInfo(req.connectionId)

      const systemPrompt = buildSystemPrompt(REWRITE_SQL.system, schema, version)
      const userPrompt = REWRITE_SQL.user({ sql: req.sql })

      const result = await generateWithVendor(
        provider.vendor,
        provider.api_key,
        provider.model,
        systemPrompt,
        userPrompt,
        '',
        provider.base_url
      )

      return { sql: cleanSQLResponse(result.sql), error: '' }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to rewrite SQL'
      return { sql: '', error: message }
    }
  },

  async refreshSchemaCache(req) {
    if (!req.connectionId) {
      throw new ConnectError('connection_id is required', Code.InvalidArgument)
    }

    try {
      const details = getConnectionDetails(req.connectionId, req.database)
      const { version } = getConnectionInfo(req.connectionId)

      await refreshSchemaCache(req.connectionId, details, req.schemas, version)

      return { success: true, error: '' }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to refresh schema cache'
      return { success: false, error: message }
    }
  },

  async assessChangeRisk(req) {
    if (!req.connectionId) {
      throw new ConnectError('connection_id is required', Code.InvalidArgument)
    }
    if (!req.providerId) {
      throw new ConnectError('provider_id is required', Code.InvalidArgument)
    }
    if (!req.sqlStatements || req.sqlStatements.length === 0) {
      throw new ConnectError('sql_statements is required', Code.InvalidArgument)
    }

    const provider = getAIProviderById(req.providerId)
    if (!provider) {
      throw new ConnectError(`AI provider not found: ${req.providerId}`, Code.NotFound)
    }

    try {
      const schema = await getOrRefreshSchema(req.connectionId, req.schemas, req.database)

      const systemPrompt = buildSystemPrompt(ASSESS_RISK.system, schema)
      const userPrompt = ASSESS_RISK.user({ sqlStatements: req.sqlStatements.join('\n\n') })

      const result = await generateWithVendor(
        provider.vendor,
        provider.api_key,
        provider.model,
        systemPrompt,
        userPrompt,
        '',
        provider.base_url
      )

      // Note: result.sql contains the assessment text, not SQL
      const parsed = parseRiskAssessment(result.sql)

      return {
        overallRisk: parsed.overallRisk,
        findings: parsed.findings,
        error: '',
        dependencyGraph: parsed.dependencyGraph,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to assess change risk'
      return { overallRisk: '', findings: [], error: message, dependencyGraph: '' }
    }
  },
}
