import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
	Effect,
	FileSystem,
	type PlatformError,
	Schedule,
	Schema,
} from 'effect';

/**
 * What a sidecar publishes to `sidecar.json` — the `{ port, token }` a
 * losing `acquireSidecar` caller also reads back to health-check the
 * recorded owner (see `acquireAttempt` below).
 */
export const SidecarHandshake = Schema.Struct({
	port: Schema.Number,
	token: Schema.String,
});
export type SidecarHandshake = typeof SidecarHandshake.Type;

const SidecarHandshakeFromJsonString = Schema.fromJsonString(SidecarHandshake);

const sidecarJsonPathFor = (dataDir: string) => join(dataDir, 'sidecar.json');

/**
 * A handshake file that exists but doesn't parse yet is almost always its
 * own writer still landing — `sidecar.json` is created via `wx` and written
 * in the same call (see `acquireOnce` below), so a concurrent reader can
 * briefly observe 0 (or partial) bytes. This many retries, this far apart,
 * is comfortably more than a same-machine small write takes to land. A
 * missing file is a different case entirely — not retried here, see
 * `readHandshakeFile`'s doc below.
 */
const READ_RETRY_ATTEMPTS = 5;
const READ_RETRY_DELAY_MS = 20;

/**
 * One read+decode attempt. Succeeds with `undefined` for a missing file —
 * that outcome is final, not something `readHandshakeFile`'s retry below
 * should touch — and fails with the decode error for a file that exists but
 * doesn't parse, which *is* what the retry targets.
 */
const readHandshakeFileOnce = (
	path: string,
): Effect.Effect<
	SidecarHandshake | undefined,
	Schema.SchemaError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const raw = yield* fs
			.readFileString(path)
			.pipe(Effect.orElseSucceed(() => undefined));
		if (raw === undefined) return undefined;

		return yield* Schema.decodeUnknownEffect(SidecarHandshakeFromJsonString)(
			raw,
		);
	});

/**
 * Reads and decodes a handshake-shaped JSON file at `path`. A missing file
 * resolves to `undefined` on the first attempt — no retry, since "not there
 * yet" isn't this function's concern (`awaitSidecarHandshake` below owns
 * polling for that; `acquireAttempt` below treats a vanished file as "clear
 * and retry acquire"). A file that exists but doesn't parse *is* retried
 * briefly, as a guard against reading mid-write — see `READ_RETRY_ATTEMPTS`'s
 * doc above; a decode failure that survives every retry also collapses to
 * `undefined`. `undefined` covers both outcomes, deliberately collapsed into
 * one: every caller that reaches for this (`readSidecarJson` below, and
 * `acquireAttempt`'s liveness recovery) treats "not ready" and "not there"
 * the same way.
 */
export const readHandshakeFile = (
	path: string,
): Effect.Effect<SidecarHandshake | undefined, never, FileSystem.FileSystem> =>
	readHandshakeFileOnce(path).pipe(
		Effect.retry({
			schedule: Schedule.spaced(`${READ_RETRY_DELAY_MS} millis`),
			times: READ_RETRY_ATTEMPTS,
		}),
		Effect.orElseSucceed(() => undefined),
	);

/** Reads and decodes `<dataDir>/sidecar.json` — see `readHandshakeFile`. */
export const readSidecarJson = (
	dataDir: string,
): Effect.Effect<SidecarHandshake | undefined, never, FileSystem.FileSystem> =>
	readHandshakeFile(sidecarJsonPathFor(dataDir));

/**
 * Encodes to the JSON shape written to `sidecar.json` — the codec
 * counterpart to `readHandshakeFile`'s decode. Dies on failure: encoding a
 * well-typed `{ port, token }` to JSON cannot fail, so a failure here would
 * mean a real invariant broke, not something a caller could sensibly recover
 * from.
 */
export const encodeSidecarHandshake = (
	handshake: SidecarHandshake,
): Effect.Effect<string> =>
	Schema.encodeEffect(SidecarHandshakeFromJsonString)(handshake).pipe(
		Effect.orDie,
	);

const HANDSHAKE_POLL_INTERVAL_MS = 300;

export type AwaitSidecarHandshakeOptions = {
	/**
	 * The token this call is waiting to see published. The caller mints this
	 * token itself — the same value it hands the sidecar to publish as its
	 * `owner.token` (see `acquireSidecar`) — so it already knows exactly what
	 * to wait for, rather than having to snapshot whatever `sidecar.json`
	 * held before spawning and wait for it to change. That also makes the
	 * wait immune to a third party's handshake landing first: only a
	 * handshake carrying this exact token satisfies it, regardless of
	 * whatever else churns through `sidecar.json` in the meantime.
	 */
	readonly token: string;
};

