# Design

<!-- impeccable:design-scope identity-layer -->

**Scope note.** This records the **InfoAnalytica identity layer** applied over pgconsole's
incumbent visual system, plus the constraints that layer introduced. It is not a full
description of the incumbent system — the layout, density, spacing, radius, and component
language all came from upstream and remain undocumented. Run `/impeccable document` if that
system needs recording too.

## What this rebrand was, and was not

A **scoped identity replacement on an established Operate surface**, not a redesign. The
incumbent composition, density, `--radius: 0`, and component vocabulary were kept deliberately:
three roles depend on this tool daily, and the request was to rebrand it, not to rebuild it.
No concept exploration was run, and that was the correct call for the ask.

What changed: brand color, logo, favicon, app icon, product name, installer identity, and every
site where a color literal bypassed the token system.

## Color

### The two violets, and why there are two

| Token | Value | Use |
|---|---|---|
| `--brand` | `oklch(0.597 0.224 279.8)` — `#6C63FF` | Graphics only. The logo, the app-icon tile. **Never behind text.** |
| `--brand-accent` | `oklch(0.662 0.240 309.8)` — `#BF59FE` | Gradient partner. Logo and icon tile only. |
| `--primary` | `oklch(0.58 0.224 279.8)` — `#685DF9` | Every interactive surface: buttons, links, active states, focus. |

The brand violet from `ia_assets/logo.svg` carries only **4.32:1** against white — below the
4.5:1 floor for the white button labels this UI puts on `--primary` everywhere. The blue it
replaced was 5.05:1, so using `#6C63FF` verbatim would have been a measurable accessibility
regression handed over as a rebrand.

`--primary` is therefore the same hue and chroma held one notch darker, reaching **4.65:1**. The
two are indistinguishable side by side; the difference only shows up in a contrast meter. Dark
mode's `--primary` is `oklch(0.55 0.2 279.8)`, which puts white labels at 5.21:1 and keeps the
button 3.4:1 clear of the card behind it.

`--brand-accent` measures 3.46:1 against white. It is a gradient endpoint, and text must never
sit on it.

### The gradient has exactly two homes

The logo and the app-icon tile. Not a restraint reflex — it was tried and measured:

- **It cannot sit behind text.** The magenta end is 3.46:1, so buttons, banners, and badges are
  all out.
- **At UI-element scale it does not read.** The active tab underline was built with
  `from-brand to-brand-accent` and inspected at 4× magnification: across a ~60px, 2px rule the
  gradient is indistinguishable from flat violet. It was reverted to `bg-primary`. Any accent
  small enough to be safe is too small for a gradient to show, so don't re-add it.

### Strategy: restrained

Neutrals plus one accent. This is an Operate surface — people are reading query results and
identifiers, and the brand's job is to be present in precise details, not to compete with the
data. Color was not extended into new territory.

Every blue-family token moved from hue 258.8/264.6 to **279.8**, with lightness and chroma left
untouched so existing contrast relationships survived the swap.

### Info stays blue

`--info` is deliberately **not** rebranded. It is a status color; the brand is now violet. If
notices turned violet too, "this is informational" and "this is InfoAnalytica" would be the same
signal and neither would read. `--success`, `--warning`, `--destructive`, and `--chart-*` are
untouched for the same reason — the chart ramp is a working categorical set.

### No color literals

24 hardcoded sites (`bg-blue-500`, `text-blue-600`, `focus:ring-blue-500`, `bg-[#2f63f0]`, …)
now route through `primary`, `ring`, or `accent`. A rebrand that leaves literals behind leaks the
old brand back in at the next feature. Two specifics worth keeping:

- Focus rings use `ring-ring`, the token that already existed for the job.
- The selected object in the tree is `bg-primary/15 text-accent-foreground` (**12.4:1**).
  `text-primary` on that tint measures only 4.1:1 and was rejected.

## Logo

`ia_assets/logo.svg` is the master lockup — mark, wordmark, and a
`DISCOVER • ENRICH • CURATE` tagline in a 246×42 frame.

