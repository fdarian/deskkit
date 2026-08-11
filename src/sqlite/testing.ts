import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Creates a throwaway temp directory, hands `fn` a real db file path inside
 * it, and removes the directory once `fn` settles (success or failure). A
 * real file, not `:memory:` — the embedded-migration path this is meant to
 * exercise reads `bun:sqlite`'s own file, not an in-memory connection.
 *
 * Plain async rather than an Effect: `bun:test`'s `beforeEach`/`afterEach`
 * are themselves plain async functions, so this matches the lifecycle its
 * callers already run inside instead of asking every test file to thread an
 * Effect scope through them for a temp-dir dance that's over before the test
 * body's own Effects start.
 */
export const withTempDb = async <T>(
	fn: (dbPath: string) => Promise<T>,
): Promise<T> => {
	const dir = await mkdtemp(join(tmpdir(), 'deskkit-'));
	try {
		return await fn(join(dir, 'test.db'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};
