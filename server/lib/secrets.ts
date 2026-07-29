import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'crypto'

/**
 * At-rest encryption for store-backed secrets (connection passwords, AI provider API
 * keys). TOML-configured secrets are not touched — that file is the operator's own.
 *
 * The key comes from one of two places, checked in order:
 *   1. PGCONSOLE_SECRET_KEY — a 32-byte key, hex or base64. For headless, Docker, CI.
 *   2. A master password, stretched with scrypt against a per-install salt. This is the
 *      desktop path, and mirrors how pgAdmin gates saved server passwords.
 *
 * With neither configured the module stays locked: rows may still be written, but
 * without their secret columns, and any attempt to store one raises SecretsLockedError
 * so the UI can prompt instead of silently persisting a plaintext credential.
 */

const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12       // 96-bit nonce, the GCM standard
const SALT_BYTES = 16

// scrypt cost. 128 * N * r bytes of memory => 32 MiB here, so maxmem must be raised
// above Node's 32 MiB default or scryptSync throws.
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 64 * 1024 * 1024

const KEY_CHECK_PLAINTEXT = 'pgconsole-key-check'

export class SecretsLockedError extends Error {
  constructor() {
    super('No encryption key configured. Set a master password (or PGCONSOLE_SECRET_KEY) before saving credentials.')
    this.name = 'SecretsLockedError'
  }
}

export class WrongMasterPasswordError extends Error {
  constructor() {
    super('Incorrect master password.')
    this.name = 'WrongMasterPasswordError'
  }
}

let activeKey: Buffer | null = null

/** Parse a 32-byte key from hex or base64. Returns null if it isn't either. */
function parseRawKey(value: string): Buffer | null {
  const trimmed = value.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  try {
    const buf = Buffer.from(trimmed, 'base64')
    return buf.length === KEY_BYTES ? buf : null
  } catch {
    return null
  }
}

/**
 * Adopt PGCONSOLE_SECRET_KEY if it is set. Returns true if a key was adopted.
 * Throws when the variable is set but malformed — a silent fallback to "locked" would
 * look like a lost key to an operator who believes they configured one.
 */
export function loadKeyFromEnv(): boolean {
  const raw = process.env.PGCONSOLE_SECRET_KEY
  if (!raw?.trim()) return false
  const key = parseRawKey(raw)
  if (!key) {
    throw new Error('PGCONSOLE_SECRET_KEY must be 32 bytes, encoded as 64 hex characters or base64')
  }
  activeKey = key
  return true
}

export function generateSalt(): string {
  return randomBytes(SALT_BYTES).toString('base64')
}

/** Stretch a master password into the active key. */
export function unlockWithPassword(password: string, saltB64: string): void {
  if (!password) throw new Error('Master password must not be empty')
  const salt = Buffer.from(saltB64, 'base64')
  activeKey = scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
}

export function isUnlocked(): boolean {
  return activeKey !== null
}

/** Drop the in-memory key. Used on lock and by tests. */
export function lock(): void {
  activeKey = null
}

export function encryptSecret(plaintext: string): string {
  if (!activeKey) throw new SecretsLockedError()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', activeKey, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), ct.toString('base64'), tag.toString('base64')].join(':')
}

export function decryptSecret(blob: string): string {
  if (!activeKey) throw new SecretsLockedError()
  const parts = blob.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`Unrecognized secret format (expected ${VERSION})`)
  }
  const [, ivB64, ctB64, tagB64] = parts
  const decipher = createDecipheriv('aes-256-gcm', activeKey, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  // GCM authentication failure surfaces here as a throw, which is what makes a wrong
  // key detectable at all.
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}

/**
 * A known plaintext sealed under the active key, stored in meta. Lets a wrong master
 * password be rejected up front rather than surfacing later as decryption failures on
 * whichever row the user happened to touch first.
 */
export function makeKeyCheck(): string {
  return encryptSecret(KEY_CHECK_PLAINTEXT)
}

export function verifyKeyCheck(blob: string): boolean {
  try {
    const got = Buffer.from(decryptSecret(blob), 'utf8')
    const want = Buffer.from(KEY_CHECK_PLAINTEXT, 'utf8')
    return got.length === want.length && timingSafeEqual(got, want)
  } catch {
    return false
  }
}
