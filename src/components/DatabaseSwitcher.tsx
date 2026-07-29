import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, Database, Loader2 } from 'lucide-react'
import { Menu, MenuTrigger, MenuPopup, MenuItem } from './ui/menu'
import { Button } from './ui/button'
import { useConnections } from '../hooks/useQuery'
import { useDatabases } from '../hooks/useConnectionAdmin'
import { useSelectedDatabase } from '../lib/database-context'

/**
 * Database picker for connections that opted into browsing the whole server, pgAdmin's
 * server → database model. Renders nothing for single-database connections, so the header
 * is unchanged for them.
 */
export function DatabaseSwitcher({ selectedConnectionId }: { selectedConnectionId: string }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const selectedDatabase = useSelectedDatabase()
  const { data: connections } = useConnections()

  const connection = connections?.find((c) => c.id === selectedConnectionId)
  const enabled = !!connection?.allDatabases
  const { data: databases, isLoading } = useDatabases(selectedConnectionId, enabled)

  if (!connection || !enabled) return null

  // Empty selection means the connection's configured (maintenance) database.
  const current = selectedDatabase || connection.database

  function select(database: string) {
    const next = new URLSearchParams(searchParams)
    if (database === connection!.database) {
      // Keep the default implicit so URLs stay stable for single-database use.
      next.delete('database')
    } else {
      next.set('database', database)
    }
    // Schema and object belong to the old database; drop them so the tree reopens cleanly.
    next.delete('schema')
    for (const t of ['table', 'view', 'materialized_view', 'function', 'procedure']) {
      next.delete(t)
    }
    navigate(`/?${next.toString()}`)
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost" size="sm" className="!h-auto gap-1 !px-2 !py-1">
            <Database size={14} className="shrink-0 text-muted-foreground" />
            <span className="whitespace-nowrap text-sm">{current}</span>
            <ChevronDown size={14} className="shrink-0" />
          </Button>
        }
      />
      <MenuPopup>
        {isLoading && (
          <MenuItem disabled>
            <Loader2 size={14} className="animate-spin" /> Loading databases…
          </MenuItem>
        )}
        {(databases ?? []).map((db) => (
          <MenuItem
            key={db}
            onClick={() => select(db)}
            className={db === current ? 'bg-gray-100' : ''}
          >
            <Database size={14} className="text-muted-foreground" />
            <span className="text-sm">{db}</span>
          </MenuItem>
        ))}
        {!isLoading && (databases ?? []).length === 0 && (
          <MenuItem disabled>No databases found</MenuItem>
        )}
      </MenuPopup>
    </Menu>
  )
}
