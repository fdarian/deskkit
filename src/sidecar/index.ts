export type {
	AwaitSidecarHandshakeOptions,
	SidecarLivenessCheck,
} from './handshake.ts';
export {
	acquireSidecar,
	awaitSidecarHandshake,
	LockAcquisitionFailed,
	readSidecarJson,
	releaseSidecar,
	SidecarAlreadyRunning,
	SidecarHandshake,
	SidecarTakeoverContested,
} from './handshake.ts';
