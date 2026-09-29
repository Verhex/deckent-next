import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

// BWRAP-SELECT test infrastructure (lead 2026-09-29): every real-bubblewrap test skips when the host measurement selected no working
// launcher — on this development machine that happens whenever the locked bundled build is not staged (the system bwrap 0.9.0 is below the
// 0.12.0 minimum), and 34 real-sandbox tests (plus the SHELL-OVERLAY ones) went silently green-by-skip. This guard turns that into one
// failure: a Linux host that can create user namespaces (and does not restrict them with AppArmor, the typed fallback) must have selected a
// launcher whose own sandbox run succeeded and that has the overlay options. The host facts come from the kernel's sysctls, not from the
// native helper, so a missing helper cannot hide the gap either.
const measured = await measureTestShellHost();
const sysctl = (name: string): number | null => { try { return Number(readFileSync(`/proc/sys/${name}`, 'utf8').trim()); } catch { return null; } };
const usernsAllowed = process.platform === 'linux' && (sysctl('user/max_user_namespaces') ?? 0) > 0 && sysctl('kernel/unprivileged_userns_clone') !== 0;
const apparmorRestricted = sysctl('kernel/apparmor_restrict_unprivileged_userns') === 1 || measured.bubblewrap.status === 'restricted';
const FIX = 'stage the locked bundled build: `node scripts/build-bwrap.mjs` (Docker), or `DECKENT_BWRAP_BUILD=<build-bwrap output> npm run build`, '
  + 'or `node scripts/build-bwrap.mjs --stage-dev <build-bwrap output>`';

describe('real-sandbox guard (BWRAP-SELECT): a sandbox-capable host never skips the bubblewrap tests', () => {
  // One check per Linux host, never skipped there: the expectation follows the host's own facts.
  it.runIf(process.platform === 'linux')('the measurement matches the host: a working launcher with overlay where user namespaces are open, a typed answer under AppArmor or closed namespaces', () => {
    const { status, launcher, rejected, detail } = measured.bubblewrap;
    const why = `bubblewrap ${status}${detail ? ` (${detail})` : ''}; rejected: ${rejected.map(item => `${item.path}: ${item.reason}`).join('; ') || 'none'}; `
      + `bundled staged: ${existsSync(new URL('../../../src/adapters/core/shell-sandbox-bwrap/bundled/', import.meta.url))}. Fix: ${FIX}`;
    if (usernsAllowed && !apparmorRestricted) expect({ status, overlay: launcher?.overlay ?? false }, why).toEqual({ status: 'available', overlay: true });
    // AppArmor-restricted or closed user namespaces: the real-sandbox tests legitimately skip (the resolver falls back visibly); the
    // measurement must still be a typed answer, never `unknown` (a probe that did not finish).
    else expect(['available', 'restricted', 'unavailable'], why).toContain(status);
  });
});
