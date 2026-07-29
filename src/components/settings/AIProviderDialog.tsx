import { useMemo, useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import {
  useCreateAIProvider,
  useUpdateAIProvider,
  useTestAIProvider,
  useVendorModels,
} from '@/hooks/useSettings'
import type { AIProvider } from '@/gen/ai_pb'

/** Vendors, with what each one needs. Mirrors the validation in server/lib/config.ts. */
const VENDORS = [
  { value: 'openai', label: 'OpenAI', needsKey: true, baseUrl: 'never' },
  { value: 'anthropic', label: 'Anthropic', needsKey: true, baseUrl: 'never' },
  { value: 'google', label: 'Google', needsKey: true, baseUrl: 'never' },
  { value: 'ollama-cloud', label: 'Ollama Cloud', needsKey: true, baseUrl: 'optional' },
  { value: 'openai-compatible', label: 'OpenAI-compatible', needsKey: false, baseUrl: 'required' },
] as const

const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com/v1'

const MODEL_PLACEHOLDERS: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-1.5-pro',
  'ollama-cloud': 'gpt-oss:120b',
  'openai-compatible': 'llama-3.3-70b-versatile',
}

interface Props {
  open: boolean
  onClose: () => void
  /** Existing provider to edit, or undefined to create a new one. */
  provider?: AIProvider
  /** True when the store can hold secrets. Saving a key is blocked otherwise. */
  canStoreSecrets: boolean
}

/**
 * The Root stays mounted so base-ui can animate open/close, while the fields live in
 * ProviderForm, which is mounted only while open and keyed by provider. That keying is
 * what resets the form between edits — no state-syncing effect needed.
 */
