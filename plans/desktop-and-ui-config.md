# UI-Managed Config, Ollama Cloud, and a Windows Desktop Build

> **Status: implemented.** 613 tests pass, `pnpm build` and `pnpm build:desktop` are green,
> the CLI boots, and lint is at its pre-existing baseline (42 errors, none from this work).
> The Windows `.exe` itself has not been produced — that runs on a Windows machine via
> `pnpm dist:win` or the `desktop.yml` CI job.
>
> Deviations from the plan as written, all discovered during implementation:
>
> - **`server/` was never typechecked.** No tsconfig covered it. Added
>   `tsconfig.server.json` + `pnpm typecheck:server`, but deliberately *not* referenced
>   from `tsconfig.json`: server/ has 56 pre-existing errors (postgres.js `Row` typing,
>   OAuth `unknown`, `mcp.ts`) that would fail `pnpm build`. All new code is clean under it.
> - **`testAllConnections` already honoured a `lazy` flag**, so store connections are
>   excluded from boot fail-fast by setting `lazy: true` — no split of that function needed.
> - **An import cycle had to be broken.** `ai-service` → `connect` → routes →
>   `aiServiceHandlers` (undefined mid-evaluation). `getUserFromContext` moved to
>   `server/lib/rpc-context.ts`.
> - **Electron main uses `require('electron')` via `createRequire`**, not a named ESM
>   import, because `electron` is a CJS builtin and named-export interop varies by loader.
> - **Database selection is a React context**, not a parameter threaded through every hook —
>   see Phase 3b notes below.

## Context

Four requested features, sharing one prerequisite:

1. Ollama Cloud model support (`ollama.com` via API key)
2. Configure/select AI providers + API keys from the frontend
3. Manage database connections from the frontend, pgAdmin-style, instead of `pgconsole.toml`
4. Ship a Windows `.exe`

### What the reference repo actually contains

`pgconsole_oss_original/` is **not** a superset of this repo. It is a fork of an
*older* upstream (single squashed commit `cd0ba7e`, "add: ollama models support")
that predates several things `main` now has:

| | `pgconsole_oss_original` | this repo (1.3.0) |
|---|---|---|
| AI layer | raw `openai` / `@anthropic-ai/sdk` / `@google/genai` | Vercel AI SDK (`ai` + `@ai-sdk/*`) |
| 4th vendor | `ollama` (hardcoded `https://ollama.com/v1`) | `openai-compatible` (arbitrary `base_url`) |
| MCP server / `[[agents]]` | absent | present |
| Audit retention, connection `color`, `execute-sql.ts` | absent | present |
| License / Enterprise gating | present | removed |

**Consequence for feature 1:** `server/ai/vendors.ts` on `main` already reaches Ollama
Cloud today — `vendor = "openai-compatible"`, `base_url = "https://ollama.com/v1"`,
`api_key = "<ollama key>"`. Its `openai-compatible` case is the *same* OpenAI-wire call
the fork's `ollama` case makes, and its session handling is strictly better
(`MAX_SESSION_ID_BYTES`, `trimHistory`, `MAX_OUTPUT_TOKENS`, `isValidMessage`).

So we **do not port** the fork's `ollama` branch. Porting it would re-add three
deprecated SDK dependencies, drop the session-size guards, and reintroduce the
`stateless-${Date.now()}` pseudo-session hack. Instead we make Ollama Cloud a
**first-class, discoverable preset** over the existing path — same user-visible
feature, none of the regression. This is the one place the plan deliberately
diverges from a literal port of the fork.

### The shared prerequisite

There is **no persistence layer anywhere in this repo.** `server/lib/config.ts`
reads TOML once at boot into module-level state and exposes ~25 synchronous
getters; there is no write path. Audit log is in-memory. Features 2 and 3 are
both blocked on introducing a writable store.

Other blockers found:

- `server/index.ts:104` — `testAllConnections()` calls `process.exit(1)` if **any**
  connection fails. A user-entered bad connection would brick startup.
- `proto/connection.proto` has only `List` / `Get` / `Test`. No CRUD.
- `TestConnection` tests a *saved* connection by id. pgAdmin tests *unsaved form
  input* before save — we need that shape too.
- `src/pages/OrgSettings.tsx` is a static unrouted stub (hardcoded `defaultValue`,
  no handlers). `src/App.tsx` routes only `/`, `/audit-log`, `/signin`. Treat as
  scaffolding to replace, not extend.
