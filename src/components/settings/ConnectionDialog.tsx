import { useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  useCreateConnection,
  useUpdateConnection,
  useTestConnectionParams,
  useConnectionGroups,
} from '@/hooks/useConnectionAdmin'
import type { Connection } from '@/gen/connection_pb'

// Mirrors VALID_SSL_MODES in server/services/connection-service.ts.
const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

const NO_GROUP = '__none__'

interface Props {
  open: boolean
  onClose: () => void
  connection?: Connection
  /** True when the store can hold secrets. Saving a password is blocked otherwise. */
  canStoreSecrets: boolean
}

/**
 * Four tabs mirroring pgAdmin's server dialog: General, Connection, SSL, Advanced.
 *
 * Root stays mounted for open/close animation; the form is mounted only while open and
 * keyed by connection, which is what resets it between edits without a syncing effect.
 */
export function ConnectionDialog({ open, onClose, connection, canStoreSecrets }: Props) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/10" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <DialogPrimitive.Popup className="relative flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border bg-white shadow-lg">
            {open && (
              <ConnectionForm
                key={connection?.id ?? '__new__'}
                onClose={onClose}
                connection={connection}
                canStoreSecrets={canStoreSecrets}
              />
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function ConnectionForm({ onClose, connection, canStoreSecrets }: Omit<Props, 'open'>) {
  const isEdit = !!connection

  const [id, setId] = useState(connection?.id ?? '')
  const [name, setName] = useState(connection?.name ?? '')
  const [groupId, setGroupId] = useState(connection?.groupId || NO_GROUP)
  const [color, setColor] = useState(connection?.color ?? '')

  const [host, setHost] = useState(connection?.host ?? 'localhost')
  const [port, setPort] = useState(String(connection?.port ?? 5432))
  const [database, setDatabase] = useState(connection?.database ?? 'postgres')
  const [username, setUsername] = useState(connection?.username ?? 'postgres')
  // Empty means "leave the stored password alone" when editing.
  const [password, setPassword] = useState('')
  const [allDatabases, setAllDatabases] = useState(connection?.allDatabases ?? false)

  const [sslMode, setSslMode] = useState(connection?.sslMode || 'prefer')
  const [sslCa, setSslCa] = useState(connection?.sslCa ?? '')
  const [sslCert, setSslCert] = useState(connection?.sslCert ?? '')
  const [sslKey, setSslKey] = useState(connection?.sslKey ?? '')

  const [lockTimeout, setLockTimeout] = useState(connection?.lockTimeout ?? '')
  const [statementTimeout, setStatementTimeout] = useState(connection?.statementTimeout ?? '')

  const [error, setError] = useState<string | null>(null)

  const create = useCreateConnection()
  const update = useUpdateConnection()
  const test = useTestConnectionParams()
  const groups = useConnectionGroups()

  const portNum = Number(port)
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  const savingPasswordBlocked = !!password && !canStoreSecrets

  const valid =
    id.trim() !== '' &&
    host.trim() !== '' &&
    database.trim() !== '' &&
    username.trim() !== '' &&
    portValid &&
    !savingPasswordBlocked

  const pending = create.isPending || update.isPending

  function buildInput() {
    return {
      id: id.trim(),
      name: name.trim() || id.trim(),
      host: host.trim(),
      port: portNum,
      database: database.trim(),
      username: username.trim(),
      // undefined => keep the stored password. Never send '' unless clearing is intended.
      password: password || undefined,
      sslMode,
      sslCa: sslCa.trim(),
      sslCert: sslCert.trim(),
      sslKey: sslKey.trim(),
      lockTimeout: lockTimeout.trim(),
      statementTimeout: statementTimeout.trim(),
      color: color.trim(),
      groupId: groupId === NO_GROUP ? '' : groupId,
      allDatabases,
      labels: connection?.labels?.map((l) => l.id) ?? [],
    }
  }

  async function handleSave() {
    setError(null)
    try {
      if (isEdit) {
        await update.mutateAsync(buildInput())
      } else {
        await create.mutateAsync(buildInput())
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save connection')
    }
  }

  function handleTest() {
    setError(null)
    test.mutate({
      host: host.trim(),
      port: portNum,
      database: database.trim(),
      username: username.trim(),
      password: password || undefined,
      sslMode,
      // Lets the server reuse the stored password when the field was left blank.
      id: isEdit && !password ? connection!.id : undefined,
    })
  }

  return (
    <>
      <div className="border-b px-5 py-4">
        <DialogPrimitive.Title className="text-base font-semibold">
          {isEdit ? `Edit ${connection!.name}` : 'New connection'}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-1 text-sm text-gray-500">
          Connect to a PostgreSQL server.
        </DialogPrimitive.Description>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <Tabs defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="connection">Connection</TabsTrigger>
            <TabsTrigger value="ssl">SSL</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-4 pt-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="conn-id">ID</Label>
                <Input
                  id="conn-id"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="prod"
                  // The id is referenced by IAM rules and URLs, so it is fixed after creation.
                  disabled={isEdit}
                />
                {isEdit && (
                  <p className="text-xs text-gray-500">
                    The ID can't change — IAM rules and saved URLs reference it.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conn-name">Display name</Label>
                <Input
                  id="conn-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Production"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="conn-group">Server group</Label>
              <Select value={groupId} onValueChange={(v) => setGroupId(v ?? NO_GROUP)}>
                <SelectTrigger id="conn-group">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GROUP}>No group</SelectItem>
                  {(groups.data ?? []).map((g) => (
                    <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="conn-color">Header colour</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="conn-color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  placeholder="#dc2626"
                />
                {color && (
                  <span
                    className="h-8 w-8 shrink-0 rounded border"
                    style={{ backgroundColor: color }}
                    aria-hidden
                  />
                )}
              </div>
              <p className="text-xs text-gray-500">
                Tints the header so a production server is obvious at a glance.
              </p>
            </div>
          </TabsContent>

          <TabsContent value="connection" className="space-y-4 pt-4">
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="conn-host">Host</Label>
                <Input id="conn-host" value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conn-port">Port</Label>
                <Input id="conn-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
                {!portValid && <p className="text-xs text-red-600">1–65535</p>}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="conn-database">
                {allDatabases ? 'Maintenance database' : 'Database'}
              </Label>
              <Input id="conn-database" value={database} onChange={(e) => setDatabase(e.target.value)} />
              {allDatabases && (
                <p className="text-xs text-gray-500">
                  Used to connect and enumerate the others. Usually <code className="font-mono">postgres</code>.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="conn-username">Username</Label>
                <Input id="conn-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conn-password">Password</Label>
                <Input
                  id="conn-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={connection?.hasPassword ? '•••••••• (unchanged)' : ''}
                  autoComplete="off"
                />
              </div>
            </div>
            {savingPasswordBlocked && (
              <p className="text-xs text-red-600">
                Set a master password under Settings → Security before saving credentials.
              </p>
            )}

            <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
              <div>
                <Label htmlFor="conn-all-databases" className="font-medium">
                  Browse all databases on this server
                </Label>
                <p className="mt-0.5 text-xs text-gray-500">
                  Off by default. When on, anyone with access to this connection can read
                  every database on the host — not just the one above.
                </p>
              </div>
              <Switch
                id="conn-all-databases"
                checked={allDatabases}
                onCheckedChange={(v: boolean) => setAllDatabases(v)}
              />
            </div>
          </TabsContent>

          <TabsContent value="ssl" className="space-y-4 pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="conn-ssl-mode">SSL mode</Label>
              <Select value={sslMode} onValueChange={(v) => setSslMode(v ?? 'prefer')}>
                <SelectTrigger id="conn-ssl-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SSL_MODES.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-ssl-ca">Root certificate</Label>
              <Input id="conn-ssl-ca" value={sslCa} onChange={(e) => setSslCa(e.target.value)} placeholder="/certs/ca.pem" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-ssl-cert">Client certificate</Label>
              <Input id="conn-ssl-cert" value={sslCert} onChange={(e) => setSslCert(e.target.value)} placeholder="/certs/client.crt" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-ssl-key">Client key</Label>
              <Input id="conn-ssl-key" value={sslKey} onChange={(e) => setSslKey(e.target.value)} placeholder="/certs/client.key" />
            </div>
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Certificate paths are recorded but not yet applied when opening connections —
              only <code className="font-mono">SSL mode</code> takes effect today.
            </p>
          </TabsContent>

          <TabsContent value="advanced" className="space-y-4 pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="conn-lock-timeout">Lock timeout</Label>
              <Input
                id="conn-lock-timeout"
                value={lockTimeout}
                onChange={(e) => setLockTimeout(e.target.value)}
                placeholder="5s"
              />
              <p className="text-xs text-gray-500">
                Caps how long a statement waits for a lock. Leave blank for the server default.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-statement-timeout">Statement timeout</Label>
              <Input
                id="conn-statement-timeout"
                value={statementTimeout}
                onChange={(e) => setStatementTimeout(e.target.value)}
                placeholder="30s"
              />
            </div>
          </TabsContent>
        </Tabs>

        {test.data && (
          <div
            className={`mt-4 flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
              test.data.success
                ? 'border-green-200 bg-green-50 text-green-800'
                : 'border-red-200 bg-red-50 text-red-800'
            }`}
          >
            {test.data.success ? (
              <>
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                <span>Connected in {test.data.latencyMs}ms.</span>
              </>
            ) : (
              <>
                <XCircle size={16} className="mt-0.5 shrink-0" />
                <span className="break-all">{test.data.error}</span>
              </>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t px-5 py-3">
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={!host.trim() || !database.trim() || !username.trim() || !portValid || test.isPending}
        >
          {test.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
          Test
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={handleSave} disabled={!valid || pending}>
            {pending ? <Loader2 size={14} className="animate-spin" /> : null}
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </>
  )
}
