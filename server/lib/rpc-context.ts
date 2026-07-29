import type { ContextValues } from '@connectrpc/connect'
import type { User } from './auth'

/**
 * connect.ts's contextValues factory returns a plain string-keyed Map, while ConnectRPC
 * types the handler's `context.values` as ContextValues (whose `get` is keyed by
 * ContextKey, not string). The two are structurally incompatible even though the runtime
 * only ever calls `.get('user')` on a Map, so this accepts either and narrows once here
 * rather than leaving an error at every call site.
 *
 * Making this genuinely sound means migrating the codebase to `createContextKey`, which
 * touches every service — deliberately out of scope here.
 */
type ContextLike = Map<string, unknown> | ContextValues

/**
 * Read the authenticated principal out of a ConnectRPC handler context.
 *
 * This lives in lib/ rather than next to the router in connect.ts on purpose. connect.ts
 * builds the middleware at module scope, which resolves every service's handlers as a
 * side effect of being imported; a service importing this helper from connect.ts creates
 * an import cycle whose outcome depends on which module is loaded first.
 *
 * `contextValues` may be a Promise, because the contextValues factory is async.
 */
export async function getUserFromContext(
  contextValues: ContextLike | Promise<ContextLike>
): Promise<User | null> {
  const values = (await contextValues) as Map<string, unknown>
  return (values.get('user') as User | null) ?? null
}
