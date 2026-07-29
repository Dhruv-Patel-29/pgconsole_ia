import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Settings as SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { MasterPasswordCard } from '@/components/settings/MasterPasswordCard'
import { AIProvidersTab } from '@/components/settings/AIProvidersTab'
import { ConnectionsTab } from '@/components/settings/ConnectionsTab'
import { useStoreStatus } from '@/hooks/useSettings'

export default function Settings() {
  const navigate = useNavigate()
  const status = useStoreStatus()

  // Secrets can only be written while the store is unlocked, whether by master password
  // or PGCONSOLE_SECRET_KEY.
  const canStoreSecrets = !!status.data?.unlocked

  if (status.isError) {
    return (
      <div className="flex-1 overflow-auto bg-white text-gray-900">
        <div className="mx-auto max-w-4xl p-8">
          <h1 className="mb-2 text-2xl font-bold">Settings</h1>
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Settings are only available to the instance owner.
          </div>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/')}>
            <ArrowLeft size={14} /> Back to editor
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto bg-white text-gray-900">
      <div className="mx-auto max-w-5xl p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <SettingsIcon size={22} /> Settings
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              Manage connections, AI providers, and stored credentials.
            </p>
          </div>
          <Button variant="outline" onClick={() => navigate('/')}>
            <ArrowLeft size={14} /> Back to editor
          </Button>
        </div>

        <Tabs defaultValue="connections">
          <TabsList>
            <TabsTrigger value="connections">Connections</TabsTrigger>
            <TabsTrigger value="ai-providers">AI providers</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
          </TabsList>

          <TabsContent value="connections" className="pt-6">
            <ConnectionsTab canStoreSecrets={canStoreSecrets} />
          </TabsContent>

          <TabsContent value="ai-providers" className="pt-6">
            <AIProvidersTab canStoreSecrets={canStoreSecrets} />
          </TabsContent>

          <TabsContent value="security" className="pt-6">
            <MasterPasswordCard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
