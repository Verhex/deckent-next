import { existsSync } from 'node:fs';

// Mirrors the current adapter capability, not POSIX or general filesystem support.
// Successful descriptor-relative read/edit tests need Linux per-descriptor paths.
export const WORKSPACE_DESCRIPTOR_CUSTODY_AVAILABLE = process.platform === 'linux' && existsSync('/proc/self/fd');
