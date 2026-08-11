import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import {
	applyEmbeddedMigrations,
	openSqliteConnection,
} from '../src/sqlite/index.ts';
import { withTempDb } from '../src/sqlite/testing.ts';
import domainABundle from './fixtures/domain-a/.gen/migrations.gen.ts';
import { widgetsA } from './fixtures/domain-a/schema.ts';
import domainBBundle from './fixtures/domain-b/.gen/migrations.gen.ts';

describe('openSqliteConnection', () => {
	test('opens with WAL journal mode and a non-zero busy_timeout', async () => {
		await withTempDb(async (dbPath) => {
			const pragmas = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const { sqlite } = yield* openSqliteConnection(dbPath);
						const journalMode = sqlite.query('PRAGMA journal_mode').get() as {
							journal_mode: string;
						};
						const busyTimeout = sqlite.query('PRAGMA busy_timeout').get() as {
							timeout: number;
						};
						return {
							journalMode: journalMode.journal_mode,
							busyTimeout: busyTimeout.timeout,
						};
					}),
				),
			);

			expect(pragmas.journalMode).toBe('wal');
			expect(pragmas.busyTimeout).toBeGreaterThan(0);
		});
	});

	test('closes the connection when the scope releases', async () => {
		await withTempDb(async (dbPath) => {
			const sqlite = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const connection = yield* openSqliteConnection(dbPath);
						return connection.sqlite;
					}),
				),
			);

			expect(() => sqlite.query('PRAGMA journal_mode').get()).toThrow();
		});
	});
});

describe('applyEmbeddedMigrations', () => {
	test('creates the bundle table under a given migrationsTable', async () => {
		await withTempDb(async (dbPath) => {
			const tableNames = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const { db, sqlite } = yield* openSqliteConnection(dbPath);
						yield* applyEmbeddedMigrations(
							db,
							domainABundle,
							'domain_a_migrations',
						);
						const rows = sqlite
							.query("SELECT name FROM sqlite_master WHERE type = 'table'")
							.all() as Array<{ name: string }>;
						return rows.map((row) => row.name);
					}),
				),
			);

			expect(tableNames).toContain('widgets_a');
			expect(tableNames).toContain('domain_a_migrations');
		});
	});

	test('defaults migrationsTable to __drizzle_migrations when omitted', async () => {
		await withTempDb(async (dbPath) => {
			const tableNames = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const { db, sqlite } = yield* openSqliteConnection(dbPath);
						yield* applyEmbeddedMigrations(db, domainABundle);
						const rows = sqlite
							.query("SELECT name FROM sqlite_master WHERE type = 'table'")
							.all() as Array<{ name: string }>;
						return rows.map((row) => row.name);
					}),
				),
			);

			expect(tableNames).toContain('__drizzle_migrations');
		});
	});

	/**
	 * Regression guard for the shipped nisi bug (see `AGENTS.md`): two
	 * independently-timestamped bundles applied to the same connection, each
	 * under its own `migrationsTable`, must both take effect — neither
	 * bundle's bookkeeping row can shadow the other's "already applied"
	 * check. Sharing one table (the old default-everywhere behavior) is
	 * exactly the scenario that silently dropped a domain's tables.
	 */
	test('two bundles under distinct migrationsTables both apply, without clobbering each other', async () => {
		await withTempDb(async (dbPath) => {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
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

						const tableNames = sqlite
							.query("SELECT name FROM sqlite_master WHERE type = 'table'")
							.all() as Array<{ name: string }>;
						const domainAMigrations = sqlite
							.query('SELECT COUNT(*) as count FROM domain_a_migrations')
							.get() as { count: number };
						const domainBMigrations = sqlite
							.query('SELECT COUNT(*) as count FROM domain_b_migrations')
							.get() as { count: number };

						return {
							tableNames: tableNames.map((row) => row.name),
							domainAMigrations: domainAMigrations.count,
							domainBMigrations: domainBMigrations.count,
						};
					}),
				),
			);

			expect(result.tableNames).toContain('widgets_a');
			expect(result.tableNames).toContain('widgets_b');
			expect(result.tableNames).toContain('domain_a_migrations');
			expect(result.tableNames).toContain('domain_b_migrations');
			// Each domain recorded its own migration — one table's bookkeeping
			// row didn't get skipped because the other's looked "already applied".
			expect(result.domainAMigrations).toBe(1);
			expect(result.domainBMigrations).toBe(1);
		});
	});

	test('round-trips a row through the migrated table', async () => {
		await withTempDb(async (dbPath) => {
			const rows = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const { db } = yield* openSqliteConnection(dbPath);
						yield* applyEmbeddedMigrations(
							db,
							domainABundle,
							'domain_a_migrations',
						);
						db.insert(widgetsA).values({ name: 'sprocket' }).run();
						return db.select({ name: widgetsA.name }).from(widgetsA).all();
					}),
				),
			);

			expect(rows).toEqual([{ name: 'sprocket' }]);
		});
	});
});