export function AIProviderDialog({ open, onClose, provider, canStoreSecrets }: Props) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/10" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <DialogPrimitive.Popup className="relative w-full max-w-lg rounded-2xl border bg-white shadow-lg">
            {open && (
              <ProviderForm
                key={provider?.id ?? '__new__'}
                onClose={onClose}
                provider={provider}
                canStoreSecrets={canStoreSecrets}
              />
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function ProviderForm({ onClose, provider, canStoreSecrets }: Omit<Props, 'open'>) {
  const isEdit = !!provider

  const [id, setId] = useState(provider?.id ?? '')
  const [name, setName] = useState(provider?.name ?? '')
  const [vendor, setVendor] = useState<string>(provider?.vendor ?? 'ollama-cloud')
  const [model, setModel] = useState(provider?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  // Empty means "leave the stored key alone" when editing.
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useCreateAIProvider()
  const update = useUpdateAIProvider()
  const test = useTestAIProvider()

  const vendorSpec = useMemo(() => VENDORS.find((v) => v.value === vendor) ?? VENDORS[0], [vendor])

  const effectiveBaseUrl = vendor === 'ollama-cloud' ? baseUrl || OLLAMA_CLOUD_BASE_URL : baseUrl

  // Only send a key we actually have; otherwise let the server use the stored one.
  // No `enabled` guard needed — this form is mounted only while the dialog is open.
  const models = useVendorModels({
    vendor,
    baseUrl: effectiveBaseUrl,
    apiKey: apiKey || undefined,
    providerId: isEdit && !apiKey ? provider!.id : undefined,
  })

  const needsBaseUrl = vendorSpec.baseUrl === 'required'
  const showBaseUrl = vendorSpec.baseUrl !== 'never'
  // A new provider for a key-requiring vendor must supply one now. An edit can reuse
  // the key already on file.
  const keyMissing = vendorSpec.needsKey && !apiKey && !(isEdit && provider?.hasApiKey)
  const savingKeyBlocked = !!apiKey && !canStoreSecrets

  const valid =
    id.trim() !== '' &&
    model.trim() !== '' &&
    (!needsBaseUrl || baseUrl.trim() !== '') &&
    !keyMissing &&
    !savingKeyBlocked

  const pending = create.isPending || update.isPending

  function buildInput() {
    return {
      id: id.trim(),
      name: name.trim() || id.trim(),
      vendor,
      model: model.trim(),
      baseUrl: showBaseUrl ? baseUrl.trim() : '',
      // undefined => keep stored key. Never send an empty string here, which would clear it.
      apiKey: apiKey || undefined,
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
      setError(err instanceof Error ? err.message : 'Failed to save provider')
    }
  }

  function handleTest() {
    setError(null)
    test.mutate({
      vendor,
      model: model.trim(),
      baseUrl: showBaseUrl ? effectiveBaseUrl.trim() : '',
      apiKey: apiKey || undefined,
      providerId: isEdit && !apiKey ? provider!.id : undefined,
    })
  }

  return (
    <>
            <div className="border-b px-5 py-4">
              <DialogPrimitive.Title className="text-base font-semibold">
                {isEdit ? `Edit ${provider!.name}` : 'Add AI provider'}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-sm text-gray-500">
                Used for Text-to-SQL, explanations, and risk assessment.
              </DialogPrimitive.Description>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="provider-id">ID</Label>
                  <Input
                    id="provider-id"
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    placeholder="ollama-cloud"
                    // The id is the stable key referenced elsewhere, so it is fixed after creation.
                    disabled={isEdit}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="provider-name">Display name</Label>
                  <Input
                    id="provider-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ollama GPT-OSS 120B"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="provider-vendor">Vendor</Label>
                <Select value={vendor} onValueChange={(v) => setVendor(v ?? 'ollama-cloud')}>
                  <SelectTrigger id="provider-vendor">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VENDORS.map((v) => (
                      <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {vendor === 'ollama-cloud' && (
                  <p className="text-xs text-gray-500">
                    Hosted models from ollama.com. Leave the endpoint blank to use{' '}
                    <code className="font-mono">{OLLAMA_CLOUD_BASE_URL}</code>.
                  </p>
                )}
                {vendor === 'openai-compatible' && (
                  <p className="text-xs text-gray-500">
                    Any OpenAI-compatible API — Groq, OpenRouter, vLLM, or a local Ollama at{' '}
                    <code className="font-mono">http://localhost:11434/v1</code>. The key is optional.
                  </p>
                )}
              </div>

              {showBaseUrl && (
                <div className="space-y-1.5">
                  <Label htmlFor="provider-base-url">
                    Endpoint {vendorSpec.baseUrl === 'optional' && <span className="text-gray-400">(optional)</span>}
                  </Label>
                  <Input
                    id="provider-base-url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={vendor === 'ollama-cloud' ? OLLAMA_CLOUD_BASE_URL : 'https://api.groq.com/openai/v1'}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="provider-key">
                  API key{' '}
                  {!vendorSpec.needsKey && <span className="text-gray-400">(optional)</span>}
                </Label>
                <Input
                  id="provider-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider?.hasApiKey ? '•••••••• (unchanged)' : 'sk-…'}
                  autoComplete="off"
                />
                {savingKeyBlocked && (
                  <p className="text-xs text-red-600">
                    Set a master password before saving credentials.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="provider-model">Model</Label>
                {models.data && models.data.length > 0 ? (
                  <Select value={model} onValueChange={(m) => setModel(m ?? '')}>
                    <SelectTrigger id="provider-model">
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.data.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="provider-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={MODEL_PLACEHOLDERS[vendor] ?? 'model-name'}
                  />
                )}
                {models.isFetching && (
                  <p className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Loader2 size={12} className="animate-spin" /> Loading available models…
                  </p>
                )}
                {/* Discovery is best-effort: falling back to free text is normal, not a failure. */}
                {models.isError && (
                  <p className="text-xs text-gray-500">
                    Couldn't list models automatically — enter the name manually.
                  </p>
                )}
              </div>

              {test.data && (
                <div
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
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
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t px-5 py-3">
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={!model.trim() || (needsBaseUrl && !baseUrl.trim()) || test.isPending}
              >
                {test.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                Test
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
                <Button onClick={handleSave} disabled={!valid || pending}>
                  {pending ? <Loader2 size={14} className="animate-spin" /> : null}
                  {isEdit ? 'Save' : 'Add provider'}
                </Button>
              </div>
            </div>
    </>
  )
}