/**
 * Polls `<dataDir>/sidecar.json` until a handshake carrying `options.token`
 * is readable. No bounded timeout: this is meant to be raced against the
 * sidecar subprocess itself (e.g. `Effect.raceAll`), so a sidecar that dies
 * before publishing (or refuses to boot because another one holds the lock)
 * interrupts this poll along with it, rather than this function needing its
 * own giving-up logic.
 */
export const awaitSidecarHandshake = (
	dataDir: string,
	options: AwaitSidecarHandshakeOptions,
): Effect.Effect<SidecarHandshake, never, FileSystem.FileSystem> =>
	readSidecarJson(dataDir).pipe(
		Effect.repeat({
			schedule: Schedule.spaced(`${HANDSHAKE_POLL_INTERVAL_MS} millis`),
			until: (handshake): handshake is SidecarHandshake =>
				handshake !== undefined && handshake.token === options.token,
		}),
	);

/**
 * The total number of `acquireAttempt` executions allowed — the initial one
 * plus every retry — before a lock that keeps coming back dead fails loudly
 * instead of recovering forever. `acquire` below derives `Effect.repeat`'s
 * `times` from this (`MAX_ACQUIRE_ATTEMPTS - 1`, since `times` counts only
 * the retries *after* the initial attempt), so this is also exactly the
 * number reported as `LockAcquisitionFailed`'s `attempts`.
 */
const MAX_ACQUIRE_ATTEMPTS = 6;

/** Refused to boot because another sidecar is already live for this data dir. */
export class SidecarAlreadyRunning extends Schema.TaggedError<SidecarAlreadyRunning>()(
	'SidecarAlreadyRunning',
	{ port: Schema.Number },
) {}

/**
 * Gave up acquiring the lock: either after repeatedly finding (and clearing)
 * a dead owner, or because clearing one displaced a newer claim that a third
 * claimant then took the path from (see `clearJudgedOwner`). `attempts` is
 * always `MAX_ACQUIRE_ATTEMPTS` — the true count of executions that ran in the
 * first case, just the configured budget in the second.
 */
export class LockAcquisitionFailed extends Schema.TaggedError<LockAcquisitionFailed>()(
	'LockAcquisitionFailed',
	{ attempts: Schema.Number },
) {}

const isAlreadyExists = (error: PlatformError.PlatformError): boolean =>
	error.reason._tag === 'AlreadyExists';

const isNotFound = (error: PlatformError.PlatformError): boolean =>
	error.reason._tag === 'NotFound';

/**
 * Confirms whether `owner` — the handshake recorded in an existing
 * `sidecar.json` — is still a live sidecar. Callers are expected to
 * health-check `owner` over whatever RPC channel their app's sidecar answers
 * on (this module has no opinion on that transport, so it takes no
 * dependency on any RPC client), under a short timeout — the reference
 * implementation this was extracted from used ~1s: long enough that a live
 * sidecar under momentary load isn't misread as dead, short enough that a
 * genuinely dead one doesn't stall the boot waiting for an answer that's
 * never coming.
 *
 * The declared error channel is `never` on purpose: this is the *only* way
 * to tell "the process that made this handshake crashed" apart from "it's
 * genuinely still running" (never a staleness heuristic — not the file's
 * age, not a PID that might have been reused), so any non-success — a
 * timeout, a connection failure, a non-2xx response — must resolve to
 * `false` here rather than leaking a typed failure that would force
 * `acquireSidecar`'s own callers to widen their error handling for a
 * transport failure that isn't really theirs to handle.
 */
export type SidecarLivenessCheck<R = never> = (
	owner: SidecarHandshake,
) => Effect.Effect<boolean, never, R>;

/**
 * One `O_EXCL` create attempt, carrying the full `{ port, token }` in the
 * same call — claiming exclusivity and publishing the handshake are one act,
 * not two. `true` means this call created (and now owns) the file; `false`
 * means someone else already holds it.
 */
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

/**
 * `'acquired'`: this call created (and now owns) `sidecar.json`. `'cleared'`:
 * the existing file's owner was confirmed dead (or unreadable) and moved out
 * of the way — or someone else got there first — so the caller should attempt
 * again. A live owner is not represented here, it fails the effect outright
 * (see below) since that's terminal, not something to loop on.
 */
type AcquireOutcome = 'acquired' | 'cleared';

