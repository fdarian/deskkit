# deskkit

Toolkit of utilities shared across Tauri+Bun-sidecar desktop apps. Ships raw
TypeScript, no build step — every consumer is Bun, and `exports` point directly at `./src/**/*.ts`.
Consumed as a git dependency, not published to a registry. The name is deliberately generic:
SQLite/Drizzle plumbing (`sqlite`) and the sidecar boot handshake/lock (`sidecar`) are the first
two modules; more land later under their own subpaths.

## Stack

- pnpm (package management) + Bun (runtime) — no Turborepo, no changesets, no CI: single package,
  git-dependency consumption only.
- `@total-typescript/tsconfig` preset, biome (tabs, single quotes), `#/*` → `src/*` alias.
- Effect v4 beta (`effect@4.0.0-beta.102`, pinned exact) — including its CLI toolkit,
  `effect/unstable/cli` (see the `src/cli.ts` bullet below), and `@effect/sql-sqlite-bun`.
- drizzle-orm v1 release candidate (`1.0.0-rc.4`, pinned exact alongside `drizzle-kit`) — its Effect
  integration (`drizzle-orm/sqlite-core/effect`, `drizzle-orm/effect-sqlite-bun`) is what
  `src/sqlite/migrations.ts` and `client.ts` build on.

## Dev

- `bun run test` (vitest, via `@effect/vitest`) — exercises the full loop: a temp-dir db, the two
  fixture bundles under `test/fixtures/`, `applyEmbeddedMigrations` against a real connection.
- `bun run check:type` / `check:lint` / `format`.
- Regenerate a fixture's migration bundle after touching its schema:
  `cd test/fixtures/<domain> && bunx drizzle-kit generate && bun ../../../src/cli.ts gen-migrations`.

## Architecture

- `src/cli.ts` — the `deskkit` bin, wiring only: assembles each module's command (currently just
  `sqlite`'s `gen-migrations`) under the `deskkit` root via `effect/unstable/cli`'s `Command`, and runs
  it with `@effect/platform-node`'s `NodeServices.layer` + `NodeRuntime.runMain`. New module commands slot
  in here the same way — no codegen logic lives in this file.
