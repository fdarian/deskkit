import { join } from 'node:path';
import { Effect, FileSystem, Schedule, Schema } from 'effect';

/**
 * What a sidecar publishes to `sidecar.json`, and what `sidecar.lock`
 * records about its current owner — the same fact, read by different
 * consumers at different points in the boot sequence (see `lock.ts`'s
 * `acquireSidecarLock`, whose recorded owner is health-checked against this
 * same shape).
 */
export const SidecarHandshake = Schema.Struct({
	port: Schema.Number,
	token: Schema.String,
});
export type SidecarHandshake = typeof SidecarHandshake.Type;

const SidecarHandshakeFromJsonString = Schema.fromJsonString(SidecarHandshake);

const sidecarJsonPathFor = (dataDir: string) => join(dataDir, 'sidecar.json');

/**
 * A lock/handshake file that exists but doesn't parse yet is almost always
 * its own writer still landing — `sidecar.lock` is created via `wx` and
 * written in the same call (see `lock.ts`'s `acquireOnce`), so a concurrent
 * reader can briefly observe 0 (or partial) bytes. This many retries, this
 * far apart, is comfortably more than a same-machine small write takes to
 * land. A missing file is a different case entirely — not retried here, see
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
 * polling for that; `lock.ts` treats a vanished lock as "clear and retry
 * acquire"). A file that exists but doesn't parse *is* retried briefly, as a
 * guard against reading mid-write — see `READ_RETRY_ATTEMPTS`'s doc above;
 * a decode failure that survives every retry also collapses to `undefined`.
 * `undefined` covers both outcomes, deliberately collapsed into one: every
 * caller that reaches for this (`readSidecarJson` below, and `lock.ts`'s
 * liveness recovery reading `sidecar.lock`) treats "not ready" and "not
 * there" the same way.
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
 * Encodes to the same JSON shape written to both `sidecar.lock` and
 * `sidecar.json` — the codec counterpart to `readHandshakeFile`'s decode.
 * Dies on failure: encoding a well-typed `{ port, token }` to JSON cannot
 * fail, so a failure here would mean a real invariant broke, not something a
 * caller could sensibly recover from.
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
	 * The handshake already on disk before this poll started, if any. A
	 * sidecar removes `sidecar.lock` on shutdown but leaves `sidecar.json`
	 * behind, so the previous run's `{ port, token }` can still be sitting
	 * there when a fresh sidecar starts booting — and that port is stale,
	 * since every boot binds a fresh ephemeral one. Comparing by `token`
	 * (a fresh `crypto.randomUUID()` per boot, so it can't collide the way a
	 * recycled ephemeral port can) is what makes this actually *wait* for the
	 * new sidecar's handshake instead of returning the stale one on the very
	 * first read. Pass `undefined` when there's nothing to compare against
	 * (e.g. the data dir was empty before this boot).
	 */
	readonly previous: SidecarHandshake | undefined;
};

/**
 * Polls `<dataDir>/sidecar.json` until a fresh handshake — one that isn't
 * `options.previous` — is readable. No bounded timeout: this is meant to be
 * raced against the sidecar subprocess itself (e.g. `Effect.raceAll`), so a
 * sidecar that dies before publishing (or refuses to boot because another
 * one holds the lock) interrupts this poll along with it, rather than this
 * function needing its own giving-up logic.
 */
export const awaitSidecarHandshake = (
	dataDir: string,
	options: AwaitSidecarHandshakeOptions,
): Effect.Effect<SidecarHandshake, never, FileSystem.FileSystem> =>
	readSidecarJson(dataDir).pipe(
		Effect.repeat({
			schedule: Schedule.spaced(`${HANDSHAKE_POLL_INTERVAL_MS} millis`),
			until: (handshake): handshake is SidecarHandshake =>
				handshake !== undefined && handshake.token !== options.previous?.token,
		}),
	);

/**
 * Publishes `sidecar.json` via a temp file in the same directory +
 * `rename()` — rename is atomic on one filesystem, so a reader (another
 * process polling via `awaitSidecarHandshake`/`readSidecarJson`, or the host
 * app's own poll for the handshake) can only ever observe the old content or
 * the new content, never a partial write in between.
 *
 * Safe to call unconditionally: a successful `acquireSidecarLock` (see
 * `lock.ts`) already proves this process is the data dir's sole legitimate
 * sidecar, so there's nothing to check before overwriting whatever
 * `sidecar.json` currently holds.
 */
export const publishSidecarJson = (
	dataDir: string,
	content: SidecarHandshake,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const encoded = yield* encodeSidecarHandshake(content);
		const tmpPath = join(dataDir, `.sidecar.json.tmp-${crypto.randomUUID()}`);
		yield* fs.writeFileString(tmpPath, encoded, { mode: 0o600 });
		yield* fs.rename(tmpPath, sidecarJsonPathFor(dataDir));
	}).pipe(Effect.orDie);
