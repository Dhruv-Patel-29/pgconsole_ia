# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Internal InfoAnalytica staff only. No external clients or customers use this tool, and no
part of it is client-facing. Three roles each run their own install against the same shared
databases, each authenticating as their own Postgres user:

- **Analysts** — write `SELECT`s to answer business questions. Lean hardest on AI
  text-to-SQL, autocomplete, and export. Least likely to know Postgres internals.
- **Data/AI ops** — inspect what processing pipelines produced: did the batch land, how many
  rows, what did the model return, which files failed. Their tables arrive from outside the
  app and change shape often.
- **Engineers and DBAs** — schema work, DDL, index and lock investigation, session
  termination. Need the object browser and admin surface more than the AI.

The interface must serve all three without a role switch: an analyst and a DBA see the same
screen, and only their granted permissions differ.

## Product Purpose

One capable Postgres client that everyone at InfoAnalytica uses, replacing the current spread
of pgAdmin, DBeaver, and `psql`. Each person connects as themselves, so the database already
knows who they are and what they may do; the console's job is to make that work fast,
legible, and hard to get wrong.

Success is that (a) an analyst who does not know Postgres can get a correct answer out of it,
(b) the person's own credentials stay safe on their machine, and (c) a mistake is visible
before it is applied rather than after.

## Positioning

Not a market position — an internal one. Note what it is *not*: because each person connects
as their own Postgres user, pgconsole is **not** the access-control layer here. Postgres's own
roles and `GRANT`s are. The console is a better client, not a gatekeeper, and no feature may
be justified on the grounds that it gates access.

The reason to run this instead of the tools it replaces:

- **A real Postgres parser drives the editor.** Autocomplete, error detection, and
  per-statement classification are parsed, not pattern-matched, so the editor understands
  CTEs, subqueries, and window functions rather than guessing at them.
- **Query, edit results, stage changes, and apply in one view**, with a diff preview before
  anything is written.
- **Schema-aware AI is built in**, and can be pointed at a local model instead of a vendor.
- It is one tool the whole team shares, instead of three people on pgAdmin, DBeaver, and
  `psql` with three different mental models.

## Operating Context

- **Deployment: a desktop `.exe` per person.** Each person installs their own copy and
  connects with **their own personal Postgres user** to the shared server. This is the primary
  and intended distribution, not a convenience wrapper.
- **Consequences that follow from that, and that future work must not contradict:**
  - Each install holds that person's own database credentials in its local encrypted store, so
    the **master password protecting that store is the most safety-critical surface in the
    product**. If it silently fails to persist or unlock, the tool is unusable.
  - Authorization is Postgres's, not pgconsole's. A permission error is something Postgres
    said, and the interface should present it as such rather than implying the console decided.
  - There is no shared server instance, so audit, IAM, and cross-user features have no home
    today. This is why the enterprise roadmap is deferred rather than sequenced.
  - Anything per-user — history, saved queries, layout, preferences — lives on that person's
    machine and is theirs alone.
  - Shipping a change means shipping an installer. Windows build ergonomics are a product
    concern, not a build detail.
- **Databases are multi-tenant per server.** A single connection covers every database on a
  server, and people switch databases mid-session. The AI, the object tree, and the schema
  selector all have to follow the switch.
- **Tables arrive from outside the app.** Pipeline output lands as mixed-case, quote-requiring
  identifiers (`AWS_New_Batch_4_fs`, `AB_SMB_2026`) with repeated shapes across many tables —
  commonly `id`, `file_name`, `model_response`, `processed_at`. Dozens of tables can be
  structurally identical, so a name is often the only thing distinguishing them.
- Config lives in `pgconsole.toml` and, for connections and AI providers, in an encrypted
  local store managed through the UI.

## Capabilities and Constraints

Confirmed and working: SQL editor with parser-backed autocomplete, linting, formatting, and
folding; result grid with staged inline edits and diff preview; schema and object browser;
AI assistant (text-to-SQL, explain, fix, rewrite, change-risk assessment) across OpenAI,
Anthropic, Google, and Ollama including local models; MCP server exposing governed access to
external agents; connection-scoped IAM with seven disjoint permissions and default deny;
OIDC login via Google, Okta, and Keycloak; audit log; white-label branding slot; Electron
desktop build.

