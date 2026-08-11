# deskkit

Toolkit of utilities shared across Tauri+Bun-sidecar desktop apps. Ships raw
TypeScript, no build step — every consumer is Bun, and `exports` point directly at `./src/**/*.ts`.
Consumed as a git dependency, not published to a registry. The name is deliberately generic:
SQLite/Drizzle plumbing (`sqlite`) is the first module; more land later under their own subpaths.

## Stack

- pnpm (package management) + Bun (runtime) — no Turborepo, no changesets, no CI: single package,
  git-dependency consumption only.
- `@total-typescript/tsconfig` preset, biome (tabs, single quotes), `#/*` → `src/*` alias.
- Effect v4 beta (`effect@4.0.0-beta.102`, pinned exact — see the `ts-effect` skill).

## Dev

- `bun test` — exercises the full loop: a temp-dir db, the two fixture bundles under
  `test/fixtures/`, `applyEmbeddedMigrations` against a real connection.
- `bun run check:type` / `check:lint` / `format`.
- Regenerate a fixture's migration bundle after touching its schema:
  `cd test/fixtures/<domain> && bunx drizzle-kit generate && bun ../../../src/sqlite/gen-migrations.ts`.

## Architecture

- `src/sqlite/client.ts` — `openSqliteConnection`, a scoped `bun:sqlite` + drizzle connection
  (`SqliteOpenError` on failure).
- `src/sqlite/migrations.ts` — `applyEmbeddedMigrations` + `MigrationBundle` + `MigrationApplyError`,
  a port of drizzle's internal `dialect.migrate()` for bundles embedded at build time.
- `src/sqlite/gen-migrations.ts` — the `gen-migrations` bin: journal → embedded-bundle codegen,
  invoked from a consumer's own package as `bun -b gen-migrations`.
- `src/sqlite/testing.ts` — `withTempDb`, the temp-dir-and-cleanup dance every SQLite test needs.
- `test/fixtures/domain-{a,b}` — two independent drizzle schemas with committed bundles, standing in
  for two consumer domains sharing one db file.

## Why raw TS, why the internal-drizzle port

These sidecars ship as `bun build --compile` binaries, so the source `drizzle/` folder doesn't exist
at runtime and drizzle's folder-based `migrate()` is unusable. The fix: generate migrations normally,
bundle them into a TS module via Bun import attributes (`gen-migrations`), then apply them through a
port of drizzle's *internal* `dialect.migrate()` — the only entry point that accepts pre-read
migrations instead of a folder path.

## Gotchas

- **`applyEmbeddedMigrations`'s `migrationsTable` has no default, and must not get one.** Drizzle
  decides "already applied" by comparing a migration's *generation-time* timestamp against the single
  most recent row in one bookkeeping table — sound for one continuous history, not for two
  independently-timestamped bundles sharing a table. nisi shipped this bug once: two domains defaulted
  to `__drizzle_migrations`, and whichever bundle was generated later, if applied first, made the
  other's genuinely-new migration look already-applied and silently skipped it. See
  `test/sqlite.test.ts`'s "distinct migrationsTables" test.
- **The `DrizzleInternals` cast in `migrations.ts` is fragile.** `dialect`/`session` are
  constructor-only drizzle-orm fields with no public type — check them against the installed
  `drizzle-orm` version on every upgrade.
- `dbUse`/`DbError` (a query-result wrapper) and data-dir/path resolution are explicitly out of
  scope — apps resolve their own db paths and wrap their own queries.
