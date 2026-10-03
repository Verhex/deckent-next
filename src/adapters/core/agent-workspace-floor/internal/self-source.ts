import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { readBuildIdentity } from '#platform/index.js';
import { GIT_LISTING_MAX_BYTES, GIT_LISTING_TIMEOUT_MS } from '#adapters/core/host-shell/index.js';
import { isAnyWriteFloored, isWriteApprovalFloored } from '#adapters/core/workspace-write/index.js';

/** Pure equality of canonical repository identities. An absent/old build identity never opts a customer in. */
export const isSelfSourceIdentity = (projectCommonDir: string | null, sourceCommonDir?: string | null): boolean =>
  typeof sourceCommonDir === 'string' && sourceCommonDir.length > 0 && projectCommonDir === sourceCommonDir;
const execute = promisify(execFile);
/** Reuse the existing local Git observation resource bounds. */
const SOURCE_IDENTITY_GIT_LIMITS = Object.freeze({ timeout: GIT_LISTING_TIMEOUT_MS, maxBuffer: GIT_LISTING_MAX_BYTES });
/** Git owns worktree/common-directory resolution. Ignore inherited Git overrides: identity belongs to this project. */
export async function resolveSourceCommonDir(projectRoot: string): Promise<string | null> {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const { stdout } = await execute('git', ['rev-parse', '--git-common-dir'], { cwd: projectRoot, env, ...SOURCE_IDENTITY_GIT_LIMITS });
    const common = stdout.trim();
    return common ? await realpath(resolve(projectRoot, common)) : null;
  } catch { return null; }
}
/** Derived per turn/start, without configuration. Missing/unreadable identity or Git metadata is a safe negative. */
export async function isSelfSourceProject(projectRoot: string, identity: { readonly sourceCommonDir?: string } | null = readBuildIdentity()): Promise<boolean> {
  return identity?.sourceCommonDir ? isSelfSourceIdentity(await resolveSourceCommonDir(projectRoot), identity.sourceCommonDir) : false;
}
/** Full access retains the very same authority-only callback; customer projects retain the static floor callback. */
export const agentTurnWriteFloor = (authority: (rel: string) => boolean, fullAccess: boolean, selfSource: boolean): (rel: string) => boolean =>
  fullAccess ? authority : selfSource ? isAnyWriteFloored : isWriteApprovalFloored;
