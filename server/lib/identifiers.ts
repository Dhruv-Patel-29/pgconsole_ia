/**
 * Postgres identifier quoting for text handed to an AI model.
 *
 * Unquoted identifiers are folded to lower case, so a table created as
 * `"AWS_New_Batch_4_fs"` can only be referenced as `"AWS_New_Batch_4_fs"` — writing
 * AWS_New_Batch_4_fs looks for aws_new_batch_4_fs and fails with "relation does not exist".
 * The schema context we build is the model's only source for these names, so it has to show
 * them in a form that can be pasted into a query verbatim.
 */

/**
 * Identifiers that are safe bare: they start with a lowercase letter or underscore and
 * contain only lowercase letters, digits, underscores, and dollar signs.
 */
const SAFE_UNQUOTED = /^[a-z_][a-z0-9_$]*$/

/**
 * Reserved words that cannot be used as a bare identifier. Not the full list — the ones
 * plausible as a table or column name, where quoting is the difference between a working
 * query and a syntax error.
 */
const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both',
  'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create', 'current_catalog',
  'current_date', 'current_role', 'current_schema', 'current_time', 'current_timestamp',
  'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except',
  'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'initially',
  'intersect', 'into', 'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not',
  'null', 'offset', 'on', 'only', 'or', 'order', 'placing', 'primary', 'references',
  'returning', 'select', 'session_user', 'some', 'symmetric', 'table', 'then', 'to',
  'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'when', 'where',
  'window', 'with',
])

/** True when the identifier must be double-quoted to round-trip. */
export function needsQuoting(name: string): boolean {
  return !SAFE_UNQUOTED.test(name) || RESERVED.has(name)
}

/**
 * Quote an identifier only when it needs it, so lowercase names stay readable and the
 * model isn't taught to quote everything.
 */
export function quoteIdent(name: string): string {
  if (!needsQuoting(name)) return name
  return `"${name.replace(/"/g, '""')}"`
}

/** `schema.table`, each part quoted only if needed. */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}