Constraints future work must respect:

- **Fork of `pgplex/pgconsole`** (upstream v1.3.0). Divergence has a maintenance cost, so
  gratuitous restructuring of upstream code is expensive even when it looks tidier.
- **The audit log is process-local and does not survive a restart**
  ([server/lib/audit.ts](server/lib/audit.ts)). Do not describe it as compliance-grade.
- **pgconsole's own IAM is effectively inert in this deployment.** It is opt-in, and with no
  `[[iam]]` rules every principal has full access — which is correct here, because Postgres
  is doing the authorizing. Do not build UI that implies the console is enforcing permissions.
- **The local encrypted store is the credential boundary.** Each install holds one person's
  database passwords and AI keys behind a master password. Regressions here are severe.
- **Renaming the app's data directory strands existing installs.** `app.setName('pgconsole')`
  determines `%APPDATA%`, so `pgconsole`, `pgconsole.toml`, `pgconsole.db`, and the
  `PGCONSOLE_*` environment variables are functional identifiers, not branding. Leave them.
- `server/` has 56 pre-existing type errors and is excluded from the default build.

Explicitly undecided — record, do not assume:

- **Data sensitivity is unestablished.** Whether these databases hold client data under
  contractual obligation, regulated PII, or only low-sensitivity internal data was not
  answered. No masking, retention, or AI-egress claim may be made until it is.
- **The enterprise roadmap in [plans/feature_plan.md](plans/feature_plan.md) is deferred.**
  It is a proposal, not a commitment. Nothing in it is in flight.

## Brand Commitments

**Full rebrand: this is InfoAnalytica's product.** The `pgconsole` name and identity are
replaced throughout the interface and become an implementation detail nobody using the tool
sees. Upstream attribution remains in the repository and license, not in the UI.

Binding assets and values:

- **Logo:** [ia_assets/logo.svg](ia_assets/logo.svg) — a horizontal lockup, 246×42, mark plus
  wordmark, currently untracked and not yet wired into the app.
- **Brand color:** a violet-to-magenta gradient, `#6C63FF` → `#BF59FE`, taken from the logo
  itself. This replaces the incumbent blue `#2f63f0`.

**Name:** the app is **iA Console**; InfoAnalytica is the company that owns it. The company
name was used as the app name initially and read oddly in a Start Menu. The logo carries the
company identity; the app name is what appears in the OS.

Undecided: whether the existing `BrandingConfig` slot is the mechanism or the branding stays
hardcoded.

## Evidence on Hand

- `ia_assets/logo.svg` is the only InfoAnalytica brand asset in the repository.
- No brand guidelines, typeface license, secondary marks, dark-mode logo variant, or written
  voice guide has been provided.
- No customer names, testimonials, metrics, or case studies exist here, and none may be
  invented — this is an internal tool with no marketing surface.

## Product Principles

1. **One screen, three literacies.** An analyst who does not know Postgres and a DBA who does
   use the same interface. Power stays reachable without making the simple path intimidating.
2. **Names are load-bearing.** When dozens of tables share an identical shape, the identifier
   is the only signal that distinguishes them — so table, database, and schema identity must
   be visible and unambiguous at every moment, never inferred.
3. **State the truth about state.** Which database, which schema, which connection, which
   permissions, whether a change has been applied. Ambient context that the user has to guess
   at is how the wrong table gets queried.
4. **Mistakes are the real threat, not attackers.** Everyone here is trusted and authenticated
   by Postgres itself; the damage model is a well-meaning person running the wrong `UPDATE`.
   Design for reversibility and pre-flight clarity over hardening.
5. **Do not overclaim governance.** Audit, IAM, and AI-egress language must match what the
   code actually does today — and in this deployment, the console governs nothing. Postgres
   does.
6. **The install is part of the product.** People run their own copy, so the first launch, the
   master-password prompt, and the update path are the product's front door, not setup chores.