**Every logo-bearing file is generated and git-ignored**, because this repository is a public
fork and the lockup is a company asset. `scripts/apply-brand.mjs` (`pnpm brand`, wired into
`dev`, `build`, and `build:desktop`) writes all of them; with no master present it writes
clearly-marked neutral placeholders so a public clone still builds. Never commit these files,
and never hand-edit them — change the master and regenerate.

| Asset | Contents |
|---|---|
| `logo-light-full.svg` | Mark + wordmark, **no tagline**, 246×42 |
| `logo-dark-full.svg` | Same, neutral lifted to `#FAFAFA` |
| `logo-light-icon.svg` | Mark alone, 42×42 |
| `logo-dark-icon.svg` | Same, neutral lifted |

Three constraints that produced those:

1. **The tagline is dropped from in-app use.** It occupies 6px of a 42px frame, so at the 30px
   the header displays it, it renders about 4px tall — illegible mush. Marketing copy has no
   business in a dense app header anyway.
2. **The master wordmark is `#2D2D2D` across 31 paths and vanishes on dark grounds.** Dark
   variants lift only that neutral; the violet gradient is untouched, since it clears a dark
   ground unaided. (No theme toggle ships today — `.dark` tokens exist but nothing sets the
   class. The dark variants are ready for when one does.)
3. **The mark is an exact 42×42 square**, so the icon crops with no rescaling or re-centering.

### Placement

- **Header, ≥`sm`:** full lockup at `h-6` (141px). At `h-7.5` it was 176px — 43% wider than the
  logo it replaced — and crowded the connection and database switchers sharing that bar.
- **Header, <`sm`:** mark only at `h-7`. The lockup covered the connection string outright at
  390px. Which database you are pointed at outranks the wordmark; see PRODUCT.md principle 2.
- **Sign-in:** full lockup at `h-9`, above the card. The lockup does the naming, so the heading
  states the task ("Sign in") instead of repeating the product name.
- **Header logo is not a control.** No link, no hover state. It previously opened
  `docs.pgconsole.com`, which a rebrand cannot keep.
- `BrandingConfig.logo` still overrides everything above, per-deployment.

### App icon

`build/icon.png`, 1024×1024 RGBA: brand-gradient tile, 14% corner radius, white mark at 62% of
the frame, transparent corners. Rasterised through Electron, which is already a devDependency,
so no new one is needed — and it therefore needs a display (`xvfb-run -a pnpm brand` when
headless). If it is skipped the desktop app falls back to Electron's default icon.

A white tile would disappear into a light Windows taskbar, and the mark's own `#2D2D2D` bubble
would disappear into a dark one — so the tile carries the gradient and the mark goes white.
Verified legible at 16/24/32/48/64/128px on both light and dark chrome. There was no icon at
all before this; installs shipped the default Electron logo.

## Type

Unchanged: `Geist Mono` throughout. The mechanical detector flags it as an overused face and it
is being kept anyway — this surface is entirely SQL, identifiers, and tabular data, which is
what monospace is *for*, and replacing the typeface is a redesign rather than a rebrand.

## Naming

The product is named by its logo, never in body text. No "InfoAnalytica Console" string exists in
the UI; the browser tab reads `InfoAnalytica` and the logo's `alt` carries the name for anyone
not seeing the mark.

**Functional identifiers are not branding and must not be renamed:** `pgconsole.toml`,
`pgconsole.db`, `PGCONSOLE_*`, the `pgconsole` CLI name, `@pgplex/pgconsole`, the
`pgconsole_token` cookie, and `app.setName('pgconsole')` in `electron/env.ts`. That last one
resolves `%APPDATA%`; renaming it strands every existing install's saved connections and master
password in the old folder. `electron-builder.yml` `productName` is safe to brand and is set to
`InfoAnalytica`.

## Attribution

This is a fork of Apache-2.0 licensed software. Upstream credit stays in the README, the LICENSE,
and the docs navbar (labelled "Upstream: pgplex/pgconsole"). Two claims were removed rather than
rebranded, because rebranding them would have made them false: the docs byline "From the makers
of Bytebase, pgschema, and Google Cloud SQL", and the "Live Demo" CTA pointing at a public
pgconsole-branded demo.
