import { useState } from 'react'
import { Database, Lock, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table'
import { ConnectionDialog } from './ConnectionDialog'
import { useConnections } from '@/hooks/useQuery'
import { useDeleteConnection, useConnectionGroups } from '@/hooks/useConnectionAdmin'
import type { Connection } from '@/gen/connection_pb'

export function ConnectionsTab({ canStoreSecrets }: { canStoreSecrets: boolean }) {
  const connections = useConnections()
  const groups = useConnectionGroups()
  const remove = useDeleteConnection()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Connection | undefined>()
  const [confirmDelete, setConfirmDelete] = useState<Connection | null>(null)
  const [error, setError] = useState<string | null>(null)

  function openCreate() {
    setEditing(undefined)
    setDialogOpen(true)
  }

  function openEdit(conn: Connection) {
    setEditing(conn)
    setDialogOpen(true)
  }

  async function handleDelete(conn: Connection) {
    setError(null)
    try {
      await remove.mutateAsync(conn.id)
      setConfirmDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete connection')
    }
  }

  const rows = connections.data ?? []
  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-600">
          Servers you can query. Entries from <code className="font-mono">pgconsole.toml</code> are
          managed by the operator and can only be changed in that file.
        </p>
        <Button onClick={openCreate} className="shrink-0">
          <Plus size={14} /> New connection
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {rows.length === 0 && !connections.isLoading ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-gray-300 py-16 text-gray-500">
          <Server size={32} />
          <p className="text-sm">No connections yet.</p>
          <Button variant="outline" onClick={openCreate}>
            <Plus size={14} /> Add your first connection
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Server</TableHead>
              <TableHead>Database</TableHead>
              <TableHead>Password</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((conn) => {
              const managed = conn.source !== 'store'
              return (
                <TableRow key={conn.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {conn.color && (
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: conn.color }}
                          aria-hidden
                        />
                      )}
                      <span className="font-medium">{conn.name}</span>
                      {managed && (
                        <Badge variant="muted" title="Defined in pgconsole.toml">
                          <Lock size={10} /> managed
                        </Badge>
                      )}
                    </div>
                    <div className="font-mono text-xs text-gray-500">
                      {conn.id}
                      {conn.groupId && groupName(conn.groupId) && (
                        <span className="ml-1.5 font-sans">· {groupName(conn.groupId)}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {conn.username}@{conn.host}:{conn.port}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 font-mono text-xs">
                      <Database size={12} className="text-gray-400" />
                      {conn.database}
                    </div>
                    {conn.allDatabases && (
                      <Badge variant="info" size="sm" className="mt-1">
                        all databases
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {conn.hasPassword ? (
                      <Badge variant="success">set</Badge>
                    ) : (
                      <Badge variant="muted">none</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {!managed && (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(conn)} title="Edit connection">
                          <Pencil size={14} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(conn)} title="Delete connection">
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {confirmDelete && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-900">
            Delete connection <strong>{confirmDelete.name}</strong>? This removes the saved
            credentials from pgconsole. The database itself is not touched.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handleDelete(confirmDelete)}
              disabled={remove.isPending}
            >
              Delete
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ConnectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        connection={editing}
        canStoreSecrets={canStoreSecrets}
      />
    </div>
  )
}
