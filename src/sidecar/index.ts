export type { AwaitSidecarHandshakeOptions } from './handshake.ts';
export {
	awaitSidecarHandshake,
	publishSidecarJson,
	readSidecarJson,
	SidecarHandshake,
} from './handshake.ts';
export type { SidecarLivenessCheck } from './lock.ts';
export {
	acquireSidecarLock,
	LockAcquisitionFailed,
	releaseSidecarLock,
	SidecarAlreadyRunning,
} from './lock.ts';