/**
 * Clears the `sidecar.json` at `path` that `acquireAttempt` judged to belong
 * to `judged` (`undefined` when it was unreadable) — without ever deleting a
 * file by path. Removing by path would be a check-then-act race: two
 * contenders judge the same stale owner dead, the first clears it and `wx`-
 * creates its own claim, and the second's remove then deletes that fresh claim
 * instead of the stale one, leaving both believing they own the dir.
 *
 * So the file is renamed to a private name first — atomic, so exactly one
 * contender ever gets a given inode — and its token is compared against the
 * one that was judged. A match means the stale file is ours to drop. A mismatch
 * means the path was re-claimed between the judgment and the rename and we
 * just grabbed a newer, possibly live claim: it's hard-linked back (atomic,
 * and unlike a rename it refuses to overwrite) for the next attempt to
 * evaluate normally. If the path is already taken again by then, a third
 * claimant slipped in and the displaced claim can't be put back, so this fails
 * rather than let the caller proceed on a lock it can no longer reason about.
 */
const clearJudgedOwner = (
	path: string,
	judged: SidecarHandshake | undefined,
): Effect.Effect<void, LockAcquisitionFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const privatePath = `${path}.stale-${randomUUID()}`;

		const renamed = yield* fs.rename(path, privatePath).pipe(
			Effect.as(true),
			Effect.catchTag('PlatformError', (error) =>
				isNotFound(error) ? Effect.succeed(false) : Effect.die(error),
			),
		);
		// Another contender already cleared it.
		if (!renamed) return;

		// Still retry-tolerant: the renamed file may be a claim whose `wx`
		// write hasn't landed yet — the bytes arrive on the inode regardless
		// of its name.
		const grabbed = yield* readHandshakeFile(privatePath);
		if (grabbed?.token === judged?.token) {
			yield* fs.remove(privatePath, { force: true }).pipe(Effect.orDie);
			return;
		}

		const restored = yield* fs.link(privatePath, path).pipe(
			Effect.as(true),
			Effect.catchTag('PlatformError', (error) =>
				isAlreadyExists(error) ? Effect.succeed(false) : Effect.die(error),
			),
		);
		yield* fs.remove(privatePath, { force: true }).pipe(Effect.orDie);
		if (!restored) {
			yield* Effect.logFatal(
				`another sidecar claimed ${path} while a newer claim was being put back — giving up rather than guess which one owns the data dir`,
			);
			return yield* new LockAcquisitionFailed({
				attempts: MAX_ACQUIRE_ATTEMPTS,
			});
		}
	});

/**
 * One attempt: create `sidecar.json` via `acquireOnce`, and if someone else
 * already holds it, read the recorded owner. When the recorded owner is on
 * the *same port* this call is claiming, it's taken over without a liveness
 * check — see the comment at that branch below. Otherwise the owner is
 * health-checked: a live owner fails with `SidecarAlreadyRunning` — a
 * failure short-circuits `Effect.repeat` below, which is exactly the
 * behavior wanted, no separate "stop looping" signal needed. A same-port,
 * dead, or unreadable owner's file is cleared via `clearJudgedOwner` and the
 * attempt succeeds with `'cleared'`, leaving the next `Effect.repeat`
 * iteration to retry `acquireOnce` against the now-empty path.
 */
const acquireAttempt = <R>(
	path: string,
	owner: SidecarHandshake,
	isAlive: SidecarLivenessCheck<R>,
): Effect.Effect<
	AcquireOutcome,
	SidecarAlreadyRunning | LockAcquisitionFailed,
	FileSystem.FileSystem | R
> =>
	Effect.gen(function* () {
		const created = yield* acquireOnce(path, owner);
		if (created) return 'acquired' as const;

		const existingOwner = yield* readHandshakeFile(path);
		if (existingOwner !== undefined && existingOwner.port === owner.port) {
			// A TCP port has exactly one owner, and the acquiring process is
			// demonstrably it — it bound `owner.port` before ever calling
			// `acquireSidecar`. So a handshake file recording that same port
			// cannot belong to a live *other* process: it's either this
			// process's own previous incarnation (a pinned-port dev restart,
			// see the sidecar README's file-watcher section) or a `SIGKILL`'d
			// sidecar whose ephemeral port the OS happened to hand back. Both
			// are ours to take over, and health-checking one is just this
			// process interrogating itself — skip `isAlive` entirely and fall
			// into the same clear-and-retry path a confirmed-dead owner takes.
			// Safe for the `port: 0` case too: an ephemeral rebind onto a port
			// some *other* live process already holds is exceedingly rare, so
			// this branch simply doesn't fire then.
			yield* Effect.logDebug(
				`existing sidecar.json (port ${existingOwner.port}) matches the port this process is already listening on — taking it over without a liveness check`,
			);
		} else if (existingOwner !== undefined) {
			const alive = yield* isAlive(existingOwner);
			if (alive) {
				yield* Effect.logFatal(
					`refusing to start: another sidecar is already live on port ${existingOwner.port} for this data dir — two sidecars sharing one data directory would race over sidecar.json and the SQLite database`,
				);
				return yield* new SidecarAlreadyRunning({ port: existingOwner.port });
			}
			yield* Effect.logDebug(
				`existing sidecar.json (port ${existingOwner.port}) didn't answer — clearing it as a dead owner`,
			);
		} else {
			yield* Effect.logDebug(
				"existing sidecar.json didn't parse even after retrying — clearing it as an unreadable/dead owner",
			);
		}

		yield* clearJudgedOwner(path, existingOwner);
		return 'cleared' as const;
	});

