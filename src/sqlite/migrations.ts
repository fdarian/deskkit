import { createHash } from 'node:crypto';
import type { QueryEffectHKTBase } from 'drizzle-orm/effect-core/query-effect';
import type { EmptyRelations } from 'drizzle-orm/relations';
import type { SQLiteEffectDatabase } from 'drizzle-orm/sqlite-core/effect';
import { migrate } from 'drizzle-orm/sqlite-core/effect';
import { Effect, Schema } from 'effect';

/** A journal entry whose SQL is missing from the embedded bundle's `files`. */
export class MigrationApplyError extends Schema.TaggedErrorClass<MigrationApplyError>()(
	'MigrationApplyError',
	{ tag: Schema.String },
) {}

/** One entry in drizzle-kit's `drizzle/meta/_journal.json`. */
export const JournalEntry = Schema.Struct({
	idx: Schema.Number,
	when: Schema.Number,
	tag: Schema.String,
	breakpoints: Schema.Boolean,
});

/** The whole `_journal.json` file drizzle-kit writes alongside a migration's SQL. `gen-migrations` decodes it; the shape also defines the embedded bundle's `journal` field below. */
export const Journal = Schema.Struct({
	entries: Schema.Array(JournalEntry),
});

/** Shape produced by the `gen-migrations` codegen — a drizzle journal plus its raw SQL, embedded at build time via import attributes. */
export type MigrationBundle = {
	journal: typeof Journal.Type;
	files: Record<string, string>;
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
 * Builds `MigrationMeta[]` by hand from the embedded journal and hands it to
 * drizzle-orm's public `migrate()` (`drizzle-orm/sqlite-core/effect`) along
 * with `db._.session` — the folder-reading `migrate()` helpers shipped per
 * driver package (e.g. `drizzle-orm/effect-sqlite-bun`) call
 * `readMigrationFiles`, which needs a real `drizzle/` folder on disk and
 * rejects drizzle-kit's `meta/_journal.json` layout as an "old migration
 * folder", so they're unusable here regardless of the binary problem above.
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
) =>
	Effect.gen(function* () {
		const migrations = yield* Effect.forEach(
			bundle.journal.entries,
			(entry) => {
				const raw = bundle.files[entry.tag];
				if (raw === undefined) {
					return Effect.fail(new MigrationApplyError({ tag: entry.tag }));
				}
				return Effect.succeed({
					sql: raw.split('--> statement-breakpoint'),
					bps: entry.breakpoints,
					folderMillis: entry.when,
					hash: createHash('sha256').update(raw).digest('hex'),
					name: entry.tag,
				});
			},
		);

		yield* migrate(migrations, db._.session, { migrationsTable });
	});
