import path from 'path'
// Aliased for the same reason as nodeCreateRequire below: the esbuild banner already
// declares a top-level `fileURLToPath`, and a second declaration of that name is a
// SyntaxError at load time.
import { fileURLToPath as toFilePath } from 'url'
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

/**
 * Pin the app name before asking for any path, because userData is derived from it.
 *
 * Left to itself Electron picks the name from the nearest package.json, which gives two
 * wrong answers: running the entry file directly finds no package.json and falls back to
 * "Electron" (so the store would land in ~/.config/Electron, shared with every other
 * unpackaged Electron app on the machine), and the packaged app finds our scoped npm name
 * and yields %APPDATA%\@pgplex\pgconsole. Setting it explicitly makes both cases agree with
 * electron-builder's productName and with the documented location.
 */
app.setName('pgconsole')

// Keep pgconsole.db in Electron's per-user data directory (on Windows,
// %APPDATA%\pgconsole) instead of the CLI's ~/.config location.
process.env.PGCONSOLE_DATA_DIR ??= app.getPath('userData')

// The bundled main process lives in electron/dist/, so the server's default
// `__dirname/client` would miss the built SPA in dist/client.
//
// Resolved relative to this bundle rather than app.getAppPath(), which is only the project
// root when a directory is passed to electron — running the entry file directly (as
// `pnpm electron:dev` does) makes it electron/dist and yields dist/dist/client. The layout
// electron/dist/main.mjs → ../../dist/client holds both from source and inside app.asar,
// since electron-builder preserves both paths.
const bundleDir = path.dirname(toFilePath(import.meta.url))
process.env.PGCONSOLE_CLIENT_DIR ??= path.resolve(bundleDir, '..', '..', 'dist', 'client')
