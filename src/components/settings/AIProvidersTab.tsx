import { useState } from 'react'
import { Bot, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table'
import { AIProviderDialog } from './AIProviderDialog'
import { useAIProviders, useDeleteAIProvider } from '@/hooks/useSettings'
import type { AIProvider } from '@/gen/ai_pb'

const VENDOR_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'ollama-cloud': 'Ollama Cloud',
  'openai-compatible': 'OpenAI-compatible',
}

export function AIProvidersTab({ canStoreSecrets }: { canStoreSecrets: boolean }) {
  const providers = useAIProviders()
  const remove = useDeleteAIProvider()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AIProvider | undefined>()
  const [confirmDelete, setConfirmDelete] = useState<AIProvider | null>(null)
  const [error, setError] = useState<string | null>(null)

  function openCreate() {
    setEditing(undefined)
    setDialogOpen(true)
  }

  function openEdit(provider: AIProvider) {
    setEditing(provider)
    setDialogOpen(true)
  }

  async function handleDelete(provider: AIProvider) {
    setError(null)
    try {
      await remove.mutateAsync(provider.id)
      setConfirmDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete provider')
    }
  }

  const rows = providers.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-600">
          Providers power Text-to-SQL, query explanations, and change risk assessment.
          Entries from <code className="font-mono">pgconsole.toml</code> are managed by the
          operator and can only be changed in that file.
        </p>
        <Button onClick={openCreate} className="shrink-0">
          <Plus size={14} /> Add provider
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {providers.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Failed to load providers.
        </div>
      )}

      {rows.length === 0 && !providers.isLoading ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-gray-300 py-16 text-gray-500">
          <Bot size={32} />
          <p className="text-sm">No AI providers configured yet.</p>
          <Button variant="outline" onClick={openCreate}>
            <Plus size={14} /> Add your first provider
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>API key</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((provider) => {
              const managed = provider.source !== 'store'
              return (
                <TableRow key={provider.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{provider.name}</span>
                      {managed && (
                        <Badge variant="muted" title="Defined in pgconsole.toml">
                          <Lock size={10} /> managed
                        </Badge>
                      )}
                    </div>
                    <div className="font-mono text-xs text-gray-500">{provider.id}</div>
                  </TableCell>
                  <TableCell>{VENDOR_LABELS[provider.vendor] ?? provider.vendor}</TableCell>
                  <TableCell className="font-mono text-xs">{provider.model}</TableCell>
                  <TableCell>
                    {provider.hasApiKey ? (
                      <Badge variant="success">set</Badge>
                    ) : (
                      <Badge variant="muted">none</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {!managed && (
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(provider)}
                          title="Edit provider"
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDelete(provider)}
                          title="Delete provider"
                        >
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
            Delete provider <strong>{confirmDelete.name}</strong>? Saved queries that reference
            it will need a different provider selected.
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

      <AIProviderDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        provider={editing}
        canStoreSecrets={canStoreSecrets}
      />
    </div>
  )
}
