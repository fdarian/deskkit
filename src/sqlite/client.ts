import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Effect, Schema, type Scope } from 'effect';

/** Any failure opening a `bun:sqlite` connection or wrapping it with drizzle. */
export class SqliteOpenError extends Schema.TaggedErrorClass<SqliteOpenError>()(
	'SqliteOpenError',
	{ cause: Schema.Defect() },
) {}

export type DrizzleClient = ReturnType<typeof drizzle>;

/**
 * Opens a `bun:sqlite` connection at `dbPath` and wraps it with drizzle,
 * under `Effect.acquireRelease` so the connection is closed when the
 * enclosing scope releases. Callers own `dbPath` resolution (data-dir
 * layout, `:memory:` vs a real file) — this only opens what it's given.
 *
 * Every connection sets the same three pragmas: `foreign_keys` (referential
 * integrity is off by default in SQLite), `busy_timeout` (a second opener —
 * another process, a stray debug script, `drizzle-kit studio` — waits out
 * the first's transaction instead of failing immediately with
 * `SQLITE_BUSY`), and `journal_mode = WAL` (readers don't block a writer,
 * or vice versa, at all — the right default for a desktop app with a
 * genuinely concurrent access pattern even in the common case).
 */
export const openSqliteConnection = (
	dbPath: string,
): Effect.Effect<
	{ sqlite: Database; db: DrizzleClient },
	SqliteOpenError,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const sqlite = yield* Effect.acquireRelease(
			Effect.try({
				try: () => {
					const connection = new Database(dbPath, { create: true });
					connection.exec('PRAGMA foreign_keys = ON');
					connection.exec('PRAGMA busy_timeout = 5000');
					connection.exec('PRAGMA journal_mode = WAL');
					return connection;
				},
				catch: (cause) => new SqliteOpenError({ cause }),
			}),
			(connection) => Effect.sync(() => connection.close()),
		);

		const db = yield* Effect.try({
			try: () => drizzle(sqlite),
			catch: (cause) => new SqliteOpenError({ cause }),
		});

		return { sqlite, db };
	});
