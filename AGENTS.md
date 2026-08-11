# deskkit

Toolkit of utilities shared across Tauri+Bun-sidecar desktop apps. Ships raw
TypeScript, no build step — every consumer is Bun, and `exports` point directly at `./src/**/*.ts`.
Consumed as a git dependency, not published to a registry. The name is deliberately generic:
SQLite/Drizzle plumbing (`sqlite`) is the first module; more land later under their own subpaths.

## Stack

- pnpm (package management) + Bun (runtime) — no Turborepo, no changesets, no CI: single package,
  git-dependency consumption only.
- `@total-typescript/tsconfig` preset, biome (tabs, single quotes), `#/*` → `src/*` alias.
- Effect v4 beta (`effect@4.0.0-beta.102`, pinned exact) — including its CLI toolkit,
  `effect/unstable/cli` (see the `src/cli.ts` bullet below).

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
- `src/sqlite/client.ts` — `openSqliteConnection`, a scoped `bun:sqlite` + drizzle connection
  (`SqliteOpenError` on failure).
- `src/sqlite/migrations.ts` — `applyEmbeddedMigrations` + `MigrationBundle` + `MigrationApplyError`,
  a port of drizzle's internal `dialect.migrate()` for bundles embedded at build time.
- `src/sqlite/gen-migrations.ts` — journal → embedded-bundle codegen, exported as the
  `genMigrationsCommand` that `src/cli.ts` wires up as `deskkit gen-migrations`
  (`bun -b deskkit gen-migrations`).
- `src/sqlite/testing.ts` — `tempDbPath`, a scoped `Effect` for the temp-dir-and-cleanup dance every
  SQLite test needs.
- `test/fixtures/domain-{a,b}` — two independent drizzle schemas with committed bundles, standing in
  for two consumer domains sharing one db file.

## Why raw TS, why the internal-drizzle port

These sidecars ship as `bun build --compile` binaries, so the source `drizzle/` folder doesn't exist
at runtime and drizzle's folder-based `migrate()` is unusable. The fix: generate migrations normally,
bundle them into a TS module via Bun import attributes (`gen-migrations`), then apply them through a
port of drizzle's *internal* `dialect.migrate()` — the only entry point that accepts pre-read
migrations instead of a folder path.

## Gotchas

- **`applyEmbeddedMigrations`'s `migrationsTable` defaults to `'__drizzle_migrations'`** (drizzle's own
  SQLite default), fine for single-lineage apps. Apps with more than one domain sharing a db file must
  pass an explicit per-domain name — drizzle decides "already applied" by comparing a migration's
  *generation-time* timestamp against the single most recent row in one bookkeeping table, sound for one
  continuous history, not for two independently-timestamped bundles sharing a table. This bug has shipped
  before: two domains defaulted to `__drizzle_migrations`, and whichever bundle was generated later, if
  applied first, made the other's genuinely-new migration look already-applied and silently skipped it.
  See `test/sqlite.test.ts`'s "distinct migrationsTables" test.
- **The `DrizzleInternals` cast in `migrations.ts` is fragile.** `dialect`/`session` are
  constructor-only drizzle-orm fields with no public type — check them against the installed
  `drizzle-orm` version on every upgrade.
- **`effect/unstable/cli` is explicitly unstable, and `@effect/platform-node` ships betas every few days
  in lockstep with core.** Pin `@effect/platform-node` to the exact same `effect` beta (see `Stack`).
  On any bump, re-check that `Command.Environment`'s member union in `effect/unstable/cli`'s `Command`
  still matches `NodeServices`'s union in `@effect/platform-node` — `src/cli.ts` relies on
  `NodeServices.layer` fully satisfying what `Command.run` requires.
- `dbUse`/`DbError` (a query-result wrapper) and data-dir/path resolution are explicitly out of
  scope — apps resolve their own db paths and wrap their own queries.
- **The `test` script is `bun --bun vitest run`, not plain `vitest run`.** `src/sqlite/client.ts`
  imports `bun:sqlite`, so the suite only runs under Bun — but vitest's bin resolves via a
  `#!/usr/bin/env node` shebang, and plain `bun run test` hands the whole process tree, workers
  included, to the system Node.js. `--bun` keeps it on Bun. See `vitest.config.ts`'s top comment and
  its `bun-sql-text-import` plugin (works around Vite/rolldown not understanding Bun's
  `with { type: 'text' }` import attribute on the generated `.sql` imports).
