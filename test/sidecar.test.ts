import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, FileSystem, PlatformError, Result } from 'effect';
import {
	acquireSidecar,
	awaitSidecarHandshake,
	readSidecarJson,
	releaseSidecar,
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

const writeSidecarJson = (dataDir: string, owner: SidecarHandshake) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.writeFileString(`${dataDir}/sidecar.json`, JSON.stringify(owner));
	});

const readSidecarJsonFile = (dataDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const raw = yield* fs.readFileString(`${dataDir}/sidecar.json`);
		return JSON.parse(raw) as SidecarHandshake;
	});

/**
 * A `FileSystem` layer simulating a `sidecar.json` that something keeps
 * re-creating out from under us: `wx` create always reports the file as
 * already existing, and the recorded owner always decodes successfully — so
 * every `acquireSidecar` attempt is forced down the read-and-health-check
 * path instead of any attempt acquiring outright, letting `isAlive` alone
 * drive how many attempts actually happen.
 */
const alwaysContestedFs = (owner: SidecarHandshake) =>
	FileSystem.layerNoop({
		writeFileString: () =>
			Effect.fail(
				PlatformError.systemError({
					_tag: 'AlreadyExists',
					module: 'FileSystem',
					method: 'writeFileString',
				}),
			),
		readFileString: () => Effect.succeed(JSON.stringify(owner)),
		remove: () => Effect.void,
	});

describe('acquireSidecar / releaseSidecar', () => {
	it.effect(
		'acquires and publishes when none exists, and release removes it',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const owner: SidecarHandshake = { port: 4000, token: 'tok-a' };

				yield* acquireSidecar(dataDir, owner, unreachableIsAlive);
				expect(yield* readSidecarJsonFile(dataDir)).toEqual(owner);

				yield* releaseSidecar(dataDir);
				const fs = yield* FileSystem.FileSystem;
				expect(yield* fs.exists(`${dataDir}/sidecar.json`)).toBe(false);
			}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'refuses when the recorded owner is alive, without touching sidecar.json',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const owner: SidecarHandshake = { port: 5000, token: 'owner-token' };
				yield* writeSidecarJson(dataDir, owner);

				const result = yield* Effect.result(
					acquireSidecar(
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

				expect(yield* readSidecarJsonFile(dataDir)).toEqual(owner);
			}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'recovers from a dead owner by clearing sidecar.json and reacquiring for itself',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				yield* writeSidecarJson(dataDir, { port: 1, token: 'dead-token' });

				const fresh: SidecarHandshake = { port: 5555, token: 'fresh' };
				yield* acquireSidecar(dataDir, fresh, alwaysDead);

				expect(yield* readSidecarJsonFile(dataDir)).toEqual(fresh);
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
						Effect.result(acquireSidecar(dataDir, first, alwaysAlive)),
						Effect.result(acquireSidecar(dataDir, second, alwaysAlive)),
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

	it.effect(
		'a live owner discovered only on the final attempt surfaces as SidecarAlreadyRunning, not LockAcquisitionFailed',
		() => {
			const owner: SidecarHandshake = { port: 7000, token: 'owner-token' };

			// Exercises the one behavior change from the recursion `acquire`
			// replaced: `isAlive` reports dead for every attempt except the
			// last, so a live owner is found only on the final of the 6 total
			// attempts (`MAX_ACQUIRE_ATTEMPTS` retries plus the initial one) —
			// that must still surface as `SidecarAlreadyRunning`, not the
			// misleading `LockAcquisitionFailed` a blind last-attempt bail used to
			// produce.
			let aliveChecks = 0;
			const isAlive: SidecarLivenessCheck = () => {
				aliveChecks += 1;
				return Effect.succeed(aliveChecks === 6);
			};

			return Effect.gen(function* () {
				const result = yield* Effect.result(
					acquireSidecar('/fake-data-dir', owner, isAlive),
				);

				expect(aliveChecks).toBe(6);
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result)) {
					expect(result.failure._tag).toBe('SidecarAlreadyRunning');
				}
			}).pipe(Effect.provide(alwaysContestedFs(owner)));
		},
	);

	it.effect(
		'gives up after exhausting every attempt against a permanently dead owner, reporting the true attempt count',
		() => {
			const owner: SidecarHandshake = { port: 8000, token: 'ghost-token' };

			return Effect.gen(function* () {
				const result = yield* Effect.result(
					acquireSidecar('/fake-data-dir', owner, alwaysDead),
				);

				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result)) {
					expect(result.failure._tag).toBe('LockAcquisitionFailed');
					// 6 = MAX_ACQUIRE_ATTEMPTS (5 retries) + the initial attempt —
					// see LockAcquisitionFailed's doc in handshake.ts.
					expect(
						(result.failure as { readonly attempts: number }).attempts,
					).toBe(6);
				}
			}).pipe(Effect.provide(alwaysContestedFs(owner)));
		},
	);

	it.effect(
		'acquire publishes handshake content readable via readSidecarJson',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const owner: SidecarHandshake = { port: 2222, token: 'fresh' };

				yield* acquireSidecar(dataDir, owner, unreachableIsAlive);

				expect(yield* readSidecarJson(dataDir)).toEqual(owner);
			}).pipe(Effect.provide(layerTest)),
	);
});

describe('readSidecarJson', () => {
	it.effect('returns undefined when nothing was acquired', () =>
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
				yield* writeSidecarJson(dataDir, stale);

				const waiter = yield* awaitSidecarHandshake(dataDir, {
					previous: stale,
				}).pipe(Effect.forkScoped);

				// The fork above must not resolve against the handshake already on
				// disk — only a token change should satisfy it.
				yield* writeSidecarJson(dataDir, fresh);

				const handshake = yield* Fiber.join(waiter);
				expect(handshake).toEqual(fresh);
			}).pipe(Effect.provide(layerTest)),
	);
});
