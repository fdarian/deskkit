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
		rename: () => Effect.void,
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

				yield* releaseSidecar(dataDir, owner);
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
		'takes over a same-port sidecar.json without consulting the liveness check',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				// Stands in for a prior incarnation of this same process (a
				// pinned-port dev restart, or a SIGKILL'd sidecar whose ephemeral
				// port the OS handed back) — same port, different token.
				yield* writeSidecarJson(dataDir, { port: 4400, token: 'stale-self' });

				const fresh: SidecarHandshake = { port: 4400, token: 'fresh-self' };

				let aliveChecks = 0;
				// Reports alive on purpose: if `acquireAttempt` reached this at
				// all, the same-port takeover branch would have been bypassed —
				// the whole point of the branch is that a same-port owner is
				// never health-checked in the first place.
				const wouldHaveReportedAlive: SidecarLivenessCheck = () => {
					aliveChecks += 1;
					return Effect.succeed(true);
				};

				yield* acquireSidecar(dataDir, fresh, wouldHaveReportedAlive);

				expect(aliveChecks).toBe(0);
				expect(yield* readSidecarJsonFile(dataDir)).toEqual(fresh);
			}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'still refuses with SidecarAlreadyRunning when the existing owner is on a different port and alive',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const owner: SidecarHandshake = { port: 4400, token: 'owner-token' };
				yield* writeSidecarJson(dataDir, owner);

				const result = yield* Effect.result(
					acquireSidecar(
						dataDir,
						{ port: 4401, token: 'challenger' },
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

	// `it.live`, not `it.effect`: a contender can read a claim mid-`wx` write,
	// and `readHandshakeFile`'s retry sleeps on `TestClock` under `it.effect`.
	// The race window is narrow (~1% per round when the stale file is removed by path), so
	// one round proves little — the rounds below are what make a regression
	// show up reliably.
	it.live(
		'two concurrent acquires against the same stale owner — exactly one wins, the other sees the winner as alive',
		() =>
			Effect.gen(function* () {
				const stale: SidecarHandshake = { port: 6100, token: 'dead-token' };
				const first: SidecarHandshake = { port: 6101, token: 'first-token' };
				const second: SidecarHandshake = { port: 6102, token: 'second-token' };
				const isAlive: SidecarLivenessCheck = (recorded) =>
					Effect.succeed(recorded.token !== stale.token);

				for (let round = 0; round < 1000; round++) {
					const dataDir = yield* makeDataDir;
					yield* writeSidecarJson(dataDir, stale);

					const [firstResult, secondResult] = yield* Effect.all(
						[
							Effect.result(acquireSidecar(dataDir, first, isAlive)),
							Effect.result(acquireSidecar(dataDir, second, isAlive)),
						],
						{ concurrency: 'unbounded' },
					);

					const winners = [firstResult, secondResult].filter(Result.isSuccess);
					const losers = [firstResult, secondResult].filter(Result.isFailure);
					expect(winners).toHaveLength(1);
					expect(losers).toHaveLength(1);

					const winner = Result.isSuccess(firstResult) ? first : second;
					const loserFailure = losers[0]?.failure as
						| { readonly _tag: string; readonly port: number }
						| undefined;
					expect(loserFailure?._tag).toBe('SidecarAlreadyRunning');
					expect(loserFailure?.port).toBe(winner.port);
					expect(yield* readSidecarJsonFile(dataDir)).toEqual(winner);
				}
			}).pipe(Effect.scoped, Effect.provide(layerTest)),
	);

	it.effect(
		'a live owner discovered only on the final attempt surfaces as SidecarAlreadyRunning, not LockAcquisitionFailed',
		() => {
			const recordedOwner: SidecarHandshake = {
				port: 7000,
				token: 'owner-token',
			};
			// A different port than `recordedOwner` — same-port callers take the
			// new no-liveness-check takeover branch (see the "same port" tests
			// below), which isn't what this test is exercising.
			const challenger: SidecarHandshake = {
				port: 7001,
				token: 'challenger-token',
			};

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
					acquireSidecar('/fake-data-dir', challenger, isAlive),
				);

				expect(aliveChecks).toBe(6);
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result)) {
					expect(result.failure._tag).toBe('SidecarAlreadyRunning');
				}
			}).pipe(Effect.provide(alwaysContestedFs(recordedOwner)));
		},
	);

	it.effect(
		'gives up after exhausting every attempt against a permanently dead owner, reporting the true attempt count',
		() => {
			const recordedOwner: SidecarHandshake = {
				port: 8000,
				token: 'ghost-token',
			};
			// A different port than `recordedOwner` — see the comment in the
			// preceding test.
			const challenger: SidecarHandshake = {
				port: 8001,
				token: 'challenger-token',
			};

			return Effect.gen(function* () {
				const result = yield* Effect.result(
					acquireSidecar('/fake-data-dir', challenger, alwaysDead),
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
			}).pipe(Effect.provide(alwaysContestedFs(recordedOwner)));
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

	it.effect('release is a no-op when sidecar.json is missing', () =>
		Effect.gen(function* () {
			const dataDir = yield* makeDataDir;
			yield* releaseSidecar(dataDir, { port: 1, token: 'never-owned' });

			const fs = yield* FileSystem.FileSystem;
			expect(yield* fs.exists(`${dataDir}/sidecar.json`)).toBe(false);
		}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'release leaves a live owner alone when the releaser lost the claim',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const live: SidecarHandshake = { port: 5000, token: 'live-token' };
				yield* writeSidecarJson(dataDir, live);

				yield* releaseSidecar(dataDir, { port: 9999, token: 'challenger' });

				expect(yield* readSidecarJsonFile(dataDir)).toEqual(live);
			}).pipe(Effect.provide(layerTest)),
	);

	it.effect(
		'release leaves a same-port file with a different token alone',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const successor: SidecarHandshake = { port: 4000, token: 'successor' };
				yield* writeSidecarJson(dataDir, successor);

				yield* releaseSidecar(dataDir, { port: 4000, token: 'prior-self' });

				expect(yield* readSidecarJsonFile(dataDir)).toEqual(successor);
			}).pipe(Effect.provide(layerTest)),
	);

	// `it.live`: reading an unparseable file retries on a real-time schedule.
	it.live('release leaves an unparseable sidecar.json alone', () =>
		Effect.gen(function* () {
			const dataDir = yield* makeDataDir;
			const fs = yield* FileSystem.FileSystem;
			yield* fs.writeFileString(`${dataDir}/sidecar.json`, 'not json');

			yield* releaseSidecar(dataDir, { port: 1, token: 'any' });

			expect(yield* fs.readFileString(`${dataDir}/sidecar.json`)).toBe(
				'not json',
			);
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
		'keeps waiting while a different-token handshake sits on disk, and resolves once the requested token is published',
		() =>
			Effect.gen(function* () {
				const dataDir = yield* makeDataDir;
				const other: SidecarHandshake = { port: 3001, token: 'other' };
				const requested: SidecarHandshake = {
					port: 3002,
					token: 'requested',
				};
				yield* writeSidecarJson(dataDir, other);

				const waiter = yield* awaitSidecarHandshake(dataDir, {
					token: requested.token,
				}).pipe(Effect.forkScoped);

				// Long enough for several poll intervals against the on-disk
				// `other` handshake — the fork above must not resolve against it,
				// only against a handshake carrying `requested.token`.
				yield* Effect.sleep('500 millis');
				expect(waiter.pollUnsafe()).toBeUndefined();

				yield* writeSidecarJson(dataDir, requested);

				const handshake = yield* Fiber.join(waiter);
				expect(handshake).toEqual(requested);
			}).pipe(Effect.provide(layerTest)),
	);
});
