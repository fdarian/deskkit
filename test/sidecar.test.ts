import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, FileSystem, Result } from 'effect';
import {
	acquireSidecarLock,
	awaitSidecarHandshake,
	publishSidecarJson,
	readSidecarJson,
	releaseSidecarLock,
	type SidecarHandshake,
	type SidecarLivenessCheck,
} from '../src/sidecar/index.ts';

const layerTest = BunFileSystem.layer;

const makeDataDir = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.makeTempDirectoryScoped({ prefix: 'deskkit-sidecar-' });
});

/** Never actually invoked in the tests that pass it — the lock isn't held by anyone yet. */
const unreachableIsAlive: SidecarLivenessCheck = () =>
	Effect.die(new Error('isAlive should not have been called'));

const alwaysAlive: SidecarLivenessCheck = () => Effect.succeed(true);
const alwaysDead: SidecarLivenessCheck = () => Effect.succeed(false);

const writeLockFile = (dataDir: string, owner: SidecarHandshake) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.writeFileString(`${dataDir}/sidecar.lock`, JSON.stringify(owner));
	});

const readLockFile = (dataDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const raw = yield* fs.readFileString(`${dataDir}/sidecar.lock`);
		return JSON.parse(raw) as SidecarHandshake;
	});

describe('acquireSidecarLock / releaseSidecarLock', () => {
	it.effect('acquires the lock when none exists, and release removes it', () =>
		Effect.gen(function* () {
			const dataDir = yield* makeDataDir;
			const owner: SidecarHandshake = { port: 4000, token: 'tok-a' };

			yield* acquireSidecarLock(dataDir, owner, unreachableIsAlive);
			expect(yield* readLockFile(dataDir)).toEqual(owner);

			yield* releaseSidecarLock(dataDir);
			const fs = yield* FileSystem.FileSystem;
			expect(yield* fs.exists(`${dataDir}/sidecar.lock`)).toBe(false);
		}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'refuses when the recorded owner is alive, without touching the lock file',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const owner: SidecarHandshake = { port: 5000, token: 'owner-token' };
				yield* writeLockFile(dataDir, owner);

				const result = yield* Effect.result(
					acquireSidecarLock(
						dataDir,
						{ port: 9999, token: 'challenger' },
						alwaysAlive,
					),
				);

				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result)) {
					expect(result.failure._tag).toBe('SidecarAlreadyRunning');
					expect((result.failure as { readonly port: number }).port).toBe(
						owner.port,
					);
				}

				expect(yield* readLockFile(dataDir)).toEqual(owner);
			}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'recovers from a dead owner by clearing the lock and reacquiring for itself',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				yield* writeLockFile(dataDir, { port: 1, token: 'dead-token' });

				const fresh: SidecarHandshake = { port: 5555, token: 'fresh' };
				yield* acquireSidecarLock(dataDir, fresh, alwaysDead);

				expect(yield* readLockFile(dataDir)).toEqual(fresh);
			}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'two concurrent acquires against an empty data dir — exactly one wins, the other sees the winner as alive',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const first: SidecarHandshake = { port: 6001, token: 'first-token' };
				const second: SidecarHandshake = {
					port: 6002,
					token: 'second-token',
				};

				const [firstResult, secondResult] = yield* Effect.all(
					[
						Effect.result(acquireSidecarLock(dataDir, first, alwaysAlive)),
						Effect.result(acquireSidecarLock(dataDir, second, alwaysAlive)),
					],
					{ concurrency: 'unbounded' },
				);

				const outcomes = [firstResult, secondResult];
				const winners = outcomes.filter(Result.isSuccess);
				const losers = outcomes.filter(Result.isFailure);
				expect(winners).toHaveLength(1);
				expect(losers).toHaveLength(1);

				const winnerPort = Result.isSuccess(firstResult)
					? first.port
					: second.port;
				const loserFailure = losers[0]?.failure as
					| { readonly _tag: string; readonly port: number }
					| undefined;
				expect(loserFailure?._tag).toBe('SidecarAlreadyRunning');
				expect(loserFailure?.port).toBe(winnerPort);
			}).pipe(Effect.provide(layerTest)),
	);
});

describe('publishSidecarJson / readSidecarJson', () => {
	it.effect(
		'publishSidecarJson replaces existing content and leaves no temp file behind',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const fs = yield* FileSystem.FileSystem;
				yield* fs.writeFileString(
					`${dataDir}/sidecar.json`,
					JSON.stringify({ port: 1111, token: 'stale' }),
				);

				const fresh: SidecarHandshake = { port: 2222, token: 'fresh' };
				yield* publishSidecarJson(dataDir, fresh);

				expect(yield* readSidecarJson(dataDir)).toEqual(fresh);

				const entries = yield* fs.readDirectory(dataDir);
				const leftoverTempFiles = entries.filter((name) =>
					name.startsWith('.sidecar.json.tmp-'),
				);
				expect(leftoverTempFiles).toHaveLength(0);
			}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'readSidecarJson returns undefined when nothing was published',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				expect(yield* readSidecarJson(dataDir)).toBeUndefined();
			}).pipe(Effect.provide(layerTest)),
	);
});

describe('awaitSidecarHandshake', () => {
	// `it.live`, not `it.effect`: `awaitSidecarHandshake`'s poll (`Effect.repeat`
	// with a `Schedule.spaced` delay) needs real wall-clock time to pass so the
	// fork below and the main fiber actually interleave — `it.effect` runs
	// against `TestClock`'s virtual time, which nothing here advances, so a
	// schedule-driven delay never elapses and the fiber waits forever.
	it.live(
		'waits past a stale previous handshake until a fresh one is published',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const stale: SidecarHandshake = { port: 3001, token: 'stale' };
				const fresh: SidecarHandshake = { port: 3002, token: 'fresh' };
				yield* publishSidecarJson(dataDir, stale);

				const waiter = yield* awaitSidecarHandshake(dataDir, {
					previous: stale,
				}).pipe(Effect.forkScoped);

				// The fork above must not resolve against the handshake already on
				// disk — only a token change should satisfy it.
				yield* publishSidecarJson(dataDir, fresh);

				const handshake = yield* Fiber.join(waiter);
				expect(handshake).toEqual(fresh);
			}).pipe(Effect.provide(layerTest)),
	);
});
