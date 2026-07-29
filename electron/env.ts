import path from 'path'
import { createRequire as nodeCreateRequire } from 'module'

/**
 * `require('electron')` rather than a named ESM import.
 *
 * Electron 28+ runs the main process through Node's ESM loader, but `electron` itself is a
 * CJS builtin, so `import { app } from 'electron'` depends on named-export interop that
 * varies by loader. require() is the path Electron has always supported, and the `as
 * typeof import('electron')` cast keeps full type checking.
 */
// Locally named to avoid colliding with the `require`/`createRequire` that the esbuild
// banner in scripts/build-electron.mjs injects into the bundle.
const requireCjs = nodeCreateRequire(import.meta.url)
const { app } = requireCjs('electron') as typeof import('electron')

/**
 * Environment that must be in place before the server module is evaluated.
 *
 * main.ts imports this file *before* importing the server. ES module evaluation follows
 * import order, so these assignments run first — which matters because server/index.ts
 * checks PGCONSOLE_EMBEDDED at module scope to decide whether to self-start as a CLI.
 */

// Suppress the CLI's self-start; Electron calls startServer() explicitly.
process.env.PGCONSOLE_EMBEDDED = '1'

// Keep pgconsole.db in Electron's per-user data directory (on Windows,
// %APPDATA%\pgconsole) instead of the CLI's ~/.config location.
process.env.PGCONSOLE_DATA_DIR ??= app.getPath('userData')

// The bundled main process lives in electron/dist/, so the server's default
// `__dirname/client` would miss the built SPA in dist/client. app.getAppPath() is the
// app root both when packaged (…/resources/app.asar) and when run from source.
process.env.PGCONSOLE_CLIENT_DIR ??= path.join(app.getAppPath(), 'dist', 'client')
