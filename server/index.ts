import path from 'path'
import express from 'express'
import cookieParser from 'cookie-parser'
import { authRouter } from './auth-routes'
import { connectRouter } from './connect'
import { mcpRouter, MCP_PATH } from './mcp'
import { loadConfig, loadConfigFromString, loadDemoConfig, isDemoMode, getBanner, getBranding, getExternalUrl, getAgents, isAuthEnabled, getIAMRules } from './lib/config'
import { startDemoDatabase, stopDemoDatabase } from './lib/demo'
import { testAllConnections } from './lib/test-connections'
import { migrate, closeStore, initSecretsFromEnv, hasMasterPassword, resolveDataDir } from './lib/store'

// __dirname is provided by esbuild banner
declare const __dirname: string
// Injected by esbuild define
declare const __APP_VERSION__: string
declare const __DEV__: boolean
const app = express()

// node:sqlite is still flagged experimental in Node 22. We depend on it deliberately
// (see server/lib/store.ts), so drop just that warning instead of running with
// --no-warnings, which would hide genuine ones. Every other warning still prints.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return
  console.warn(warning.stack ?? `${warning.name}: ${warning.message}`)
})

// Parse command line arguments
function parseArgs(): { config?: string; port?: string } {
  const args = process.argv.slice(2)
  const result: { config?: string; port?: string } = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      result.config = args[i + 1]
    } else if (args[i] === '--port' && args[i + 1]) {
      result.port = args[i + 1]
    }
  }
  return result
}

app.use(express.json())
app.use(cookieParser())

app.use('/api/auth', authRouter)
app.use(mcpRouter)
app.use(connectRouter)

// Public settings endpoint (no auth required)
app.get('/api/setting', (_req, res) => {
  res.json({
    banner: getBanner(),
    branding: getBranding(),
    demo: isDemoMode(),
  })
})

// Serve frontend static files in production.
// PGCONSOLE_CLIENT_DIR lets an embedder point elsewhere: the Electron bundle lives in
// electron/dist/, so __dirname there is not the directory holding the built client.
const clientDir = process.env.PGCONSOLE_CLIENT_DIR || path.join(__dirname, 'client')
app.use(express.static(clientDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm')
    }
  }
}))

// SPA fallback - serve index.html for non-API routes
app.use((req, res, next) => {
  // Skip API routes and non-GET requests
  if (req.method !== 'GET' ||
      req.path.startsWith('/api/') ||
      req.path.startsWith('/connection.v1.') ||
      req.path.startsWith('/query.v1.') ||
      req.path.startsWith('/ai.v1.') ||
      req.path.startsWith('/settings.v1.')) {
    return next()
  }
  res.sendFile(path.join(clientDir, 'index.html'))
})

export interface StartOptions {
  /** Port to listen on. 0 asks the OS for a free one, which is what the desktop app uses. */
  port?: number | string
  /** Interface to bind. The desktop app binds loopback so nothing is exposed on the network. */
  host?: string
  /** Path to a pgconsole.toml. Omit to fall back to PGCONSOLE_CONFIG or demo mode. */
  configPath?: string
  /**
   * Throw instead of calling process.exit on a fatal startup error. Electron needs this —
   * exiting the process from inside the main process would kill the window with no message.
   */
  throwOnError?: boolean
}

export interface RunningServer {
  port: number
  url: string
  close: () => Promise<void>
}

/** Fatal startup failure: exit for the CLI, throw for an embedder like Electron. */
function fail(message: string, throwOnError: boolean): never {
  if (throwOnError) throw new Error(message)
  console.error(message)
  process.exit(1)
}

