import type { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect, FileSystem, Layer } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { layerSqliteClient } from './client.ts';

/**
 * A `SqliteClient` layer backed by a real db file in a throwaway temp
 * directory, removed when the layer's scope releases. A real file, not
 * `:memory:` — the embedded-migration path this is meant to exercise reads
 * `bun:sqlite`'s own file, not an in-memory connection. Requires
 * `FileSystem.FileSystem` (e.g. `@effect/platform-bun`'s `BunFileSystem.layer`).
 */
export const layerTempSqlClient: Layer.Layer<
	SqliteClient.SqliteClient,
	PlatformError | SqlError,
	FileSystem.FileSystem
> = Layer.unwrap(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const filename = yield* fs.makeTempFileScoped({
			prefix: 'deskkit-',
			suffix: '.db',
		});
		return layerSqliteClient({ filename });
	}),
);
