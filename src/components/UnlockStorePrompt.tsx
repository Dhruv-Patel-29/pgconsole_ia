import { useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Lock, Unlock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useStoreStatus, useUnlockStore } from '@/hooks/useSettings'

/**
 * Asks for the master password once per launch, when the store has one and is locked.
 *
 * The encryption key is derived from the password and never written down, so a restart
 * always starts locked — there is nothing to remember it with. Without a prompt that reads
 * as the app having lost the saved credentials: connections that need a stored password
 * simply fail to connect, with nothing pointing at Settings → Security.
 *
 * Dismissible, because a locked store is still useful for connections whose password isn't
 * stored and for browsing everything except secrets.
 */
export function UnlockStorePrompt() {
  const status = useStoreStatus()
  const unlock = useUnlockStore()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  const s = status.data
  const needsUnlock = !!s?.available && !s.keyFromEnv && s.hasMasterPassword && !s.unlocked

  async function handleUnlock() {
    setError(null)
    try {
      await unlock.mutateAsync(password)
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock')
    }
  }

  return (
    <DialogPrimitive.Root open={needsUnlock && !dismissed} onOpenChange={(open) => !open && setDismissed(true)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/10" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <DialogPrimitive.Popup className="relative w-full max-w-md rounded-2xl border bg-white p-6 shadow-lg">
            <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
              <Lock size={16} className="text-amber-600" /> Unlock saved credentials
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-2 text-sm text-gray-600">
              Your saved database passwords and API keys are encrypted with your master
              password. Enter it to make them available for this session.
            </DialogPrimitive.Description>

            <div className="mt-4 space-y-1.5">
              <Label htmlFor="startup-unlock">Master password</Label>
              <Input
                id="startup-unlock"
                type="password"
                value={password}
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && password && handleUnlock()}
                autoComplete="current-password"
              />
            </div>

            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDismissed(true)}>
                Not now
              </Button>
              <Button onClick={handleUnlock} disabled={unlock.isPending || !password}>
                <Unlock size={14} /> Unlock
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
