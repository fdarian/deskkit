import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	applyEmbeddedMigrations,
	openSqliteConnection,
} from '../src/sqlite/index.ts';
import { tempDbPath } from '../src/sqlite/testing.ts';
import domainABundle from './fixtures/domain-a/.gen/migrations.gen.ts';
import { widgetsA } from './fixtures/domain-a/schema.ts';
import domainBBundle from './fixtures/domain-b/.gen/migrations.gen.ts';

describe('openSqliteConnection', () => {
	it.effect('opens with WAL journal mode and a non-zero busy_timeout', () =>
		Effect.gen(function* () {
			const dbPath = yield* tempDbPath;
			const { sqlite } = yield* openSqliteConnection(dbPath);
			const journalMode = sqlite.query('PRAGMA journal_mode').get() as {
				journal_mode: string;
			};
			const busyTimeout = sqlite.query('PRAGMA busy_timeout').get() as {
				timeout: number;
			};

			expect(journalMode.journal_mode).toBe('wal');
			expect(busyTimeout.timeout).toBeGreaterThan(0);
		}),
	);

	it.effect('closes the connection when the scope releases', () =>
		Effect.gen(function* () {
			const dbPath = yield* tempDbPath;
			const sqlite = yield* Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* openSqliteConnection(dbPath);
					return connection.sqlite;
				}),
			);

			expect(() => sqlite.query('PRAGMA journal_mode').get()).toThrow();
		}),
	);
});

describe('applyEmbeddedMigrations', () => {
	it.effect('creates the bundle table under a given migrationsTable', () =>
		Effect.gen(function* () {
			const dbPath = yield* tempDbPath;
			const { db, sqlite } = yield* openSqliteConnection(dbPath);
			yield* applyEmbeddedMigrations(db, domainABundle, 'domain_a_migrations');
			const rows = sqlite
				.query("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all() as Array<{ name: string }>;
			const tableNames = rows.map((row) => row.name);

			expect(tableNames).toContain('widgets_a');
			expect(tableNames).toContain('domain_a_migrations');
		}),
	);

	it.effect(
		'defaults migrationsTable to __drizzle_migrations when omitted',
		() =>
			Effect.gen(function* () {
				const dbPath = yield* tempDbPath;
				const { db, sqlite } = yield* openSqliteConnection(dbPath);
				yield* applyEmbeddedMigrations(db, domainABundle);
				const rows = sqlite
					.query("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all() as Array<{ name: string }>;
				const tableNames = rows.map((row) => row.name);

				expect(tableNames).toContain('__drizzle_migrations');
			}),
	);

	/**
	 * Regression guard for the shipped nisi bug (see `AGENTS.md`): two
	 * independently-timestamped bundles applied to the same connection, each
	 * under its own `migrationsTable`, must both take effect — neither
	 * bundle's bookkeeping row can shadow the other's "already applied"
	 * check. Sharing one table (the old default-everywhere behavior) is
	 * exactly the scenario that silently dropped a domain's tables.
	 */
	it.effect(
		'two bundles under distinct migrationsTables both apply, without clobbering each other',
		() =>
			Effect.gen(function* () {
				const dbPath = yield* tempDbPath;
				const { db, sqlite } = yield* openSqliteConnection(dbPath);
				yield* applyEmbeddedMigrations(
					db,
					domainABundle,
					'domain_a_migrations',
				);
				yield* applyEmbeddedMigrations(
					db,
					domainBBundle,
					'domain_b_migrations',
				);

				const rows = sqlite
					.query("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all() as Array<{ name: string }>;
				const tableNames = rows.map((row) => row.name);
				const domainAMigrations = sqlite
					.query('SELECT COUNT(*) as count FROM domain_a_migrations')
					.get() as { count: number };
				const domainBMigrations = sqlite
					.query('SELECT COUNT(*) as count FROM domain_b_migrations')
					.get() as { count: number };

				expect(tableNames).toContain('widgets_a');
				expect(tableNames).toContain('widgets_b');
				expect(tableNames).toContain('domain_a_migrations');
				expect(tableNames).toContain('domain_b_migrations');
				// Each domain recorded its own migration — one table's bookkeeping
				// row didn't get skipped because the other's looked "already applied".
				expect(domainAMigrations.count).toBe(1);
				expect(domainBMigrations.count).toBe(1);
			}),
	);

	it.effect('round-trips a row through the migrated table', () =>
		Effect.gen(function* () {
			const dbPath = yield* tempDbPath;
			const { db } = yield* openSqliteConnection(dbPath);
			yield* applyEmbeddedMigrations(db, domainABundle, 'domain_a_migrations');
			db.insert(widgetsA).values({ name: 'sprocket' }).run();
			const rows = db.select({ name: widgetsA.name }).from(widgetsA).all();

			expect(rows).toEqual([{ name: 'sprocket' }]);
		}),
	);
});
