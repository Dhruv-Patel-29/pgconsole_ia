import { describe, it, expect, beforeAll } from 'vitest'
import http from 'node:http'

/**
 * The desktop app awaits close() inside Electron's `will-quit` after calling
 * preventDefault(), so a close() that never settles leaves the process running with no
 * window — invisible except in Task Manager, and holding the single-instance lock against
 * the next launch. http.Server#close() only stops accepting *new* connections; its callback
 * waits for every open one to end, and the renderer holds keep-alive sockets open for its
 * whole lifetime.
 */

// server/index.ts self-starts as a CLI on import unless this is set, which would boot a
// whole demo database as a side effect of importing it here.
process.env.PGCONSOLE_EMBEDDED = '1'

let startServer: typeof import('../server/index')['startServer']

beforeAll(async () => {
  ;({ startServer } = await import('../server/index'))
})

/**
 * Starts a request and never finishes sending it, so the server sits waiting on the body.
 *
 * An *idle* keep-alive socket isn't enough to reproduce the hang — Node closes those itself
 * on close(). It takes a connection with a request in flight, which is what a streaming AI
 * response or an open MCP session looks like.
 */
function openInFlightRequest(url: string): Promise<http.ClientRequest> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname,
      port,
      path: '/',
      method: 'POST',
      headers: { 'transfer-encoding': 'chunked', 'content-type': 'application/json' },
    })
    req.on('error', () => {
      /* the socket is torn down by the shutdown under test */
    })
    req.on('socket', (socket) => {
      socket.on('connect', () => {
        // A chunk, but never the terminating one.
        req.write('{"partial":')
        resolve(req)
      })
      if (!socket.connecting) {
        req.write('{"partial":')
        resolve(req)
      }
    })
    setTimeout(() => reject(new Error('never connected')), 5_000)
  })
}

describe('startServer close()', () => {
  it('resolves while a request is still in flight', async () => {
    const server = await startServer({ port: 0, host: '127.0.0.1', throwOnError: true })
    const req = await openInFlightRequest(server.url)

    const outcome = await Promise.race([
      server.close().then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 4_000)),
    ])
    req.destroy()
    expect(outcome).toBe('closed')
  }, 15_000)

  it('resolves with no connections at all', async () => {
    const server = await startServer({ port: 0, host: '127.0.0.1', throwOnError: true })
    const outcome = await Promise.race([
      server.close().then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 4_000)),
    ])
    expect(outcome).toBe('closed')
  }, 15_000)
})
