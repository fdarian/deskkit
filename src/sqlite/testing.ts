import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, type Scope } from 'effect';

/**
 * Creates a throwaway temp directory on acquire, yields a real db file path
 * inside it, and removes the directory on scope release. A real file, not
 * `:memory:` — the embedded-migration path this is meant to exercise reads
 * `bun:sqlite`'s own file, not an in-memory connection.
 *
 * Built with `node:fs/promises` rather than Effect's `FileSystem` service,
 * unlike `gen-migrations.ts`: this is a helper test files import directly,
 * and requiring them to provide a platform layer just to get a temp path
 * would be friction with no payoff here.
 */
export const tempDbPath: Effect.Effect<string, never, Scope.Scope> =
	Effect.acquireRelease(
		Effect.promise(() => mkdtemp(join(tmpdir(), 'deskkit-'))),
		(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
	).pipe(Effect.map((dir) => join(dir, 'test.db')));
