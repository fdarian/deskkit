import { createHash } from 'node:crypto';
import type { QueryEffectHKTBase } from 'drizzle-orm/effect-core/query-effect';
import type { EmptyRelations } from 'drizzle-orm/relations';
import type { SQLiteEffectDatabase } from 'drizzle-orm/sqlite-core/effect';
import { migrate } from 'drizzle-orm/sqlite-core/effect';
import type { MigrationEntry } from './migration-layout.ts';

/** Shape produced by the `gen-migrations` codegen — every migration's directory name and raw SQL, embedded at build time via import attributes. Ordered: application order is array order, not something recovered from the entries themselves. */
export type MigrationBundle = {
	migrations: MigrationEntry[];
};

/**
 * Parses the `YYYYMMDDHHMMSS` timestamp prefix drizzle-kit 1.x's migration
 * directory names carry, mirroring drizzle-orm's own fs-based reader
 * (`formatToMillis` in `drizzle-orm/migrator.utils.js`). Used only for
 * `MigrationMeta.folderMillis`, which `migrate()` stores in its bookkeeping
 * table's `created_at` column but never reads back — ordering and
 * already-applied checks are both name-based (see `getMigrationsToRun` in
 * the same file). A real derivation, not a fabricated value.
 */
const folderMillisFromName = (name: string): number => {
	const timestamp = name.slice(0, 14);
	const year = Number(timestamp.slice(0, 4));
	const month = Number(timestamp.slice(4, 6)) - 1;
	const day = Number(timestamp.slice(6, 8));
	const hour = Number(timestamp.slice(8, 10));
	const minute = Number(timestamp.slice(10, 12));
	const second = Number(timestamp.slice(12, 14));
	return Date.UTC(year, month, day, hour, minute, second);
};

/**
 * Dialect-agnostic drizzle-orm effect database — matches both `bun:sqlite`
 * and libsql clients built on `drizzle-orm/sqlite-core/effect`. Left generic
 * over `TEffectHKT` (rather than fixed to the base `QueryEffectHKTBase`) so
 * callers passing a concrete client (e.g. `EffectSQLiteBunDatabase`) keep
 * their client's real error/context types instead of widening them to
 * `unknown`.
 */
type MigratableDb<TEffectHKT extends QueryEffectHKTBase> = SQLiteEffectDatabase<
	TEffectHKT,
	unknown,
	EmptyRelations
>;

/**
 * Applies one embedded migration bundle to a sqlite-flavored drizzle-orm
 * effect client. Unlike drizzle's folder-based `migrate()` helpers, this
 * never touches the filesystem — the bundle is passed in fully formed — so
 * it keeps working inside a `bun build --compile` binary, where the source
 * `drizzle/` folder doesn't exist on disk.
 *
 * Builds `MigrationMeta[]` by hand from the embedded bundle and hands it to
 * drizzle-orm's public `migrate()` (`drizzle-orm/sqlite-core/effect`) along
 * with `db._.session` — the folder-reading `migrate()` helpers shipped per
 * driver package (e.g. `drizzle-orm/effect-sqlite-bun`) call
 * `readMigrationFiles`, which needs a real `drizzle/` folder on disk, so
 * they're unusable here regardless of the binary problem above. `bps` is
 * hardcoded `true`: `MigrationMeta` declares it, but `migrate()` never reads
 * it back (only `sql`, `hash`, `folderMillis`, and name-based bookkeeping
 * matter), so there's nothing real to derive it from.
 *
 * `migrationsTable` defaults to `'__drizzle_migrations'`, matching drizzle's
 * own SQLite default — fine for a single-lineage app. Apps with more than
 * one domain sharing a db file must pass an explicit per-domain name:
 * drizzle decides "already applied" by migration *name*, checked against the
 * set of names already recorded in that one bookkeeping table — sound as
 * long as every migration's name is unique within the table, not guaranteed
 * for two independently-generated bundles sharing one table. If two domains
 * share a table name and one of their migration names genuinely collides
 * (e.g. both hand-name a migration the same thing, or two `drizzle-kit
 * generate` runs happen to land the same index *and* random suffix), the
 * second domain's migration looks "already applied" and is silently
 * skipped — its tables never get created, first surfacing as a
 * missing-table error at query time, not at migration time.
 */
export const applyEmbeddedMigrations = <TEffectHKT extends QueryEffectHKTBase>(
	db: MigratableDb<TEffectHKT>,
	bundle: MigrationBundle,
	migrationsTable = '__drizzle_migrations',
) => {
	const migrations = bundle.migrations.map((entry) => ({
		sql: entry.sql.split('--> statement-breakpoint'),
		bps: true,
		folderMillis: folderMillisFromName(entry.name),
		hash: createHash('sha256').update(entry.sql).digest('hex'),
		name: entry.name,
	}));

	return migrate(migrations, db._.session, { migrationsTable });
};
