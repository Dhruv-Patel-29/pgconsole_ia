// Must come first: sets PGCONSOLE_EMBEDDED before the server module is evaluated.
import './env'
import { createRequire as nodeCreateRequire } from 'module'
import { startServer, type RunningServer } from '../server/index'
import type { BrowserWindow as BrowserWindowInstance } from 'electron'

// require() rather than a named ESM import — see the note in env.ts. Locally named to
// avoid colliding with the `require` the esbuild banner injects.
const requireCjs = nodeCreateRequire(import.meta.url)
const { app, BrowserWindow, Menu, shell, dialog } = requireCjs('electron') as typeof import('electron')

/**
 * Electron main process for the pgconsole desktop app.
 *
 * The Express server runs in *this* process rather than as a child, so there's one
 * lifecycle to manage and no port handshake. The renderer is an ordinary web client
 * talking HTTP to 127.0.0.1, which means it needs no node integration and no preload
 * bridge — and notably no IPC layer for the SQLite store, since the store lives on the
 * server side of that HTTP boundary.
 */

/** How long to wait for a graceful server shutdown before quitting anyway. */
const SHUTDOWN_TIMEOUT_MS = 3_000

let mainWindow: BrowserWindowInstance | null = null
let runningServer: RunningServer | null = null

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' as const },
          { role: 'forceReload' as const },
          { role: 'toggleDevTools' as const },
          { type: 'separator' as const },
          { role: 'resetZoom' as const },
          { role: 'zoomIn' as const },
          { role: 'zoomOut' as const },
          { type: 'separator' as const },
          { role: 'togglefullscreen' as const },
        ],
      },
      {
        role: 'help',
        submenu: [
          {
            label: 'Documentation',
            click: () => shell.openExternal('https://docs.pgconsole.com'),
          },
        ],
      },
    ])
  )
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    title: 'pgconsole',
    webPreferences: {
      // The renderer is untrusted-by-default web content that talks to a local HTTP
      // server. It needs no Node access, so don't grant any.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Anything aiming at another origin (docs links) opens in the real browser, never in
  // an app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault()
      shell.openExternal(target)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(url)
}

/**
 * The config store depends on `node:sqlite`, which needs the bundled Node to be >= 22.5.
 * Electron 38+ satisfies that, but an Electron downgrade would otherwise fail deep inside
 * migrate() with an opaque module-not-found. Fail loudly and early instead.
 */
async function assertSqliteAvailable(): Promise<void> {
  try {
    await import('node:sqlite')
  } catch {
    throw new Error(
      `This build of Electron bundles Node ${process.versions.node}, which has no ` +
        `node:sqlite module. pgconsole needs Node 22.5 or newer (Electron 38+).`
    )
  }
}

async function boot(): Promise<void> {
  try {
    await assertSqliteAvailable()
    // Port 0 lets the OS assign a free port; binding loopback keeps the server off the
    // network. A config file is optional — connections are managed from the UI.
    runningServer = await startServer({
      port: 0,
      host: '127.0.0.1',
      configPath: process.env.PGCONSOLE_CONFIG_PATH,
      throwOnError: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('pgconsole failed to start', message)
    app.quit()
    return
  }

  buildMenu()
  createWindow(runningServer.url)
}

// Single instance: a second launch focuses the existing window instead of starting a
// second server against the same store.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(boot)

  app.on('window-all-closed', () => {
    // macOS convention keeps the app alive with no windows; every other platform quits.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && runningServer) {
      createWindow(runningServer.url)
    }
  })

  // Close the store and any demo database before the process goes away.
  app.on('will-quit', async (event) => {
    if (!runningServer) return
    const server = runningServer
    runningServer = null
    event.preventDefault()
    try {
      // preventDefault() means nothing else will quit the app, so a close() that never
      // settles would leave the process alive with no window — invisible except in Task
      // Manager, and it would hold the single-instance lock against the next launch.
      // Cleanup is best-effort; exiting is not.
      await Promise.race([
        server.close(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ])
    } finally {
      app.quit()
    }
  })
}
