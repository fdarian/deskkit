import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { describe, expect, it } from '@effect/vitest';
import * as SqliteDrizzle from 'drizzle-orm/effect-sqlite-bun';
import { Effect, Layer } from 'effect';
import { applyEmbeddedMigrations } from '../src/sqlite/index.ts';
import { layerTempSqlClient } from '../src/sqlite/testing.ts';
import domainABundle from './fixtures/domain-a/.gen/migrations.gen.ts';
import { widgetsA } from './fixtures/domain-a/schema.ts';
import domainBBundle from './fixtures/domain-b/.gen/migrations.gen.ts';

const layerTest = Layer.mergeAll(
	layerTempSqlClient,
	SqliteDrizzle.DefaultServices,
).pipe(Layer.provide(BunFileSystem.layer));

const tableNames = Effect.gen(function* () {
	const client = yield* SqliteClient.SqliteClient;
	const rows = yield* client.unsafe<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table'",
	);
	return rows.map((row) => row.name);
});

describe('layerSqliteClient', () => {
	// The only thing this layer adds on top of `SqliteClient.make` — WAL and
	// busy_timeout are already `SqliteClient`'s own defaults, so nothing else
	// here would be testing our code rather than the library's.
	it.effect('enables foreign_keys', () =>
		Effect.gen(function* () {
			const client = yield* SqliteClient.SqliteClient;
			const rows = yield* client.unsafe<{ foreign_keys: number }>(
				'PRAGMA foreign_keys',
			);

			expect(rows[0]?.foreign_keys).toBe(1);
		}).pipe(Effect.provide(layerTest)),
	);
});

describe('applyEmbeddedMigrations', () => {
	it.effect('creates the bundle table under a given migrationsTable', () =>
		Effect.gen(function* () {
			const db = yield* SqliteDrizzle.make();
			yield* applyEmbeddedMigrations(db, domainABundle, 'domain_a_migrations');
			const names = yield* tableNames;

			expect(names).toContain('widgets_a');
			expect(names).toContain('domain_a_migrations');
		}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'defaults migrationsTable to __drizzle_migrations when omitted',
		() =>
			Effect.gen(function* () {
				const db = yield* SqliteDrizzle.make();
				yield* applyEmbeddedMigrations(db, domainABundle);
				const names = yield* tableNames;

				expect(names).toContain('__drizzle_migrations');
			}).pipe(Effect.provide(layerTest)),
	);

	/**
	 * Regression guard for the shipped bug described in `AGENTS.md`'s
	 * Gotchas: two bundles applied to the same connection, each under its
	 * own `migrationsTable`, must both take effect — neither bundle's
	 * bookkeeping row can shadow the other's "already applied" check.
	 * Sharing one table (the old default-everywhere behavior) is exactly
	 * the scenario that silently dropped a domain's tables.
	 */
	it.effect(
		'two bundles under distinct migrationsTables both apply, without clobbering each other',
		() =>
			Effect.gen(function* () {
				const client = yield* SqliteClient.SqliteClient;
				const db = yield* SqliteDrizzle.make();
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

				const names = yield* tableNames;
				const [domainAMigrations] = yield* client.unsafe<{ count: number }>(
					'SELECT COUNT(*) as count FROM domain_a_migrations',
				);
				const [domainBMigrations] = yield* client.unsafe<{ count: number }>(
					'SELECT COUNT(*) as count FROM domain_b_migrations',
				);

				expect(names).toContain('widgets_a');
				expect(names).toContain('widgets_b');
				expect(names).toContain('domain_a_migrations');
				expect(names).toContain('domain_b_migrations');
				// Each domain recorded its own migration — one table's bookkeeping
				// row didn't get skipped because the other's looked "already applied".
				expect(domainAMigrations?.count).toBe(1);
				expect(domainBMigrations?.count).toBe(1);
			}).pipe(Effect.provide(layerTest)),
	);

	it.effect('round-trips a row through the migrated table', () =>
		Effect.gen(function* () {
			const db = yield* SqliteDrizzle.make();
			yield* applyEmbeddedMigrations(db, domainABundle, 'domain_a_migrations');

			yield* db.insert(widgetsA).values({ name: 'sprocket' });
			const rows = yield* db.select({ name: widgetsA.name }).from(widgetsA);

			expect(rows).toEqual([{ name: 'sprocket' }]);
		}).pipe(Effect.provide(layerTest)),
	);
});
