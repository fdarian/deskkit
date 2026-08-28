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
import * as BunServices from '@effect/platform-bun/BunServices';
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

A separate process (the desktop app itself, or a dev script spawning the sidecar) waits for the
sidecar's handshake with `awaitSidecarHandshake`. Race it against the sidecar subprocess — the poll
has no bounded timeout of its own, so a sidecar that dies before publishing (or refuses to boot
because another one holds the claim) has to interrupt the wait by dying, rather than the wait giving
up on its own.

```ts
import { Effect } from 'effect';
import { awaitSidecarHandshake } from 'deskkit/sidecar';

const dataDir = '/path/to/data-dir';
const token = crypto.randomUUID();

const program = Effect.gen(function* () {
	// The waiter mints the token and hands it to the sidecar to publish (an
	// env var is the natural channel — see spawnSidecar below) — that's what
	// lets awaitSidecarHandshake wait for this exact token instead of merely
	// "something changed", so a stale or third-party handshake already on
	// disk can't be mistaken for it.
	const sidecarProcess = spawnSidecar(dataDir, { token }); // however the caller spawns it
	const handshake = yield* Effect.raceAll([
		awaitSidecarHandshake(dataDir, { token }),
		sidecarProcess,
	]);

	return handshake;
});
```

## Running the sidecar under a file watcher

A sidecar re-run by a file watcher on every save breaks the assumption the rest of this doc relies
on: a fresh `{ port, token }` per boot.

Prefer `bun --watch` over `bun --hot`. `--hot` re-runs the entry module in the same process without
ever unwinding the previous evaluation, so every background loop, timer, and open DB connection from
every prior boot keeps running — a git-polling loop or a scheduled task started once per boot means
ten saves leaves ten of them running concurrently against one data dir. `--watch` tears the process
down and restarts it cleanly, so exactly one instance is ever live.

A per-boot `crypto.randomUUID()` token rotates under either watcher, since the entry module's
top-level code reruns either way. The port only sometimes does: `--hot` hands the reloaded
`Bun.serve` back the same socket, so it survives, but `--watch` restarts the process outright, so a
`Bun.serve({ port: 0 })` ephemeral port rotates too. Either way, a frontend that had `{ port, token }`
frozen into a build-time env var (e.g. Vite's `import.meta.env`) at its own boot has no way to learn
the new pair, so every request it makes 401s silently, with nothing explaining why. Pin both for the
whole dev session instead: mint the token and port once in the dev orchestrator, not the sidecar, and
pass them in — env vars are the natural channel — rather than letting the sidecar mint fresh ones on
every restart.

A pinned port surviving restarts relies on `acquireSidecar` taking over a `sidecar.json` that records
the port the acquiring process is itself already listening on, rather than health-checking it — see
`handshake.ts`'s `acquireAttempt`. Without that, every restart would find its own just-published
`sidecar.json` and refuse to boot, mistaking itself for a still-live rival.

## For non-deskkit readers of `sidecar.json`

`sidecar.json` is created via `wx` and written in the same call — claiming and publishing are one
act (see above) — which means there's a brief window between `open()` and the write landing where a
concurrent reader can observe an empty or partial file. deskkit's own reader
(`readHandshakeFile`/`readSidecarJson`) retries through that window automatically. A reader written
in another language — e.g. the Rust side of a Tauri app polling this file directly — must do the
same: treat a parse failure as "keep polling," not as a hard error.
