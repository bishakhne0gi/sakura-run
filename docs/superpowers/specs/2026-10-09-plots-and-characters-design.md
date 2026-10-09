# Plots + Characters (v1) — Design

Status: approved in conversation 2026-10-09. Sub-project 1 of 4
(1 plots + characters, 2 look & feel, 3 marketplace/bidding, 4 real-money payouts).

## Goal

Turn the HSR walking sim into a place people can stake a claim in. Every real
building is a plot; each account claims one for free, first come first served;
owners mark it with a flag, a glow, a signboard and their character. Claims are
visible live to everyone in the world. No money changes hands in v1 — the
ownership records are the foundation the later marketplace builds on.

## Decisions

| Question | Decision |
| --- | --- |
| Plot unit | One plot per building footprint in `public/world.json` (9,763) |
| Acquisition | 1 free claim per account, first come first served |
| Owner features | Roof flag + colour glow, signboard, owner character idling outside, ownership map layer |
| Backend | Supabase: Postgres + Auth (Google, email magic link) + Realtime |
| Frontend | Stays vanilla Vite + Three.js; no framework added |
| Guests | Can explore and pick a character; sign-in is required only to claim |

Out of scope for v1: transfers, selling, bidding, currencies, payments, multiple
plots per user, interior editing, multiplayer avatars for players who are walking (only owners
standing at their plot are shown).

## Stable plot ids

Plot ids must survive world rebuilds or ownership silently moves.
`pipeline/build-world.mjs` emits `id` on every building:

- OSM sourced: `osm:w<wayId>` (or `osm:r<relationId>`)
- Overture sourced: `ov:<overtureId>`
- Mapflow sourced: `mf:<hash of rounded centroid + area>`

The build fails if two buildings share an id. A rebuild that drops an id that is
owned in the database is reported by `pipeline/check-plot-ids.mjs` (run before
deploying a new `world.json`); orphaned plots are kept in the table and flagged,
never deleted.

## Data model (Postgres)

```sql
profiles (
  id          uuid primary key references auth.users,
  display_name text not null check (char_length(display_name) between 2 and 20),
  character   text not null check (character in ('brian','granny','louise','michelle','remy')),
  colour      text not null check (colour ~ '^#[0-9a-f]{6}$'),
  created_at  timestamptz default now()
)

plots (
  building_id text primary key,              -- world.json building id
  owner_id    uuid not null unique references profiles(id),  -- unique ⇒ one plot per user
  sign_title  text check (char_length(sign_title) <= 24),
  sign_tagline text check (char_length(sign_tagline) <= 40),
  claimed_at  timestamptz default now(),
  orphaned    boolean default false
)

reports (id, building_id, reporter_id, reason, created_at)
```

- The primary key on `building_id` gives one owner per plot; the unique
  `owner_id` gives one plot per user. Both races are settled by the database.
- Claiming goes through an RPC `claim_plot(building_id)` that validates the id
  against an `valid_buildings` table (loaded from world.json at deploy time) and
  inserts. It returns either the row or a typed error: `taken`, `already_owner`,
  `invalid_building`, `not_signed_in`.
- `update_sign(title, tagline)` RPC runs a server-side word filter before writing.
- Row-level security: everyone may read `profiles` and `plots`; users may only
  insert/update their own rows, and only through the RPCs.
- Realtime is enabled on `plots` (insert/update/delete).

## Client architecture

New units, each with one job:

| File | Responsibility | Depends on |
| --- | --- | --- |
| `src/net/supabase.js` | Client singleton, auth session, sign-in/out | env `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| `src/net/plotstore.js` | Loads all plots once, subscribes to realtime, exposes `get(id)`, `all()`, `claim(id)`, `updateSign()`, emits `change` events; read-only mode when offline | supabase.js |
| `src/world/plotindex.js` | Pure: building id ↔ footprint, `buildingAt(x,z)`, `nearestBuilding(x,z,r)`, `freeNear(x,z,n)` (uniform grid hash) | world.json |
| `src/world/plots.js` | Renders ownership: instanced waving flags, owner-colour glow outline, signboard textures, owner characters (nearest 12, via crowd system) | plotstore, plotindex, crowd.js |
| `src/ui/picker.js` | Character picker: turntable of the 5 GLBs, name + colour; saved to localStorage for guests, to `profiles` on sign-in | supabase.js |
| `src/ui/claim.js` | The `E` prompt card (real name, Free / Owned by X), claim flow, sign editor, report button, celebration | plotstore, plotindex |
| `src/ui/map.js` (extend) | Owned/free layer, hover card, "find a free plot near me" | plotstore, plotindex |

`src/main.js` only gains wiring: build the index after world load, init the store,
call `plots.update()` per frame, and route `E` to `claim.js` when the player
faces a building (POI prompts keep priority when both apply).

Supabase is optional at runtime: with no env keys the game runs exactly as
today, plus the character picker, with all ownership UI hidden.

## Player flow

1. First visit: the picker opens (skippable; defaults to the current avatar).
   The choice drives the third-person avatar.
2. Walk up to a building → prompt shows the real name (POI/OSM name, otherwise
   "House on 27th Main") and status.
3. Free + `E` → sign-in sheet if needed → `claim_plot` → flag rises (0.8 s), glow
   fades in, petal-confetti burst, toast "You own <name>". Others see it within ~1 s.
4. Owner returns to their plot → `E` opens the sign editor.
5. Lost race → "Just claimed by X" + three nearest free plots marked on the minimap.

## Rendering budgets

- Flags: one `InstancedMesh`, vertex-shader wave, ≤ 9,763 instances; ≤ 1 draw call.
- Glow: owned footprints merged into one line/ribbon mesh per colour bucket,
  rebuilt incrementally on change (no per-frame rebuild).
- Signboards: canvas textures generated lazily within 120 m, LRU cache of 64.
- Owner characters: nearest 12 owned plots within 150 m, reusing crowd skinned
  instances; hidden in bird view.
- Target: no more than 1 ms per frame added on a mid-range laptop at 1,000 owned plots.

## Error handling

- Backend unreachable or no keys → read-only mode; the world is fully walkable and claim UI explains.
- RPC errors map to friendly copy; never a raw error string.
- Realtime disconnect → reconnect with backoff, then refetch the full plot list.
- Orphaned plots (building vanished in a rebuild) show in the owner's profile with
  a one-time free re-claim.

## Moderation

Server-side word list (English + common Kannada/Hindi transliterations), length
limits, report button; 3 reports hides a sign pending review. Display names follow
the same filter.

## Testing

- SQL tests (pgTAP or a Node script against a local Supabase): one plot per user,
  one owner per plot, concurrent claim race (two clients, one wins), RLS denies
  direct inserts, sign filter rejects blocked words.
- Unit tests (Vitest) for `plotindex.js`: lookups, nearest, free-near, and the id
  uniqueness check in the pipeline.
- Browser smoke test (Playwright): pick character → sign in with a test user →
  claim → second context sees the flag within 3 s → no console errors.
- Manual: frame time at 1,000 seeded owned plots.

## Later sub-projects (not in this spec)

- Look & feel: grass and foliage from the reference video, Morning/Golden/Night presets, fireflies, anime-styled real shopfronts.
- Marketplace: soft-currency bids on plots, built on `plots`.
- Real money: only after legal review (India's Online Gaming Act 2025; real-estate perception risk); cosmetic purchases are the preferred revenue path.
