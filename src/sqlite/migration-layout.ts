/**
 * Reads drizzle-kit 1.x's migrations folder layout: one directory per
 * migration, named `<14-digit-UTC-timestamp>_<tag>` (e.g.
 * `20260811173454_tidy_wendell_rand`), each holding a `migration.sql` (and a
 * `snapshot.json` this package has no use for). There's no journal file in
 * this layout — ordering is purely the directory name's sort order, which
 * the timestamp prefix's fixed width makes safe to do lexicographically; the
 * same guarantee drizzle-orm's own fs-based reader relies on
 * (`readMigrationFiles` in `drizzle-orm/migrator.js`, which sorts migration
 * directory names with `localeCompare`). Every migration directory name is
 * validated against that shape (`MalformedMigrationNameError` if it fails) —
 * an unenforced assumption here would silently misorder migrations, or feed
 * `folderMillisFromName` (`migrations.ts`) a name it can't parse into a real
 * timestamp.
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

/**
 * `name`, a directory under `migrationsDir` holding a `migration.sql`,
 * doesn't start with the `<14-digit-timestamp>_` prefix every ordering and
 * `folderMillis` derivation in this module assumes. A directory this
 * malformed is far more likely a real migration deskkit can't safely place
 * than an unrelated folder, so it's a hard failure rather than a skip.
 */
export class MalformedMigrationNameError extends Schema.TaggedErrorClass<MalformedMigrationNameError>()(
	'MalformedMigrationNameError',
	{ migrationsDir: Schema.String, name: Schema.String },
) {}

/** One migration directory: its name (the sortable `<timestamp>_<tag>` directory name, also the value drizzle's bookkeeping table records as `name`) and its raw SQL. */
export type MigrationEntry = { name: string; sql: string };

/** The invariant every migration directory name must satisfy for lexicographic sort and `folderMillisFromName` (`migrations.ts`) to be safe: a fixed-width 14-digit UTC timestamp, then an underscore, then a non-empty tag. */
const migrationDirectoryName = /^\d{14}_.+$/;

const readMigrationEntry = (migrationsDir: string, name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const sqlPath = path.join(migrationsDir, name, 'migration.sql');
		const isMigrationDir = yield* fs.exists(sqlPath);
		if (!isMigrationDir) return undefined;

		if (!migrationDirectoryName.test(name)) {
			return yield* new MalformedMigrationNameError({ migrationsDir, name });
		}

		const sql = yield* fs.readFileString(sqlPath);
		return { name, sql };
	});

/** Reads and orders every migration under `migrationsDir`, failing with `LegacyMigrationsLayoutError` if it's still on the pre-1.x layout, or `MalformedMigrationNameError` if a migration directory's name doesn't carry the timestamp prefix ordering depends on. */
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