/**
 * Load config, open the store, test connections, and listen. Shared by the CLI entry
 * point below and by the Electron main process, so the desktop app runs exactly the same
 * server rather than a parallel implementation.
 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const throwOnError = options.throwOnError ?? false
  const host = options.host
  const port = options.port ?? process.env.PORT ?? 9876
  const configPath = options.configPath

  if (configPath || process.env.PGCONSOLE_CONFIG) {
    try {
      if (configPath) {
        await loadConfig(configPath)
        console.log(`✓ Loaded config from: ${path.resolve(configPath)}`)
      } else {
        await loadConfigFromString(process.env.PGCONSOLE_CONFIG!)
        console.log('✓ Loaded config from PGCONSOLE_CONFIG environment variable')
      }
    } catch (error) {
      fail(`Failed to load config: ${error instanceof Error ? error.message : error}`, throwOnError)
    }
  } else if (options.host) {
    // Desktop mode with no config file: start with no TOML connections at all, so the
    // user adds them from the UI. Demo mode would be surprising in a desktop app.
    await loadConfigFromString('')
    console.log('No config file — connections are managed from the UI')
  } else {
    console.log('No --config specified — starting in demo mode...')
    const demoPort = await startDemoDatabase()
    loadDemoConfig(demoPort)
    console.log(`✓ Demo database started on port ${demoPort}`)
  }

  // Open the UI-managed config store (connections and AI providers added from the
  // frontend). This layers on top of pgconsole.toml rather than replacing it, so a
  // TOML-only deployment behaves exactly as before.
  try {
    migrate()
    console.log(`✓ Store ready at ${resolveDataDir()}`)
    if (initSecretsFromEnv()) {
      console.log('✓ Secret encryption key loaded from PGCONSOLE_SECRET_KEY')
    } else if (hasMasterPassword()) {
      console.log('○ Store is locked — unlock with the master password to use saved credentials')
    }
  } catch (error) {
    fail(`Failed to open config store: ${error instanceof Error ? error.message : error}`, throwOnError)
  }

  // IAM is opt-in: with no [[iam]] rules, every authenticated principal gets full
  // access. Warn so an empty IAM section with auth enabled isn't a silent misconfig.
  if (isAuthEnabled() && getIAMRules().length === 0) {
    console.warn(
      '⚠ Auth is enabled but no [[iam]] rules are configured — every authenticated user and agent has full access to all connections. Add [[iam]] rules to restrict access.',
    )
  }

  // Test all connections to populate cache. Only TOML connections are eager, so a
  // UI-added connection that happens to be down can never block startup.
  try {
    await testAllConnections()
  } catch (error) {
    fail(`\nConnection test failed: ${error instanceof Error ? error.message : error}`, throwOnError)
  }

  // Two explicit calls rather than a spread: express's listen overloads don't accept a
  // spread tuple followed by a callback.
  const onListening = () => {
    console.log(`
                                                      ___
                                                     /\\_ \\
 _____      __     ___    ___     ___     ____    ___\\//\\ \\      __
/\\ '__\`\\  /'_ \`\\  /'___\\ / __\`\\ /' _ \`\\  /',__\\  / __\`\\\\ \\ \\   /'__\`\\
\\ \\ \\L\\ \\/\\ \\L\\ \\/\\ \\__//\\ \\L\\ \\/\\ \\/\\ \\/\\__, \`\\/\\ \\L\\ \\\\_\\ \\_/\\  __/
 \\ \\ ,__/\\ \\____ \\ \\____\\ \\____/\\ \\_\\ \\_\\/\\____/\\ \\____//\\____\\ \\____\\
  \\ \\ \\/  \\/___L\\ \\/____/\\/___/  \\/_/\\/_/\\/___/  \\/___/ \\/____/\\/____/
   \\ \\_\\    /\\____/
    \\/_/    \\_/__/

    Version ${__APP_VERSION__}
`)
    // With port 0 the OS picks the port, so read it back rather than echoing the request.
    const actual = (server.address() as { port: number } | null)?.port ?? Number(port)
    console.log(`Server running on http://localhost:${actual}`)
    const browserUrl = __DEV__ ? `http://localhost:5173` : getExternalUrl() || `http://localhost:${actual}`
    console.log(`Open in browser: ${browserUrl}`)
    // MCP endpoint is always mounted, but rejects every request without a bearer
    // token matching a configured agent — so it's only usable once [[agents]] exist.
    const agentCount = getAgents().length
    const mcpStatus = agentCount > 0
      ? `${agentCount} agent${agentCount === 1 ? '' : 's'}`
      : 'no agents — add [[agents]] to connect'
    const mcpBaseUrl = getExternalUrl() || `http://localhost:${actual}`
    console.log(`MCP server on ${mcpBaseUrl}${MCP_PATH} (${mcpStatus})`)
  }

  const server = host
    ? app.listen(Number(port), host, onListening)
    : app.listen(Number(port), onListening)

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', (err: NodeJS.ErrnoException) => {
      const message = err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use.`
        : `Error starting server: ${err.message}`
      if (throwOnError) {
        reject(new Error(message))
      } else {
        console.error(`Error: ${message}`)
        process.exit(1)
      }
    })
  })

  const actualPort = (server.address() as { port: number } | null)?.port ?? Number(port)

  const close = async () => {
    try {
      if (isDemoMode()) await stopDemoDatabase()
      closeStore()
    } catch { /* best-effort cleanup */ }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return {
    port: actualPort,
    url: `http://${host ?? 'localhost'}:${actualPort}`,
    close,
  }
}

/** CLI entry point. Kept separate so importing this module doesn't start a server. */
async function main() {
  const args = parseArgs()
  const server = await startServer({ port: args.port, configPath: args.config })

  const shutdown = async () => {
    console.log('\nShutting down...')
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// Only self-start when run as the CLI. Electron imports startServer() instead.
if (!process.env.PGCONSOLE_EMBEDDED) {
  main()
}
