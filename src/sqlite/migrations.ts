import { createHash } from 'node:crypto';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { Effect, Schema } from 'effect';

/** Any failure applying an embedded migration bundle. */
export class MigrationApplyError extends Schema.TaggedErrorClass<MigrationApplyError>()(
	'MigrationApplyError',
	{ cause: Schema.Defect() },
) {}

/** Shape produced by the `gen-migrations` codegen — a drizzle journal plus its raw SQL, embedded at build time via import attributes. */
export type MigrationBundle = {
	journal: {
		entries: ReadonlyArray<{
			idx: number;
			when: number;
			tag: string;
			breakpoints: boolean;
		}>;
	};
	files: Record<string, string>;
};

/** `"sync" | "async"` covers both `bun:sqlite` (sync) and libsql (async) drizzle clients. */
type MigratableDb = BaseSQLiteDatabase<
	'sync' | 'async',
	unknown,
	Record<string, unknown>
>;

/**
 * `dialect` and `session` are constructor-only drizzle-orm fields — present
 * on every `BaseSQLiteDatabase` instance at runtime, but not part of its
 * public class type (no visibility modifier in the constructor signature).
 * This narrows the cast to just the two fields and the one method we call,
 * instead of casting the whole client to `any`.
 */
type DrizzleInternals = {
	dialect: {
		migrate: (
			migrations: ReadonlyArray<{
				sql: Array<string>;
				bps: boolean;
				folderMillis: number;
				hash: string;
			}>,
			session: unknown,
			config: { migrationsTable: string },
		) => Promise<void> | void;
	};
	session: unknown;
};

/**
 * Applies one embedded migration bundle to a sqlite-flavored drizzle client
 * (bun-sqlite or libsql). Unlike drizzle's folder-based `migrate()` helpers,
 * this never touches the filesystem — the bundle is passed in fully formed —
 * so it keeps working inside a `bun build --compile` binary, where the
 * source `drizzle/` folder doesn't exist on disk.
 *
 * Ports drizzle's internal `dialect.migrate()` call (the same one the public
 * `migrate()` helpers delegate to), since that's the only entry point that
 * accepts already-read migration objects instead of a folder path.
 *
 * `migrationsTable` is required, never defaulted, because drizzle decides
 * "already applied" by comparing each migration's *generation-time*
 * timestamp against the single most recent row in that one bookkeeping
 * table — sound for one continuous migration history, not for two
 * independently-timestamped bundles sharing one table. If two domains
 * default to the same table name, whichever bundle was generated *later* (by
 * wall-clock `drizzle-kit generate` time), if applied first, makes the
 * *other* domain's genuinely-new migration look older than "already
 * applied" and silently skips it — its tables never get created, first
 * surfacing as a missing-table error at query time, not at migration time.
 * Give every domain its own table name.
 */
export const applyEmbeddedMigrations = (
	db: MigratableDb,
	bundle: MigrationBundle,
	migrationsTable: string,
) =>
	Effect.tryPromise({
		try: async () => {
			const migrations = bundle.journal.entries.map((entry) => {
				const raw = bundle.files[entry.tag];
				if (raw === undefined) {
					throw new Error(`Missing embedded SQL for migration ${entry.tag}`);
				}
				return {
					sql: raw.split('--> statement-breakpoint'),
					bps: entry.breakpoints,
					folderMillis: entry.when,
					hash: createHash('sha256').update(raw).digest('hex'),
				};
			});
			const internal = db as unknown as DrizzleInternals;
			await internal.dialect.migrate(migrations, internal.session, {
				migrationsTable,
			});
		},
		catch: (cause) => new MigrationApplyError({ cause }),
	});