- Connection passwords are plaintext in TOML today. Store-backed secrets must not be.

## Decisions

Confirmed with the requester:

- **Packaging** — Electron + `electron-builder` (NSIS installer + portable `.exe`).
- **TOML posture** — additive. TOML entries stay read-only "managed" items; UI-created
  entries are editable. Existing Docker / server / IAM / CI deployments unaffected.
- **Store** — `node:sqlite` (`DatabaseSync`), secrets via AES-256-GCM.

`node:sqlite` is the right fit for a non-obvious reason: the existing config getters
are **synchronous** and called from ~15 call sites. `DatabaseSync` is synchronous, so
the merge happens behind the current signatures with no async refactor rippling
through `connection-service.ts`, `iam.ts`, `query-service.ts`, and `mcp.ts`.

Verified locally: Node v22.23.1 exposes `node:sqlite`
(`DatabaseSync,StatementSync,constants,backup`) with an experimental warning.

---

## Phase 0 — Store foundation

*Nothing else can land first. This is the load-bearing phase.*

**New: `server/lib/store.ts`**

`DatabaseSync` at `<configDir>/pgconsole.db`, resolved as:
`PGCONSOLE_DATA_DIR` → Electron `app.getPath('userData')` → `%APPDATA%\pgconsole`
→ `$XDG_CONFIG_HOME/pgconsole` → `~/.config/pgconsole`.

```
meta(key TEXT PRIMARY KEY, value TEXT)          -- schema_version, kdf_salt, key_check
connections(id TEXT PRIMARY KEY, name, host, port, database, username,
            password_enc, ssl_mode, ssl_root_cert, ssl_cert, ssl_key,
            lock_timeout, color, group_id, created_by, created_at, updated_at)
connection_labels(connection_id, label_id)
labels(id TEXT PRIMARY KEY, name, color)
connection_groups(id TEXT PRIMARY KEY, name, sort_order)
ai_providers(id TEXT PRIMARY KEY, name, vendor, model, base_url,
             api_key_enc, created_by, created_at, updated_at)
```

Idempotent `migrate()` keyed on `meta.schema_version`, run at boot.

**New: `server/lib/secrets.ts`**

- AES-256-GCM, serialized `v1:<iv_b64>:<ct_b64>:<tag_b64>`.
- Key resolution, in order:
  1. `PGCONSOLE_SECRET_KEY` (32-byte hex/base64) — headless, Docker, CI.
  2. Master password → `scrypt(pw, meta.kdf_salt, N=2^15)` — desktop, pgAdmin's model.
  3. No key configured → store accepts rows with **no** secret columns; any attempt
     to save a password or API key returns a typed `SECRETS_LOCKED` error the UI
     renders as "Set a master password to save credentials."
- `meta.key_check` holds a known plaintext encrypted under the active key, so a wrong
  master password is rejected up front instead of surfacing as GCM auth failures later.
- **Never** log or return plaintext secrets. Reads return `hasPassword: boolean`,
  matching the existing `toConnectionResponse` contract.

**Changed: `server/lib/config.ts`**

Merge store rows into the existing getters — `getConnections`, `getConnectionById`,
`getAIProviders`, `getAIProviderById`, `getLabels`. Each result gains
`source: 'toml' | 'store'`.

- Collision on id → **TOML wins**; store row is shadowed and a warning logged.
  Creation validates against both namespaces, so the UI rejects duplicates up front.
- TOML parsing/validation is untouched. All ~40 existing validation errors still fire.

**Changed: `server/index.ts`**

