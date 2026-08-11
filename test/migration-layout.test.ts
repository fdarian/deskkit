import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Path } from 'effect';
import {
	LegacyMigrationsLayoutError,
	readMigrationLayout,
} from '../src/sqlite/migration-layout.ts';

const layerTest = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const withTempDir = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = yield* fs.makeTempDirectoryScoped();
		return yield* f(dir);
	}).pipe(Effect.scoped);

describe('readMigrationLayout', () => {
	it.effect(
		'orders migrations by directory name, oldest first, regardless of write order',
		() =>
			withTempDir((dir) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;

					// Written newest-first, to prove the reader sorts rather than
					// echoing readdir's (unspecified) order.
					yield* fs.makeDirectory(path.join(dir, '20260101000000_second'), {
						recursive: true,
					});
					yield* fs.writeFileString(
						path.join(dir, '20260101000000_second', 'migration.sql'),
						'second;',
					);
					yield* fs.makeDirectory(path.join(dir, '20250101000000_first'), {
						recursive: true,
					});
					yield* fs.writeFileString(
						path.join(dir, '20250101000000_first', 'migration.sql'),
						'first;',
					);

					const entries = yield* readMigrationLayout(dir);

					expect(entries.map((entry) => entry.name)).toEqual([
						'20250101000000_first',
						'20260101000000_second',
					]);
					expect(entries.map((entry) => entry.sql)).toEqual([
						'first;',
						'second;',
					]);
				}),
			).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'fails with LegacyMigrationsLayoutError when meta/_journal.json is present',
		() =>
			withTempDir((dir) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;

					yield* fs.makeDirectory(path.join(dir, 'meta'), {
						recursive: true,
					});
					yield* fs.writeFileString(
						path.join(dir, 'meta', '_journal.json'),
						'{"entries":[]}',
					);

					const error = yield* Effect.flip(readMigrationLayout(dir));

					if (!(error instanceof LegacyMigrationsLayoutError)) {
						throw error;
					}
					expect(error.migrationsDir).toBe(dir);
				}),
			).pipe(Effect.provide(layerTest)),
	);
});
