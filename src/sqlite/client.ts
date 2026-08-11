import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/**
 * Provides a `SqliteClient` for `config.filename`, with `PRAGMA foreign_keys
 * = ON` already run — SQLite defaults referential integrity off, and
 * `SqliteClient` doesn't run this pragma itself (busy_timeout and WAL are
 * already its own defaults; see `SqliteClient.SqliteClientConfig`).
 */
export const layerSqliteClient = (
	config: SqliteClient.SqliteClientConfig,
): Layer.Layer<SqliteClient.SqliteClient, SqlError> =>
	Layer.effect(
		SqliteClient.SqliteClient,
		Effect.gen(function* () {
			const client = yield* SqliteClient.make(config);
			yield* client.unsafe('PRAGMA foreign_keys = ON');
			return client;
		}),
	).pipe(Layer.provide(Reactivity.layer));
