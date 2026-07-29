import { createContext, useContext } from 'react'

/**
 * The database currently being browsed, read from the `database` URL param by
 * SelectedDatabaseProvider.
 *
 * Empty string means "the connection's configured database", which is what every
 * single-database connection uses — so existing URLs keep working untouched.
 *
 * This is a context rather than a parameter threaded through every hook because
 * `database` is ambient to the whole editor the same way `connectionId` is, and threading
 * it would mean touching ~14 components that have no interest in it. The hooks in
 * useQuery.ts read it directly and fold it into their query keys, which is what keeps the
 * cache from serving one database's schema for another.
 */
export const SelectedDatabaseContext = createContext<string>('')

export function useSelectedDatabase(): string {
  return useContext(SelectedDatabaseContext)
}
