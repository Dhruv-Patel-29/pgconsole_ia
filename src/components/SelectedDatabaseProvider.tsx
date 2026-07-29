import { useMemo, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SelectedDatabaseContext } from '@/lib/database-context'

/** Publishes the `database` URL param to the editor. Must render inside the router. */
export function SelectedDatabaseProvider({ children }: { children: ReactNode }) {
  const [searchParams] = useSearchParams()
  const database = searchParams.get('database') ?? ''
  const value = useMemo(() => database, [database])
  return <SelectedDatabaseContext value={value}>{children}</SelectedDatabaseContext>
}
