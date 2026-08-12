# sidecar

Boot-time coordination for a Tauri-style desktop app and its Bun sidecar: the sidecar binds to a
random port and has to tell the desktop app where it is, and only one sidecar may ever run against
a given data dir at a time.

One file, `sidecar.json`, keyed off `dataDir`, does both jobs: a `wx`-based (`O_EXCL`) create is the
exclusivity claim, and it carries the full `{ port, token }` handshake in the same write — claiming
and publishing are one act, not two. A losing process health-checks the existing file's recorded
owner via a caller-supplied check, and only clears it once confirmed dead — never by the file's age
or a possibly-reused pid.

Import from `deskkit/sidecar`. See the root [CLAUDE.md](../../CLAUDE.md#architecture) for the
rationale behind the liveness-based recovery — this file only covers how to call it.

## Sidecar boot sequence

Acquire before doing anything else, and release on shutdown via
`Effect.acquireRelease`/`Effect.scoped` — a `SIGKILL`'d process never runs the release effect, so a
stale `sidecar.json` on disk is the expected steady state, not a bug (see `handshake.ts`'s
`acquireSidecar` doc comment).

```ts
import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import {
	acquireSidecar,
	releaseSidecar,
	type SidecarLivenessCheck,
} from 'deskkit/sidecar';

/**
 * The module takes no RPC-client dependency, so callers supply their own
 * health check. Any transport failure — timeout, connection refused,
 * non-2xx — must collapse to `false`, never leak as a typed error.
 */
const isAlive: SidecarLivenessCheck = (owner) =>
	Effect.tryPromise(() => fetch(`http://localhost:${owner.port}/health`)).pipe(
		Effect.timeout('1 second'),
		Effect.map((response) => response.ok),
		Effect.orElseSucceed(() => false),
	);

const program = Effect.gen(function* () {
	const dataDir = '/path/to/data-dir';
	const token = crypto.randomUUID();

	const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
	const owner = { port: server.port, token };

	yield* Effect.acquireRelease(acquireSidecar(dataDir, owner, isAlive), () =>
		releaseSidecar(dataDir),
	);

	yield* Effect.never;
});

Effect.runFork(Effect.scoped(program).pipe(Effect.provide(BunServices.layer)));
```

`acquireSidecar` fails with `SidecarAlreadyRunning` when an existing owner answers `isAlive`, and
with `LockAcquisitionFailed` if it keeps finding (and clearing) dead owners past its retry budget —
both are typed failures for the caller to handle, not something this module swallows.

## Consumer side: waiting for the handshake

A separate process (the desktop app itself, or a dev script spawning the sidecar) waits for a
*fresh* handshake with `awaitSidecarHandshake`. Race it against the sidecar subprocess — the poll
has no bounded timeout of its own, so a sidecar that dies before publishing (or refuses to boot
because another one holds the claim) has to interrupt the wait by dying, rather than the wait giving
up on its own.

```ts
import { Effect } from 'effect';
import { awaitSidecarHandshake, readSidecarJson } from 'deskkit/sidecar';

const dataDir = '/path/to/data-dir';

const program = Effect.gen(function* () {
	// Snapshotted before spawning: sidecar.json can still hold a previous
	// run's handshake if that run was SIGKILL'd rather than shut down
	// cleanly (see acquireSidecar's doc comment), and that port is stale.
	// Passing it as `previous` is what makes the poll below wait for a *new*
	// token instead of returning the stale one on its first read.
	const previous = yield* readSidecarJson(dataDir);

	const sidecarProcess = spawnSidecar(dataDir); // however the caller spawns it
	const handshake = yield* Effect.raceAll([
		awaitSidecarHandshake(dataDir, { previous }),
		sidecarProcess,
	]);

	return handshake;
});
```

Pass `previous: undefined` only when there's nothing to compare against — e.g. the data dir is
known to be empty before this boot (a fresh install, a brand-new per-session data dir). Otherwise
always snapshot whatever `readSidecarJson` returns first, even if it's `undefined`.

## For non-deskkit readers of `sidecar.json`

`sidecar.json` is created via `wx` and written in the same call — claiming and publishing are one
act (see above) — which means there's a brief window between `open()` and the write landing where a
concurrent reader can observe an empty or partial file. deskkit's own reader
(`readHandshakeFile`/`readSidecarJson`) retries through that window automatically. A reader written
in another language — e.g. the Rust side of a Tauri app polling this file directly — must do the
same: treat a parse failure as "keep polling," not as a hard error.
