/**
 * Reads drizzle-kit 1.x's migrations folder layout: one directory per
 * migration, named `<14-digit-UTC-timestamp>_<tag>` (e.g.
 * `20260811173454_tidy_wendell_rand`), each holding a `migration.sql` (and a
 * `snapshot.json` this package has no use for). There's no journal file in
 * this layout — ordering is purely the directory name's sort order, which
 * the timestamp prefix's fixed width makes safe to do lexicographically; the
 * same guarantee drizzle-orm's own fs-based reader relies on
 * (`readMigrationFiles` in `drizzle-orm/migrator.js`, which sorts migration
 * directory names with `localeCompare`).
 */
import { Effect, FileSystem, Path, Schema } from 'effect';

/**
 * `migrationsDir` still holds drizzle-kit's pre-1.x layout (a
 * `meta/_journal.json`) instead of the 1.x one-directory-per-migration
 * layout — run `drizzle-kit up` to convert it before `gen-migrations` can
 * read it.
 */
export class LegacyMigrationsLayoutError extends Schema.TaggedErrorClass<LegacyMigrationsLayoutError>()(
	'LegacyMigrationsLayoutError',
	{ migrationsDir: Schema.String },
) {}

/** One migration directory: its name (the sortable `<timestamp>_<tag>` directory name, also the value drizzle's bookkeeping table records as `name`) and its raw SQL. */
export type MigrationEntry = { name: string; sql: string };

const readMigrationEntry = (migrationsDir: string, name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const sqlPath = path.join(migrationsDir, name, 'migration.sql');
		const isMigrationDir = yield* fs.exists(sqlPath);
		if (!isMigrationDir) return undefined;

		const sql = yield* fs.readFileString(sqlPath);
		return { name, sql };
	});

/** Reads and orders every migration under `migrationsDir`, failing with `LegacyMigrationsLayoutError` if it's still on the pre-1.x layout. */
export const readMigrationLayout = (migrationsDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const isLegacy = yield* fs.exists(
			path.join(migrationsDir, 'meta', '_journal.json'),
		);
		if (isLegacy) {
			return yield* new LegacyMigrationsLayoutError({ migrationsDir });
		}

		const names = yield* fs.readDirectory(migrationsDir);
		const entries = yield* Effect.forEach(names, (name) =>
			readMigrationEntry(migrationsDir, name),
		);

		return entries
			.filter((entry): entry is MigrationEntry => entry !== undefined)
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	});
