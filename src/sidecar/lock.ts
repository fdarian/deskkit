import { join } from 'node:path';
import { Effect, FileSystem, type PlatformError, Schema } from 'effect';
import {
	encodeSidecarHandshake,
	readHandshakeFile,
	type SidecarHandshake,
} from './handshake.ts';

/**
 * Bounds the acquire/recover loop so a lock that keeps coming back dead
 * fails loudly instead of spinning forever.
 */
const MAX_ACQUIRE_ATTEMPTS = 5;

/** Refused to boot because another sidecar is already live for this data dir. */
export class SidecarAlreadyRunning extends Schema.TaggedErrorClass<SidecarAlreadyRunning>()(
	'SidecarAlreadyRunning',
	{ port: Schema.Number },
) {}

/** Gave up acquiring the lock after repeatedly finding (and clearing) a dead owner. */
export class LockAcquisitionFailed extends Schema.TaggedErrorClass<LockAcquisitionFailed>()(
	'LockAcquisitionFailed',
	{ attempts: Schema.Number },
) {}

const lockPathFor = (dataDir: string) => join(dataDir, 'sidecar.lock');

const isAlreadyExists = (error: PlatformError.PlatformError): boolean =>
	error.reason._tag === 'AlreadyExists';

/**
 * Confirms whether `owner` — the handshake recorded in an existing lock —
 * is still a live sidecar. Callers are expected to health-check `owner` over
 * whatever RPC channel their app's sidecar answers on (this module has no
 * opinion on that transport, so it takes no dependency on any RPC client),
 * under a short timeout — the reference implementation this was extracted
 * from used ~1s: long enough that a live sidecar under momentary load isn't
 * misread as dead, short enough that a genuinely dead one doesn't stall the
 * boot waiting for an answer that's never coming.
 *
 * The declared error channel is `never` on purpose: this is the *only* way
 * to tell "the process that made this lock crashed" apart from "it's
 * genuinely still running" (never a staleness heuristic — not the lock
 * file's age, not a PID that might have been reused), so any non-success —
 * a timeout, a connection failure, a non-2xx response — must resolve to
 * `false` here rather than leaking a typed failure that would force
 * `acquireSidecarLock`'s own callers to widen their error handling for a
 * transport failure that isn't really theirs to handle.
 */
export type SidecarLivenessCheck<R = never> = (
	owner: SidecarHandshake,
) => Effect.Effect<boolean, never, R>;

/** One `O_EXCL` create attempt. `true` means this call created (and now owns) the file; `false` means someone else already holds it. */
const acquireOnce = (
	path: string,
	owner: SidecarHandshake,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const encoded = yield* encodeSidecarHandshake(owner);
		return yield* fs
			.writeFileString(path, encoded, { flag: 'wx', mode: 0o600 })
			.pipe(
				Effect.as(true),
				Effect.catchTag('PlatformError', (error) =>
					isAlreadyExists(error) ? Effect.succeed(false) : Effect.die(error),
				),
			);
	});

const acquire = <R>(
	path: string,
	owner: SidecarHandshake,
	attemptsLeft: number,
	isAlive: SidecarLivenessCheck<R>,
): Effect.Effect<
	void,
	SidecarAlreadyRunning | LockAcquisitionFailed,
	FileSystem.FileSystem | R
> =>
	Effect.gen(function* () {
		const created = yield* acquireOnce(path, owner);
		if (created) return;

		if (attemptsLeft <= 0) {
			yield* Effect.logFatal(
				`giving up on the sidecar lock at ${path} after repeatedly finding a dead owner — a filesystem or process problem is likely masking the real error`,
			);
			return yield* new LockAcquisitionFailed({
				attempts: MAX_ACQUIRE_ATTEMPTS,
			});
		}

		const existingOwner = yield* readHandshakeFile(path);
		if (existingOwner !== undefined) {
			const alive = yield* isAlive(existingOwner);
			if (alive) {
				yield* Effect.logFatal(
					`refusing to start: another sidecar is already live on port ${existingOwner.port} for this data dir — two sidecars sharing one data directory would race over sidecar.json and the SQLite database`,
				);
				return yield* new SidecarAlreadyRunning({ port: existingOwner.port });
			}
			yield* Effect.logDebug(
				`existing sidecar lock (port ${existingOwner.port}) didn't answer — clearing it as a dead owner`,
			);
		} else {
			yield* Effect.logDebug(
				"existing sidecar lock didn't parse even after retrying — clearing it as an unreadable/dead owner",
			);
		}

		const fs = yield* FileSystem.FileSystem;
		yield* fs.remove(path, { force: true }).pipe(Effect.orDie);
		return yield* acquire(path, owner, attemptsLeft - 1, isAlive);
	});

/**
 * Atomically claims ownership of `dataDir`'s sidecar lock via `wx` (POSIX
 * `O_EXCL`) — the create either succeeds or fails, with no window in between
 * for a second process racing the same open() to also succeed. Without it,
 * two sidecars booting at the same instant could both find no live
 * `sidecar.json`, both proceed, and both write, silently splitting whatever
 * consumers exist onto different sidecars — and different SQLite writers.
 *
 * A losing process reads the lock's recorded owner and health-checks it via
 * the caller-supplied `isAlive` — never a staleness heuristic — and, once
 * confirmed dead, clears it and retries. Bounded by `MAX_ACQUIRE_ATTEMPTS` so
 * a lock that keeps coming back dead fails loudly instead of spinning
 * forever.
 *
 * A `SIGKILL`'d owner never runs its release effect (see
 * `releaseSidecarLock` below) — the Tauri/Rust side hard-kills the sidecar
 * child on app exit rather than giving it a chance to clean up, so its lock
 * file surviving on disk is the expected case in production, not a bug. The
 * next boot finds that lock, health-checks the dead port via `isAlive`, gets
 * no answer, and recovers the same way it would for any other dead owner.
 */
export const acquireSidecarLock = <R = never>(
	dataDir: string,
	owner: SidecarHandshake,
	isAlive: SidecarLivenessCheck<R>,
): Effect.Effect<
	void,
	SidecarAlreadyRunning | LockAcquisitionFailed,
	FileSystem.FileSystem | R
> => acquire(lockPathFor(dataDir), owner, MAX_ACQUIRE_ATTEMPTS, isAlive);

/** Releases the lock acquired by `acquireSidecarLock` — wire this into `Effect.acquireRelease`'s release alongside the resource it guards. */
export const releaseSidecarLock = (
	dataDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.remove(lockPathFor(dataDir), { force: true });
	}).pipe(Effect.orDie);
