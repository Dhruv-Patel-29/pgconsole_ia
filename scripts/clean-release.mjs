#!/usr/bin/env node
/**
 * Remove the `release/` directory before packaging.
 *
 * electron-builder fails with EPERM or EEXIST if artifacts from a previous run are still
 * there, so this clears them first. It replaces an inline `try { rmSync() } catch {}`, which
 * swallowed the failure: on Windows the delete fails whenever anything holds a handle on
 * those files — a running InfoAnalytica instance, Explorer, an antivirus scan — and a silent
 * catch turned that into a confusing electron-builder error several minutes later instead of
 * an actionable one now.
 *
 * Windows file locks are frequently transient (an AV scan finishing, a window closing), so
 * this retries briefly before giving up, and when it does give up it names the path that is
 * locked and exits non-zero so the build stops here rather than half-way through packaging.
 */

import { existsSync, rmSync, readdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = resolve(ROOT, 'release')

const ATTEMPTS = 5
const BACKOFF_MS = 400

/** Busy-wait, because this is a short synchronous script and a sleep needs no async plumbing. */
function pause(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) { /* spin */ }
}

/** First file under `dir` that cannot be opened for writing — the likely lock holder. */
function findLockedPath(dir) {
  let found = null
  const walk = (p) => {
    if (found) return
    let entries
    try {
      entries = readdirSync(p, { withFileTypes: true })
    } catch (err) {
      found = `${p} (${err.code})`
      return
    }
    for (const e of entries) {
      if (found) return
      const child = join(p, e.name)
      if (e.isDirectory()) walk(child)
      else {
        try {
          statSync(child)
        } catch (err) {
          found = `${child} (${err.code})`
        }
      }
    }
  }
  walk(dir)
  return found
}

if (!existsSync(TARGET)) {
  console.log('release/ is already clean')
  process.exit(0)
}

let lastError
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    rmSync(TARGET, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    console.log(`removed release/${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    process.exit(0)
  } catch (err) {
    lastError = err
    if (attempt < ATTEMPTS) {
      console.log(`  release/ is locked (${err.code}), retrying ${attempt}/${ATTEMPTS - 1}…`)
      pause(BACKOFF_MS * attempt)
    }
  }
}

const locked = findLockedPath(TARGET)
console.error(
  `\nCould not remove release/: ${lastError.code} ${lastError.message}\n` +
    (locked ? `\nSomething is holding: ${locked}\n` : '\n') +
    `On Windows this means a file in there is open. Usually one of:\n` +
    `  - InfoAnalytica is still running (check the tray and Task Manager)\n` +
    `  - an installer or the portable .exe from a previous build is open\n` +
    `  - Explorer has release/ or a subfolder selected\n` +
    `  - antivirus is scanning the freshly-written .exe\n\n` +
    `Close it and re-run. Deleting release/ by hand works too.\n`
)
process.exit(1)