- `src/sqlite/client.ts` — `layerSqliteClient`, a thin `Layer` around `@effect/sql-sqlite-bun`'s
  `SqliteClient.make` that additionally runs `PRAGMA foreign_keys = ON` (the one pragma the library
  itself doesn't cover — busy_timeout and WAL are already its own defaults).
- `src/sqlite/migrations.ts` — `applyEmbeddedMigrations` + `MigrationBundle` + `MigrationApplyError`,
  builds a `MigrationMeta[]` by hand from an embedded journal and applies it through drizzle-orm's
  public `migrate()` (`drizzle-orm/sqlite-core/effect`).
- `src/sqlite/gen-migrations.ts` — journal → embedded-bundle codegen, exported as the
  `genMigrationsCommand` that `src/cli.ts` wires up as `deskkit gen-migrations`
  (`bun -b deskkit gen-migrations`).
- `src/sqlite/testing.ts` — `layerTempSqlClient`, a `SqliteClient` layer backed by a real db file in a
  throwaway temp directory, built on `layerSqliteClient` so tests also exercise the `foreign_keys`
  pragma.
- `test/fixtures/domain-{a,b}` — two independent drizzle schemas with committed bundles, standing in
  for two consumer domains sharing one db file.
- `src/sidecar/handshake.ts` — `SidecarHandshake` (the `{ port, token }` shape written to both
  `sidecar.lock` and `sidecar.json`), `publishSidecarJson`/`readSidecarJson` (temp-file+rename
  atomic publish and its retry-tolerant read), and `awaitSidecarHandshake` (polls for a *fresh*
  handshake, keyed off comparing tokens against a caller-supplied `previous`).
- `src/sidecar/lock.ts` — `acquireSidecarLock`/`releaseSidecarLock`, an `wx`-based (`O_EXCL`)
  cross-process lock over `sidecar.lock` guarding which process is allowed to own a data dir's
  sidecar. Extracted from two sibling apps' near-identical `sidecar/sidecar-lock.ts`; liveness of a
  lock's recorded owner is a caller-supplied `SidecarLivenessCheck`, not baked in, so this module
  takes no dependency on any app's RPC client.

## Why raw TS, why hand-built `MigrationMeta[]`

These sidecars ship as `bun build --compile` binaries, so the source `drizzle/` folder doesn't exist
at runtime and drizzle's folder-based `migrate()` helpers are unusable — including the ones shipped per
driver package (e.g. `drizzle-orm/effect-sqlite-bun`'s own `migrate()`), which call `readMigrationFiles`
under the hood and need a real `drizzle/` folder on disk. The fix: generate migrations normally, bundle
them into a TS module via Bun import attributes (`gen-migrations`), then build a `MigrationMeta[]` from
that embedded journal by hand and hand it to drizzle-orm's public, driver-agnostic
`migrate()` (`drizzle-orm/sqlite-core/effect`) — the one entry point that accepts pre-read migrations
instead of a folder path.

## Gotchas

- **`applyEmbeddedMigrations`'s `migrationsTable` defaults to `'__drizzle_migrations'`** (drizzle's own
  SQLite default), fine for single-lineage apps. Apps with more than one domain sharing a db file must
  pass an explicit per-domain name — drizzle decides "already applied" by migration *name*, checked
  against the set of names already recorded in that one bookkeeping table, sound as long as every
  migration's name is unique within the table, not guaranteed for two independently-generated bundles
  sharing one. This bug has shipped before (back when the check was timestamp-based rather than
  name-based): two domains defaulted to `__drizzle_migrations`, and whichever bundle was generated
  later, if applied first, made the other's genuinely-new migration look already-applied and silently
  skipped it. See `test/sqlite.test.ts`'s "distinct migrationsTables" test.
- **`effect/unstable/cli` is explicitly unstable, and `@effect/platform-node` ships betas every few days
  in lockstep with core.** Pin `@effect/platform-node` to the exact same `effect` beta (see `Stack`).
  On any bump, re-check that `Command.Environment`'s member union in `effect/unstable/cli`'s `Command`
  still matches `NodeServices`'s union in `@effect/platform-node` — `src/cli.ts` relies on
  `NodeServices.layer` fully satisfying what `Command.run` requires.
- `dbUse`/`DbError` (a query-result wrapper) and data-dir/path resolution are explicitly out of
  scope — apps resolve their own db paths and wrap their own queries.
- **`acquireSidecarLock`'s `isAlive` must resolve to `false` for anything short of a confirmed-alive
  answer** (timeout, connection refused, non-2xx) — never let a transport failure surface as a typed
  error through it. That's what keeps the liveness check the *only* way to tell "the owning process
  crashed" apart from "it's genuinely still running" (never a staleness heuristic — not the lock
  file's age, not a PID that might have been reused), and what keeps `acquireSidecarLock`'s own
  declared errors (`SidecarAlreadyRunning | LockAcquisitionFailed`) from silently widening. A
  `SIGKILL`'d owner's lock surviving on disk is the expected steady-state case, not a bug — the
  Tauri/Rust side hard-kills the sidecar child on app exit, so `releaseSidecarLock` never runs in
  prod; recovery only ever happens through the next boot's liveness check.
- **A test that exercises `Effect.sleep` under `it.effect` needs `it.live` instead.** `it.effect`
  runs against `TestClock`'s virtual time, which nothing advances unless the test explicitly does —
  `Effect.sleep` inside a forked fiber just hangs until vitest's own timeout fires. See
  `test/sidecar.test.ts`'s `awaitSidecarHandshake` test, the only one so far that needs real time to
  pass for two fibers to interleave.
- **The `test` script is `bun --bun vitest run`, not plain `vitest run`.** `src/sqlite/client.ts`
  depends on `@effect/sql-sqlite-bun`, which imports `bun:sqlite`, so the suite only runs under Bun —
  but vitest's bin resolves via a `#!/usr/bin/env node` shebang, and plain `bun run test` hands the
  whole process tree, workers included, to the system Node.js. `--bun` keeps it on Bun. See
  `vitest.config.ts`'s top comment and its `bun-sql-text-import` plugin (works around Vite/rolldown not
  understanding Bun's `with { type: 'text' }` import attribute on the generated `.sql` imports).
