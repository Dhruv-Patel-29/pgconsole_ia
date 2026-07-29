import { useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { parseObjectFromUrl, setObjectParams } from '@/lib/url'
import { useSchemas, useTables } from './useQuery'
import { useSelectedDatabase } from '@/lib/database-context'
import type { ObjectType } from '@/components/sql-editor/ObjectTree'

export interface SelectedObject {
  schema: string
  name: string
  type: ObjectType
  arguments?: string
}

interface UseEditorNavigationResult {
  // Resolved state (with defaults applied)
  schema: string | null
  object: SelectedObject | null
  // Loading/fetching states
  isLoading: boolean
  isSchemasLoading: boolean
  isTablesLoading: boolean
  isSchemasRefetching: boolean
  isTablesRefetching: boolean
  // Error states
  schemasError: Error | null
  tablesError: Error | null
  // Available data
  schemas: string[]
  tables: Array<{ name: string; type: string }>
  // Setters for user interactions
  setSchema: (schema: string | null) => void
  setObject: (object: SelectedObject | null, options?: { replace?: boolean }) => void
}

export function useEditorNavigation(connectionId: string, enabled = true): UseEditorNavigationResult {
  const [searchParams, setSearchParams] = useSearchParams()
  const prevConnectionIdRef = useRef<string | null>(null)
  // Tracked alongside the connection because a different database has entirely unrelated
  // schemas, so a stale schema/object param has to be cleared either way. DatabaseSwitcher
  // already clears them when switching, but a hand-edited URL wouldn't.
  const database = useSelectedDatabase()
  const prevDatabaseRef = useRef<string | null>(null)

  // Parse current URL state
  const schemaFromUrl = searchParams.get('schema')
  const objectFromUrl = parseObjectFromUrl(searchParams)

  // Fetch schemas for this connection
  const {
    data: schemas = [],
    isLoading: isSchemasLoading,
    isFetching: isSchemasFetching,
    error: schemasError,
  } = useSchemas(connectionId, enabled)

  // Determine the effective schema (from URL or default)
  const effectiveSchema = schemaFromUrl && schemas.includes(schemaFromUrl)
    ? schemaFromUrl
    : schemas.length > 0
      ? (schemas.includes('public') ? 'public' : schemas[0])
      : null

  // Fetch tables for the effective schema
  const {
    data: tables = [],
    isLoading: isTablesLoading,
    isFetching: isTablesFetching,
    error: tablesError,
  } = useTables(connectionId, effectiveSchema || '', enabled)

  // Determine the effective object (from URL or default)
  const effectiveObject: SelectedObject | null = (() => {
    if (!effectiveSchema) return null

    // If URL has an object, use it
    // For functions/procedures, trust the URL (they're not in tables list)
    // For tables/views, validate they exist
    if (objectFromUrl) {
      const isFunction = objectFromUrl.type === 'function' || objectFromUrl.type === 'procedure'
      if (isFunction) {
        // Functions/procedures are valid - trust the URL
        return {
          schema: effectiveSchema,
          name: objectFromUrl.name,
          type: objectFromUrl.type,
          arguments: objectFromUrl.arguments,
        }
      }
      // For tables/views, check if it exists
      const exists = tables.some(t => t.name === objectFromUrl.name)
      if (exists) {
        return {
          schema: effectiveSchema,
          name: objectFromUrl.name,
          type: objectFromUrl.type,
          arguments: objectFromUrl.arguments,
        }
      }
    }

    // Default to first table or view (only if no valid object in URL)
    if (tables.length > 0) {
      const firstTable = tables.find(t => t.type === 'table') || tables[0]
      return {
        schema: effectiveSchema,
        name: firstTable.name,
        type: firstTable.type === 'view' ? 'view' : 'table',
      }
    }

    return null
  })()

  // Update URL when resolved state differs from URL state
  useEffect(() => {
    // Skip entirely when this hook isn't driving the current route (e.g. /audit-log),
    // so editor-specific params (schema/object) aren't written to unrelated URLs.
    if (!enabled) return
    // Don't update URL while still loading
    if (!connectionId || isSchemasLoading) return

    // Detect connection or database change - clear URL params
    const connectionChanged = prevConnectionIdRef.current !== null &&
                              prevConnectionIdRef.current !== connectionId
    const databaseChanged = prevDatabaseRef.current !== null &&
                            prevDatabaseRef.current !== database
    prevConnectionIdRef.current = connectionId
    prevDatabaseRef.current = database

    if (connectionChanged || databaseChanged) {
      // Navigate to a clean URL and let the next render set defaults. The database is
      // preserved on a database change (it's the thing being selected) but dropped on a
      // connection change, since it may not exist on the new server.
      setSearchParams(
        (prev) => {
          const newParams = new URLSearchParams()
          newParams.set('connectionId', prev.get('connectionId') || connectionId)
          if (!connectionChanged && database) {
            newParams.set('database', database)
          }
          return newParams
        },
        { replace: true }
      )
      return
    }

    // Check if schema needs updating
    const needsSchemaUpdate = effectiveSchema && effectiveSchema !== schemaFromUrl

    // Check if object needs updating (only after tables are loaded)
    const needsObjectUpdate = !isTablesLoading && effectiveObject && (
      !objectFromUrl ||
      objectFromUrl.name !== effectiveObject.name ||
      objectFromUrl.type !== effectiveObject.type
    )

    if (needsSchemaUpdate || needsObjectUpdate) {
      setSearchParams(
        (prev) => {
          const newParams = new URLSearchParams(prev)

          if (needsSchemaUpdate && effectiveSchema) {
            newParams.set('schema', effectiveSchema)
          }

          if (needsObjectUpdate) {
            setObjectParams(newParams, effectiveObject)
          }

          return newParams
        },
        { replace: true }
      )
    }
  }, [
    enabled,
    connectionId,
    isSchemasLoading,
    database,
    isTablesLoading,
    effectiveSchema,
    schemaFromUrl,
    effectiveObject,
    objectFromUrl,
    setSearchParams,
  ])

  // Setters for user interactions
  const setSchema = useCallback(
    (schema: string | null) => {
      setSearchParams(
        (prev) => {
          const newParams = new URLSearchParams(prev)
          if (schema) {
            newParams.set('schema', schema)
          } else {
            newParams.delete('schema')
          }
          // Clear object when schema changes
          setObjectParams(newParams, null)
          return newParams
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const setObject = useCallback(
    (object: SelectedObject | null, options?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const newParams = new URLSearchParams(prev)
          setObjectParams(newParams, object)
          return newParams
        },
        { replace: options?.replace ?? true }
      )
    },
    [setSearchParams]
  )

  return {
    schema: effectiveSchema,
    object: effectiveObject,
    isLoading: isSchemasLoading || isTablesLoading,
    isSchemasLoading,
    isTablesLoading,
    isSchemasRefetching: isSchemasFetching && !isSchemasLoading,
    isTablesRefetching: isTablesFetching && !isTablesLoading,
    schemasError: schemasError as Error | null,
    tablesError: tablesError as Error | null,
    schemas,
    tables,
    setSchema,
    setObject,
  }
}