Split `testAllConnections()`: TOML connections keep fail-fast `process.exit(1)`
(preserves the current contract that a typo'd deployment config fails loudly);
store connections are tested best-effort, failures surfaced as connection status in
the UI. Then run `migrate()` before `testAllConnections()`.

**Tests** — `tests/` unit coverage for round-trip encryption, wrong-key rejection,
`SECRETS_LOCKED`, migration idempotency, TOML-wins collision, and the
sync-getter merge.

---

## Phase 1 — Ollama Cloud

Small, and independent of Phase 0. Good first landing.

**`server/ai/vendors.ts`** — add `'ollama-cloud'` to `Vendor` as a *preset*, not a new
code path:

```ts
case 'ollama-cloud':
  // Ollama Cloud speaks the OpenAI wire protocol; base_url is fixed, key required.
  return createOpenAICompatible({ name: 'ollama-cloud',
    baseURL: baseUrl ?? 'https://ollama.com/v1', apiKey })(model)
```

All session handling, trimming, and token caps are inherited unchanged.

**`server/lib/config.ts`** — accept `vendor = "ollama-cloud"`; `base_url` optional
(defaults to `https://ollama.com/v1`), `api_key` **required** (unlike bare
`openai-compatible`, which permits keyless local Ollama).

**Model discovery** — new `ListVendorModels` RPC in `proto/ai.proto`. For
`ollama-cloud` / `openai-compatible`, `GET {base_url}/models` with the key and return
ids, so Settings offers a dropdown instead of a free-text model field. Failure
degrades to free-text — never blocks saving.

**Docs** — `docs/configuration/config.mdx` + `pgconsole.example.toml`: document
`ollama-cloud`, and keep the existing keyless local-Ollama `openai-compatible`
example alongside it.

---

## Phase 2 — AI provider settings UI

**`proto/ai.proto`** — `CreateAIProvider`, `UpdateAIProvider`, `DeleteAIProvider`,
`TestAIProvider` (validates key/model with a 1-token round-trip before save),
`ListVendorModels`.

**`server/services/ai-service.ts`** — handlers. Store-backed only; TOML providers
return `FailedPrecondition` on mutation and render read-only with a "managed" badge.
Writes require `admin`; in no-auth/desktop mode all principals qualify (consistent
with existing no-auth behavior). Audit every mutation, key value redacted.

**Frontend** — real `/settings` route in `src/App.tsx` replacing the `OrgSettings.tsx`
stub. Tab: **AI Providers** — table, add/edit sheet (vendor select → model dropdown
from `ListVendorModels` → API key as write-only password field showing `••••` when
set), Test button, delete confirm. Existing `useSetting.ts` / TanStack Query patterns;
existing `src/components/ui/*` primitives only.

API keys are **write-only over the wire**: sent on save, never returned.

---

## Phase 3 — pgAdmin-style connection management

Mirrors pgAdmin's model: **server groups → servers**, a tabbed dialog, test-before-save,
and a master password gating saved credentials.

**`proto/connection.proto`** — add:

| RPC | Notes |
|---|---|
| `CreateConnection` | returns created connection |
| `UpdateConnection` | store-backed only |
| `DeleteConnection` | clears `connection-cache` + `schema-cache` entries |
| `TestConnectionParams` | tests **unsaved** form input — the pgAdmin behavior; distinct from existing id-based `TestConnection` |
| `ListConnectionGroups` / `CreateConnectionGroup` / … | server-group tree |

Extend `Connection` with `source`, `group_id`, `status`. Additive field numbers only —
no renumbering, so existing clients keep working.

**`server/services/connection-service.ts`** — handlers; `toConnectionResponse` gains
`source`/`group_id`/`status`. Password decrypted only at `createClient` call time in
`server/lib/db.ts`.

**IAM** (`server/lib/iam.ts`) — the subtle part. TOML connections keep today's exact
semantics. Store connections get an **implicit owner grant**: `created_by` holds
`admin` on that connection, so a user always sees what they created. Explicit
`[[iam]]` rules still apply on top and can widen access to a store connection by id.
Rules are unioned, as now. In no-auth mode `created_by` is null and everything is
accessible — unchanged behavior.

**Frontend**

- `ConnectionSwitcher.tsx` → grouped tree + "New connection…" / "Manage connections".
- Connection dialog, pgAdmin's four tabs: **General** (name, group, color, labels) /
  **Connection** (host, port, database, user, password, save-password) / **SSL**
  (mode + cert paths) / **Advanced** (`lock_timeout`).
- **Test** before save, inline result with latency.
- Master-password prompt on first credential save, unlock prompt on later launches.
- TOML connections shown with a "managed" badge, edit disabled, tooltip pointing at
  `pgconsole.toml`.

**Docs** — new `docs/features/connection-management.mdx`; `config.mdx` gains a
precedence note.

---

## Phase 3b — One connection per *server*, not per database

Requested follow-up: like pgAdmin, a connection should be a **server** you can browse
every database on, not a single fixed database.

### Verdict: feasible, **medium** complexity — and it belongs *inside* Phase 3

Roughly the same size as Phase 3 itself, weighted heavily toward the frontend. It must
land with Phase 3, not after: the connection dialog, the tree, and the URL shape are all
touched by both, and doing them separately means building the single-DB version twice.

### Why it is cheaper than it looks

The architecture already anticipated this in three places:

1. **There is no connection pool.** `createClient` uses `max: 1` and every call site
   ends the client in a `finally` ([db.ts:39](../server/lib/db.ts#L39),
   [query-service.ts:48](../server/services/query-service.ts#L48)). Switching database is
   just a different `database` string passed to `postgres()` — there is no pool keyed by
   connection to invalidate and no client-reuse hazard. **This is the single biggest
   reason the feature is affordable.**
2. **One server-side choke point.** `buildConnectionDetails(connectionId)` →
   `getConnectionDetails()` ([query-service.ts:40](../server/services/query-service.ts#L40))
   feeds ~20 RPCs. An optional `database` override there covers the entire query service.
   Only 5 `buildConnectionDetails` call sites exist repo-wide (1 query-service, 4 `mcp.ts`).
3. **Audit is already database-aware.** `auditSQL(actor, connection, database, …)` takes
   database as a parameter *separate from* connection
   ([audit.ts:118](../server/lib/audit.ts#L118)), and callers already pass
   `details.database`. **No audit schema change at all** — only
   [query-service.ts:1264](../server/services/query-service.ts#L1264), which reads
   `conn.database` from config, must read the *selected* database instead.

### Where the actual cost is

| Area | Work | Size |
|---|---|---|
| `proto/query.proto` | optional `database` on ~20 request messages. Additive field numbers → no wire break | S, mechanical |
| `GetDatabases` RPC | `SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn` | S |
| `server/lib/db.ts` | `buildConnectionDetails(id, databaseOverride?)`; validate the override against `GetDatabases` so it can't be used to reach an arbitrary host | S |
| **`server/lib/schema-cache.ts`** | **re-key `Map<connectionId>` → `connectionId:database`** | S but **correctness-critical** |
| `server/lib/connection-cache.ts` | unchanged — server version is per-server, not per-database | — |
| Tree gains a level | connection → schema → objects becomes server → **database** → schema → objects (`ObjectSidebar`, `ObjectTree`) | M |
| Frontend state re-keying | `schema-store.ts` (`state.connectionId`, `schemas`/`columns` Maps), `useSchemaStoreSync.ts`, `useEditorTabs.ts`, `useQuery.ts` — all keyed on `connectionId` alone today | **L — the bulk of the work** |
| URL state | `database` alongside `connectionId` in `src/lib/url.ts`, `EditorUrlParams`, `App.tsx` connection-scoped-route logic, `useEditorNavigation.ts` | M |
| Connection dialog | stored `database` becomes pgAdmin's **maintenance database** (default `postgres`) — the DB used to enumerate the rest — rather than the only DB | S |

`schema-cache` is called out as correctness-critical because it feeds schema context to
the AI. Left keyed by connection alone, switching database would silently hand the model
the *previous* database's schema. Wrong answers, no error.

### The one genuine blocker: IAM

`requireAnyPermission(user, connectionId)` is per-connection. pgAdmin has no IAM layer,
so it offers no precedent here.

**This is a security posture change, not just a feature.** Today a TOML connection
pins a user to exactly one database. Under a server-scoped model, anyone with `read` on
that connection can read **every database on that host**. For a governed,
multi-user deployment that is a silent privilege widening on existing installs.

Proposed resolution:

- Permissions stay **per-server**, and databases inherit them — simple, and matches how
  `getUserPermissions` works now.
- Server-scoped browsing is **opt-in per connection** (`all_databases = true`, default
  `false`). TOML connections keep today's single-database behavior unless explicitly
  opted in, so no existing deployment changes behavior on upgrade.
- Desktop/no-auth mode defaults it on — that is the pgAdmin-like experience, and with no
  IAM in play there is nothing to widen.
- Per-database IAM grants (`connection:database` rules) are a real extension of the IAM
  model. **Deferred** — not needed for the pgAdmin experience, and it would touch every
  IAM call site.

### Recommended sequencing

Fold into Phase 3, server-side first (proto + `database` override + `GetDatabases` +
schema-cache re-key) so it is verifiable via RPC before any UI exists. Then the tree
level, then state/URL re-keying last, since that is where the risk concentrates.

---

## Phase 4 — Windows `.exe`

**Refactor `server/index.ts`** — extract `createApp()` / `startServer({port, host})`
and keep `start()` as the CLI entry. This is what lets Electron reuse the server
in-process instead of shelling out to a second Node.

**New `electron/main.ts`** — `app.whenReady()` → `migrate()` → `startServer({host:
'127.0.0.1', port: 0})` → `BrowserWindow.loadURL('http://127.0.0.1:<port>')`. Native
menu, external links to the system browser, `will-quit` closes the pool. Master-password
prompt is a small pre-window modal.

Renderer stays a plain web client talking HTTP to localhost — so `nodeIntegration:
false`, `contextIsolation: true`, and **no IPC bridge and no preload data channel are
needed**, which sidesteps the usual Electron+SQLite renderer problem entirely.

**`electron-builder.yml`**

```yaml
appId: com.infoanalytica.pgconsole
files: [dist/**, electron/dist/**, node_modules/**]
asarUnpack:                       # .wasm / .node cannot load from inside asar
  - "**/node_modules/@libpg-query/**"
  - "**/node_modules/@electric-sql/pglite*/**"
  - "**/node_modules/pg/**"
win:
  target: [{ target: nsis, arch: [x64] }, { target: portable, arch: [x64] }]
```

**Gotchas to handle, not discover later**

- Electron major must bundle Node ≥ 22.5 for `node:sqlite`. Pin it, and assert
  `require('node:sqlite')` in a smoke test so a future Electron bump can't silently
  break the store.
- `.npmrc` lacks `node-linker=hoisted`; `electron-builder` mishandles pnpm's symlinked
  `node_modules`. Add it, or use `--config.nodeLinker`.
- `scripts/build-server.mjs` marks `pg` / `express` / `@libpg-query/parser` / `pglite`
  external — they must therefore be real files in the packaged `node_modules`, which is
  what `asarUnpack` above ensures. Add `node:sqlite` to `external`.
- `vite.config.ts` copies `libpg-query.wasm` to `dist/client` — verify it resolves
  under `app.asar.unpacked`.
- Unsigned `.exe` triggers SmartScreen. Note it in the README; code signing is a
  separate decision (cert procurement, not an engineering task).

**CI** — `windows-latest` job in `.github/workflows/publish.yml` uploading both
artifacts. Replace the fork's Docker-based `build-and-launch.bat` / `pgconsole.vbs` /
`WINDOWS_LAUNCHER_README.md`, which required Docker and only opened a browser in app
mode — superseded by a real desktop app.

---

## Sequencing

```
Phase 1 (Ollama Cloud)  ──────────────► independent, land first
Phase 0 (store + crypto) ─┬─► Phase 2 (provider UI)
                          └─► Phase 3 (connection UI) + 3b (server-scoped DBs)
                                 └─ 3b lands *with* 3, not after
Phase 4 (Electron) ───────────────────► needs Phase 0 for the data dir;
                                        otherwise parallel
```

Phase 3 + 3b together are the largest chunk of work in this plan.

## Risks

| Risk | Mitigation |
|---|---|
| `node:sqlite` experimental; API could shift | Pin Electron/Node; all access behind `store.ts` — swappable to `better-sqlite3` without touching callers |
| Master password lost → secrets unrecoverable | Explicit warning in UI; documented "reset store" path that clears secret columns and keeps connections |
| Store connections weaken the IAM story | Default-deny preserved: owner-only implicit grant, explicit `[[iam]]` still required to share |
| **Server-scoped browsing silently widens access on existing installs** | `all_databases` opt-in, default `false` for TOML connections (Phase 3b) |
| Stale `schema-cache` feeds the AI another database's schema | Re-key cache to `connectionId:database`; covered by a test |
| Electron bundle misses a WASM/native asset | `asarUnpack` + a packaged smoke test that opens a connection and runs a parse |
| Scope: 4 features, ~15 new/changed server files, new proto surface | Phase 1 ships standalone; Phase 0 lands with tests before any UI |

## Explicitly out of scope

- Porting the fork's raw-SDK `ollama` vendor (regression — see Context).
- Porting the fork's license/Enterprise gating (removed from this repo deliberately).
- macOS/Linux Electron targets (config is trivial to extend; not requested).
- Code-signing certificate procurement.
- Migrating existing TOML into the store (additive posture makes it unnecessary).
