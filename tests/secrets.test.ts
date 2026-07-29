import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  encryptSecret,
  decryptSecret,
  generateSalt,
  unlockWithPassword,
  loadKeyFromEnv,
  isUnlocked,
  lock,
  makeKeyCheck,
  verifyKeyCheck,
  SecretsLockedError,
} from '../server/lib/secrets'

const ENV_KEY = 'PGCONSOLE_SECRET_KEY'

describe('secrets', () => {
  beforeEach(() => {
    lock()
    delete process.env[ENV_KEY]
  })
  afterEach(() => {
    lock()
    delete process.env[ENV_KEY]
  })

  describe('locked state', () => {
    it('refuses to encrypt or decrypt with no key configured', () => {
      expect(isUnlocked()).toBe(false)
      expect(() => encryptSecret('hunter2')).toThrow(SecretsLockedError)
      expect(() => decryptSecret('v1:a:b:c')).toThrow(SecretsLockedError)
    })

    it('reports SecretsLockedError by name so callers can branch on it', () => {
      try {
        encryptSecret('x')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect((err as Error).name).toBe('SecretsLockedError')
      }
    })
  })

  describe('round trip', () => {
    beforeEach(() => {
      unlockWithPassword('correct horse battery staple', generateSalt())
    })

    it('round-trips a secret', () => {
      const blob = encryptSecret('p@ssw0rd')
      expect(decryptSecret(blob)).toBe('p@ssw0rd')
    })

    it('round-trips empty strings and unicode', () => {
      expect(decryptSecret(encryptSecret(''))).toBe('')
      expect(decryptSecret(encryptSecret('pä$$—🔐'))).toBe('pä$$—🔐')
    })

    it('emits the v1 four-part format and never the plaintext', () => {
      const blob = encryptSecret('super-secret-value')
      const parts = blob.split(':')
      expect(parts).toHaveLength(4)
      expect(parts[0]).toBe('v1')
      expect(blob).not.toContain('super-secret-value')
    })

    it('uses a fresh nonce, so the same plaintext encrypts differently each time', () => {
      expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
    })

    it('rejects a tampered ciphertext (GCM authentication)', () => {
      const [v, iv, ct, tag] = encryptSecret('trustworthy').split(':')
      // Flip a byte in the ciphertext, keeping it valid base64.
      const raw = Buffer.from(ct, 'base64')
      raw[0] ^= 0xff
      const tampered = [v, iv, raw.toString('base64'), tag].join(':')
      expect(() => decryptSecret(tampered)).toThrow()
    })

    it('rejects an unknown format version', () => {
      expect(() => decryptSecret('v2:a:b:c')).toThrow(/Unrecognized secret format/)
      expect(() => decryptSecret('nonsense')).toThrow(/Unrecognized secret format/)
    })
  })

  describe('key derivation', () => {
    it('derives the same key from the same password and salt', () => {
      const salt = generateSalt()
      unlockWithPassword('pw', salt)
      const blob = encryptSecret('value')

      lock()
      unlockWithPassword('pw', salt)
      expect(decryptSecret(blob)).toBe('value')
    })

    it('a wrong password cannot decrypt', () => {
      const salt = generateSalt()
      unlockWithPassword('right', salt)
      const blob = encryptSecret('value')

      lock()
      unlockWithPassword('wrong', salt)
      expect(() => decryptSecret(blob)).toThrow()
    })

    it('the same password under a different salt yields a different key', () => {
      unlockWithPassword('pw', generateSalt())
      const blob = encryptSecret('value')

      lock()
      unlockWithPassword('pw', generateSalt())
      expect(() => decryptSecret(blob)).toThrow()
    })

    it('rejects an empty master password', () => {
      expect(() => unlockWithPassword('', generateSalt())).toThrow(/must not be empty/)
    })
  })

  describe('key check', () => {
    it('verifies under the right key and fails under the wrong one', () => {
      const salt = generateSalt()
      unlockWithPassword('right', salt)
      const check = makeKeyCheck()
      expect(verifyKeyCheck(check)).toBe(true)

      lock()
      unlockWithPassword('wrong', salt)
      expect(verifyKeyCheck(check)).toBe(false)
    })

    it('returns false rather than throwing when locked or given garbage', () => {
      lock()
      expect(verifyKeyCheck('v1:a:b:c')).toBe(false)
      unlockWithPassword('pw', generateSalt())
      expect(verifyKeyCheck('garbage')).toBe(false)
    })
  })

  describe('PGCONSOLE_SECRET_KEY', () => {
    it('accepts a 64-char hex key', () => {
      process.env[ENV_KEY] = 'a'.repeat(64)
      expect(loadKeyFromEnv()).toBe(true)
      expect(decryptSecret(encryptSecret('v'))).toBe('v')
    })

    it('accepts a base64 32-byte key', () => {
      process.env[ENV_KEY] = Buffer.alloc(32, 7).toString('base64')
      expect(loadKeyFromEnv()).toBe(true)
      expect(isUnlocked()).toBe(true)
    })

    it('returns false when unset, leaving the module locked', () => {
      expect(loadKeyFromEnv()).toBe(false)
      expect(isUnlocked()).toBe(false)
    })

    it('throws on a malformed key instead of silently staying locked', () => {
      process.env[ENV_KEY] = 'too-short'
      expect(() => loadKeyFromEnv()).toThrow(/must be 32 bytes/)
    })

    it('treats whitespace-only as unset', () => {
      process.env[ENV_KEY] = '   '
      expect(loadKeyFromEnv()).toBe(false)
    })
  })
})