/**
 * Repeats `acquireAttempt` immediately (no delay between attempts, matching
 * the original recursion) until it either succeeds with `'acquired'` or
 * `MAX_ACQUIRE_ATTEMPTS` total attempts have run — whichever comes first.
 * `Effect.repeat`'s `times` counts only the retries *after* the initial
 * attempt, hence `MAX_ACQUIRE_ATTEMPTS - 1` below. A `SidecarAlreadyRunning`
 * failure from any attempt, including the last, short-circuits the repeat
 * and propagates straight out.
 *
 * One behavior change from the recursion this replaced: the old code's
 * `attemptsLeft <= 0` check fired *before* reading and health-checking the
 * owner, so the final attempt gave up blind. `Effect.repeat` always runs an
 * iteration's full body, so the last attempt now reads and health-checks
 * too — a live owner discovered only on the last attempt now correctly
 * surfaces as `SidecarAlreadyRunning` instead of the misleading
 * `LockAcquisitionFailed`, at the cost of a dead owner's file still getting
 * cleared on the way out even though the budget is about to run out
 * regardless. Both are fine; the former is the reason this is worth doing.
 */
const acquire = <R>(
	path: string,
	owner: SidecarHandshake,
	isAlive: SidecarLivenessCheck<R>,
): Effect.Effect<
	void,
	SidecarAlreadyRunning | LockAcquisitionFailed,
	FileSystem.FileSystem | R
> =>
	acquireAttempt(path, owner, isAlive).pipe(
		Effect.repeat({
			times: MAX_ACQUIRE_ATTEMPTS - 1,
			until: (outcome) => outcome === 'acquired',
		}),
		Effect.flatMap((outcome) => {
			if (outcome === 'acquired') return Effect.void;
			return Effect.logFatal(
				`giving up on the sidecar lock at ${path} after repeatedly finding a dead owner — a filesystem or process problem is likely masking the real error`,
			).pipe(
				Effect.andThen(
					new LockAcquisitionFailed({ attempts: MAX_ACQUIRE_ATTEMPTS }),
				),
			);
		}),
	);

/**
 * Atomically claims ownership of `dataDir`'s sidecar and publishes its
 * handshake in the same act, via `wx` (POSIX `O_EXCL`) on `sidecar.json` —
 * the create either succeeds or fails, with no window in between for a
 * second process racing the same open() to also succeed. Without it, two
 * sidecars booting at the same instant could both find no live
 * `sidecar.json`, both proceed, and both write, silently splitting whatever
 * consumers exist onto different sidecars — and different SQLite writers.
 *
 * A losing process reads the recorded owner and health-checks it via the
 * caller-supplied `isAlive` — never a staleness heuristic — and, once
 * confirmed dead, clears it and retries. The clear is a rename-then-verify
 * (see `clearJudgedOwner`), not a remove-by-path, so a contender that judged
 * the same stale owner dead can't delete the claim another contender just
 * made. Bounded by `MAX_ACQUIRE_ATTEMPTS` so a file that keeps coming back
 * dead fails loudly instead of spinning forever.
 *
 * A `SIGKILL`'d owner never runs its release effect (see `releaseSidecar`
 * below) — the Tauri/Rust side hard-kills the sidecar child on app exit
 * rather than giving it a chance to clean up, so `sidecar.json` surviving on
 * disk is the expected case in production, not a bug. The next boot finds
 * that file, health-checks the dead port via `isAlive`, gets no answer, and
 * recovers the same way it would for any other dead owner.
 *
 * The brief window between `open()` and the write landing — during which a
 * concurrent reader can observe an empty or partial file — is covered by
 * `readHandshakeFile`'s retry, not by anything here.
 */
export const acquireSidecar = <R = never>(
	dataDir: string,
	owner: SidecarHandshake,
	isAlive: SidecarLivenessCheck<R>,
): Effect.Effect<
	void,
	SidecarAlreadyRunning | LockAcquisitionFailed,
	FileSystem.FileSystem | R
> => acquire(sidecarJsonPathFor(dataDir), owner, isAlive);

/** Releases the claim acquired by `acquireSidecar` — wire this into `Effect.acquireRelease`'s release alongside the resource it guards. */
export const releaseSidecar = (
	dataDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.remove(sidecarJsonPathFor(dataDir), { force: true });
	}).pipe(Effect.orDie);
