# deskkit

Shared utilities for Tauri+Bun-sidecar desktop apps.

A `bun build --compile` sidecar ships as one binary with no `drizzle/` folder on disk, so drizzle's
folder-based `migrate()` can't run at startup. deskkit's `sqlite` module solves that once — an Effect
`Layer` for the SQLite connection, and migrations applied from a bundle embedded in the binary instead
of read off disk. It's a generic name on purpose: this is the first module, and more will land under
their own subpaths as more gets shared across apps.

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

**2. Bundle the generated `drizzle/` folder into a TS module.** deskkit ships a `deskkit` bin with a
`gen-migrations` subcommand — add a script that runs it after `drizzle-kit generate`:

```jsonc
// package.json
"scripts": {
  "db:generate": "bun -b drizzle-kit generate && bun -b deskkit gen-migrations"
}
```

`deskkit gen-migrations` reads the `drizzle/` folder relative to your cwd — drizzle-kit 1.x's layout,
one `<timestamp>_<tag>/migration.sql` directory per migration, no journal file — and writes
`.gen/migrations.gen.ts`, importing each `.sql` file as a string via Bun's `with { type: "text" }`
attribute so `bun build --compile` embeds it in the binary. Commit both `drizzle/` and `.gen/` —
the compiled binary needs the latter, not just `drizzle-kit`.

`.gen/migrations.gen.ts` is generated output, not hand-maintained, and it isn't written to match any
particular formatter's style config.

<details>
<summary>Still on drizzle-kit's pre-1.x layout?</summary>

`gen-migrations` only reads the 1.x layout. If your `drizzle/` folder still has a `meta/_journal.json`,
run `drizzle-kit up` to convert it first — `gen-migrations` fails fast with a message saying so rather
than misreading the old layout.

</details>

**3. Provide the client layer and apply the bundle.**

```ts
import * as SqliteDrizzle from 'drizzle-orm/effect-sqlite-bun';
import { Effect, Layer } from 'effect';
import { applyEmbeddedMigrations, layerSqliteClient } from 'deskkit/sqlite';
import migrationBundle from './.gen/migrations.gen.ts';

const layerDb = Layer.mergeAll(
  layerSqliteClient({ filename: '/path/to/app.db' }),
  SqliteDrizzle.DefaultServices,
);

const program = Effect.gen(function* () {
  const db = yield* SqliteDrizzle.make();
  yield* applyEmbeddedMigrations(db, migrationBundle);
  return db;
}).pipe(Effect.provide(layerDb));
```

`layerSqliteClient` is a thin `Layer` around `@effect/sql-sqlite-bun`'s `SqliteClient.make` that also
runs `PRAGMA foreign_keys = ON` — the one pragma the library doesn't already default (`busy_timeout`
and `journal_mode = WAL` are `SqliteClient`'s own defaults).

## Multiple domains, one file

<details>
<summary><code>migrationsTable</code> defaults to drizzle's own default — override it for multiple domains</summary>

`applyEmbeddedMigrations`'s third argument, `migrationsTable`, defaults to `'__drizzle_migrations'`,
matching what drizzle itself uses when no name is given. That's fine for an app with one schema and
one migration lineage. It stops being fine the moment two independently-generated bundles apply
against the same db file and share a table name: drizzle decides "already applied" by migration
*name*, checked against the set of names already recorded in that one bookkeeping table — sound only
as long as every migration's name is unique within it, not guaranteed for two independently-generated
bundles sharing one. Whichever bundle is applied first makes the other's genuinely-new migration look
already-applied and silently skips it. The failure doesn't show up at migration time; it shows up as a
missing-table error the first time something queries the skipped domain's tables. If your app has more
than one domain sharing a db file, give each an explicit, distinct `migrationsTable` name:

```ts
yield* applyEmbeddedMigrations(db, ordersBundle, 'orders_migrations');
yield* applyEmbeddedMigrations(db, settingsBundle, 'settings_migrations');
```

</details>

There's no `SqliteDb` service tag beyond `SqliteClient.SqliteClient` itself — `layerSqliteClient` hands
back a client for one `filename`. Apps that open several files, or want their own service shape, wrap
it in their own `Layer`/`Context.Service`.

## Testing

`deskkit/sqlite/testing` exports `layerTempSqlClient`, a `SqliteClient` layer backed by a real db file
(not `:memory:` — the migration path needs an actual file) in a throwaway temp directory, removed when
the layer's scope releases. Requires `FileSystem.FileSystem` (e.g. `@effect/platform-bun`'s
`BunFileSystem.layer`):

```ts
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import { layerTempSqlClient } from 'deskkit/sqlite/testing';

const layerTest = Layer.mergeAll(
  layerTempSqlClient,
  SqliteDrizzle.DefaultServices,
).pipe(Layer.provide(BunFileSystem.layer));
```

## Limits

<details>
<summary>No query wrapper, no data-dir resolution, sqlite-only</summary>

- No query wrapper and no data-dir resolution. `layerSqliteClient` takes a full `filename` string —
  resolving where that path lives (platform data dir, env override, `:memory:` for tests) is on you.
- `applyEmbeddedMigrations` only knows drizzle-orm's sqlite-core effect databases
  (`bun:sqlite` and libsql-flavored clients built on `drizzle-orm/sqlite-core/effect`) — not Postgres.
- It reads `db._.session` — drizzle's own internal-but-exposed accessor, not part of a stable public
  API — and hands it to drizzle-orm's public `migrate()` (`drizzle-orm/sqlite-core/effect`). A drizzle
  upgrade can change that internal shape without a major version bump; if migrations start failing
  after bumping `drizzle-orm`, check `src/sqlite/migrations.ts` against what the new version actually
  constructs.

</details>
