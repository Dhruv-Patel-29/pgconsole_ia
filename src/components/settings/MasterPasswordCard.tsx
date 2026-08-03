import { useState } from 'react'
import { KeyRound, Lock, ShieldCheck, Unlock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { useStoreStatus, useSetMasterPassword, useUnlockStore, useLockStore } from '@/hooks/useSettings'

const MIN_LENGTH = 8

/**
 * Gates credential storage, mirroring pgAdmin's master password. Connection passwords and
 * API keys are encrypted with a key derived from this password; without it the store can
 * hold everything except the secrets themselves.
 */
export function MasterPasswordCard() {
  const status = useStoreStatus()
  const setPassword = useSetMasterPassword()
  const unlock = useUnlockStore()
  const lock = useLockStore()

  const [value, setValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  const s = status.data
  if (!s) return null

  if (!s.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Credential storage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-700">
            The config store could not be opened, so connections and providers cannot be
            managed from here. Check the server logs.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (s.keyFromEnv) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-green-600" /> Credential storage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600">
            Secrets are encrypted with the key from{' '}
            <code className="font-mono">PGCONSOLE_SECRET_KEY</code>. No master password is
            needed.
          </p>
        </CardContent>
      </Card>
    )
  }

  async function handleSet() {
    setError(null)
    if (value.length < MIN_LENGTH) {
      setError(`Master password must be at least ${MIN_LENGTH} characters.`)
      return
    }
    if (value !== confirm) {
      setError('Passwords do not match.')
      return
    }
    try {
      await setPassword.mutateAsync(value)
      setValue('')
      setConfirm('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set master password')
    }
  }

  async function handleUnlock() {
    setError(null)
    try {
      await unlock.mutateAsync(value)
      setValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock')
    }
  }

  // Never had a master password: offer to create one.
  if (!s.hasMasterPassword) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound size={16} /> Set a master password
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">
            Required before InfoAnalytica can save database passwords or AI provider API keys.
            Secrets are encrypted with a key derived from this password.
          </p>
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            There is no recovery if you lose it — saved credentials would have to be
            re-entered.
          </p>
          <div className="grid max-w-md gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="master-password">Master password</Label>
              <Input
                id="master-password"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="master-password-confirm">Confirm</Label>
              <Input
                id="master-password-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button onClick={handleSet} disabled={setPassword.isPending}>
            Set master password
          </Button>
        </CardContent>
      </Card>
    )
  }

  // Has one, currently locked: prompt to unlock.
  if (!s.unlocked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock size={16} className="text-amber-600" /> Store is locked
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">
            Saved database passwords and API keys are unavailable until you unlock. You can
            still browse connections that don't need a stored password.
          </p>
          <div className="max-w-md space-y-1.5">
            <Label htmlFor="unlock-password">Master password</Label>
            <Input
              id="unlock-password"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
              autoComplete="current-password"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button onClick={handleUnlock} disabled={unlock.isPending || !value}>
            <Unlock size={14} /> Unlock
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-green-600" /> Credential storage unlocked
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-gray-600">
          Saved database passwords and API keys are readable this session.
        </p>
        <Button variant="outline" onClick={() => lock.mutate()} disabled={lock.isPending}>
          <Lock size={14} /> Lock store
        </Button>
      </CardContent>
    </Card>
  )
}
