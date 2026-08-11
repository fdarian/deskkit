# deskkit

Shared utilities for Tauri+Bun-sidecar desktop apps.

A `bun build --compile` sidecar ships as one binary with no `drizzle/` folder on disk, so drizzle's
folder-based `migrate()` can't run at startup. deskkit's `sqlite` module solves that once — open a
`bun:sqlite` connection with the pragmas a desktop app actually needs, and apply migrations from a
bundle embedded in the binary instead of read off disk. It's a generic name on purpose: this is the
first module, and more will land under their own subpaths as more gets shared across apps.

Ships as raw TypeScript with no build step — `exports` point straight at `./src/**/*.ts`. Every
consumer is Bun, and this is a git dependency, not an npm package:

```jsonc
// package.json
"dependencies": {
  "deskkit": "github:fdarian/deskkit"
}
```

## The loop

Three steps get a domain's tables from a Drizzle schema to a compiled binary:

**1. Write a schema and generate migrations the normal way.**

```sh
bunx drizzle-kit generate
```

**2. Bundle the generated `drizzle/` folder into a TS module.** deskkit ships this as a bin — add a
script that runs it after `drizzle-kit generate`:

```jsonc
// package.json
"scripts": {
  "db:generate": "bun -b drizzle-kit generate && bun -b gen-migrations"
}
```

`gen-migrations` reads `drizzle/meta/_journal.json` relative to your cwd and writes
`.gen/migrations.gen.ts`, importing each `.sql` file as a string via Bun's `with { type: "text" }`
attribute so `bun build --compile` embeds it in the binary. Commit both `drizzle/` and `.gen/` —
the compiled binary needs the latter, not just `drizzle-kit`.

**3. Open a connection and apply the bundle.**

```ts
import { Effect } from 'effect';
import { applyEmbeddedMigrations, openSqliteConnection } from 'deskkit/sqlite';
import migrationBundle from './.gen/migrations.gen.ts';

const program = Effect.gen(function* () {
  const { db, sqlite } = yield* openSqliteConnection('/path/to/app.db');
  yield* applyEmbeddedMigrations(db, migrationBundle, 'my_domain_migrations');
  return db;
});
```

`openSqliteConnection` runs under `Effect.acquireRelease`, so the connection closes when the
enclosing `Scope` releases — wrap the whole program in `Effect.scoped` (or provide your own scope)
rather than calling it bare. It sets three pragmas on every connection: `foreign_keys = ON`,
`busy_timeout = 5000` (a second opener waits out the first's transaction instead of failing with
`SQLITE_BUSY`), and `journal_mode = WAL` (readers don't block a writer, or vice versa).

## `migrationsTable` has no default — give it one

`applyEmbeddedMigrations` takes a `migrationsTable` name, and it's a required argument, not an
optional one with drizzle's own default. This isn't stylistic: drizzle decides "already applied" by
comparing a migration's *generation-time* timestamp against the single most recent row in that one
bookkeeping table. That's correct for one continuous migration history — it silently breaks the
moment two independently-generated bundles share a table, because whichever bundle happens to have
the later timestamp, if applied first, makes the *other* bundle's genuinely-new migration look older
than "already applied" and skips it. The failure doesn't show up at migration time; it shows up as a
missing-table error the first time something queries the skipped domain's tables. If your app has one
schema and one migration lineage, still pick an explicit name — don't rely on the default resurfacing.

## Multiple domains, one file

deskkit hands back a connection, not a shared service. If your app has several domains that migrate
independently but live in the same SQLite file, open one connection and call
`applyEmbeddedMigrations` once per domain's bundle, each with its own `migrationsTable`:

```ts
const program = Effect.gen(function* () {
  const { db } = yield* openSqliteConnection(dbPath);
  yield* applyEmbeddedMigrations(db, ordersBundle, 'orders_migrations');
  yield* applyEmbeddedMigrations(db, settingsBundle, 'settings_migrations');
  return db;
});
```

There's no `SqliteDb` service tag or layer exported — some apps share one connection app-wide, others
open two files side by side. Wrap `openSqliteConnection`'s scoped `Effect` in your own
`Context.Service` to fit whichever shape your app needs.

## Testing

`deskkit/sqlite/testing` exports `withTempDb`, which hands your test a real db file path (not
`:memory:` — the migration path needs an actual file) inside a throwaway temp directory, cleaned up
once your callback settles:

```ts
import { withTempDb } from 'deskkit/sqlite/testing';

test('applies migrations', async () => {
  await withTempDb(async (dbPath) => {
    // openSqliteConnection(dbPath), assert against it
  });
});
```

## Limits

- No query wrapper and no data-dir resolution. `openSqliteConnection` takes a full `dbPath` string —
  resolving where that path lives (platform data dir, env override, `:memory:` for tests) is on you.
- `applyEmbeddedMigrations` only knows `bun:sqlite` and libsql-flavored drizzle clients
  (`BaseSQLiteDatabase<'sync' | 'async', ...>`) — not Postgres.
- It works by casting drizzle's internal `dialect`/`session` fields, which aren't part of drizzle's
  public API. A drizzle upgrade can change that internal shape without a major version bump; if
  migrations start failing after bumping `drizzle-orm`, check `src/sqlite/migrations.ts`'s
  `DrizzleInternals` type against what the new version actually constructs.

## Adopting deskkit

syne, nisi, and rheya each grew their own copy of this module before it was extracted. The emitted
bundle shape and the `gen-migrations` path resolution are unchanged, so swapping in deskkit doesn't
touch already-committed `drizzle/`/`.gen/` output — only these call sites:

- **rheya** (`packages/things`/`bundle`/`workspace`) — swap the `@repo/db-migrations` dependency for
  `deskkit`; the `db:generate` script line is unchanged. Add `'__drizzle_migrations'` as the explicit
  third argument to every `applyEmbeddedMigrations` call — its current calls pass none.
- **nisi** (`packages/settings`/`review`/`walkthrough`) — delete the three local
  `src/db/gen-migrations.ts` copies and change `db:generate` to
  `bun -b drizzle-kit generate && bun -b gen-migrations`. Only the import path changes; its call sites
  already pass their own table names (`__drizzle_migrations_settings`, etc.).
- **syne** (`apps/desktop/sidecar/db`) — same `db:generate` change as nisi, plus add
  `'__drizzle_migrations'` as the third argument, same as rheya.

**rheya's and syne's third argument must be exactly the literal `'__drizzle_migrations'`** — that's
the table name drizzle already uses when no `migrationsTable` is passed, so passing it explicitly is a
no-op against their existing databases. Any other name makes drizzle see an empty bookkeeping table,
replay every migration from scratch, and fail on `CREATE TABLE` against tables that already exist —
loud at boot, not silent data corruption, but it breaks the upgrade.
