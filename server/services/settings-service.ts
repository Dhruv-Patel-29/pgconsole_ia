import { ConnectError, Code } from '@connectrpc/connect'
import type { ServiceImpl } from '@connectrpc/connect'
import { SettingsService } from '../../src/gen/settings_connect'
import { getUserFromContext } from '../lib/rpc-context'
import { requireInstanceAdmin } from '../lib/iam'
import {
  isStoreOpen,
  hasMasterPassword,
  setMasterPassword,
  unlockStore,
  lockStore,
  isUnlocked,
  isKeyFromEnv,
} from '../lib/store'
import { WrongMasterPasswordError } from '../lib/secrets'

const MIN_MASTER_PASSWORD_LENGTH = 8

export const settingsServiceHandlers: ServiceImpl<typeof SettingsService> = {
  async getStoreStatus(_req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'reading store status')

    if (!isStoreOpen()) {
      return { available: false, hasMasterPassword: false, unlocked: false, keyFromEnv: false }
    }
    return {
      available: true,
      hasMasterPassword: hasMasterPassword(),
      unlocked: isUnlocked(),
      keyFromEnv: isKeyFromEnv(),
    }
  },

  async setMasterPassword(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'setting the master password')
    requireStore()

    const password = req.password ?? ''
    if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
      throw new ConnectError(
        `Master password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters`,
        Code.InvalidArgument
      )
    }
    try {
      setMasterPassword(password)
    } catch (err) {
      // Already set — changing it means re-encrypting every secret, a separate operation.
      throw new ConnectError(err instanceof Error ? err.message : 'Failed to set master password', Code.FailedPrecondition)
    }
    return {}
  },

  async unlockStore(req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'unlocking the store')
    requireStore()

    try {
      unlockStore(req.password ?? '')
    } catch (err) {
      if (err instanceof WrongMasterPasswordError) {
        throw new ConnectError(err.message, Code.PermissionDenied)
      }
      throw new ConnectError(err instanceof Error ? err.message : 'Failed to unlock store', Code.FailedPrecondition)
    }
    return {}
  },

  async lockStore(_req, context) {
    const user = await getUserFromContext(context.values)
    requireInstanceAdmin(user, 'locking the store')
    lockStore()
    return {}
  },
}

function requireStore(): void {
  if (!isStoreOpen()) {
    throw new ConnectError('Config store is unavailable', Code.FailedPrecondition)
  }
}
