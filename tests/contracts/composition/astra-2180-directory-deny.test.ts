// Astra 2180 R1 reviewer test (proof/SHELL-OVERLAY-2026-09-29, lane 088edf75, copied unchanged there). Integration (eleventh batch) changes only
// the setup to the BWRAP-SELECT launcher model — the v1 `probeShellCapabilities()` / `.pack` `binaryPaths` setup no longer loads (TypeError):
// the service's own measurement and the production sandbox list, as runtime-shell-overlay.test.ts — and drops the unused imports (lint).
// The test body is unchanged. Proof: SHELL-OVERLAY-2026-09-29/astra-2180-r1-adaptation.md.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { globalStateRoot } from '#platform/index.js';
import { shellSandboxCapabilities } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// SHELL-OVERLAY (owner 2026-09-29: the permanent C5 answer — a sandboxed write cannot create a new floor name without a card). A full-auto
// shell call past the narrow set writes into an overlay; at its end each change is decided like an edit of that path and applied as its
// own `workspace.file.write` effect. Real runtime service, real policy files, real bubblewrap 0.13 (the reproducible build staged in the
// gitignored `.pack/`), real overlay in a user namespace.
afterEach(closeModeRuntimes);
const measured = await shellSandboxCapabilities(globalStateRoot());
const ready = process.platform === 'linux' && measured.bubblewrap.status === 'available' && measured.bubblewrap.launcher?.overlay === true
  && measured.userNamespace === 'available';
/** The live shape plus the first-run template's write operation grant (what an edit's operation side needs). */
const GRANTS = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow'),
  rule('write-op', 'operation', ['workspace.file.write'], 'allow')];
const runtime = (mode: 'full-auto' | 'auto-edit' = 'full-auto', grants = GRANTS, shell: Record<string, unknown> = {}) =>
  modeRuntime({ grants, mode, shell: { schemaVersion: 1, realm: 'require-sandbox', ...shell } });

it.skipIf(!ready)('Astra: write deny prevents overlay deletion of an empty directory', async () => {
 const f=await runtime('full-auto',[...GRANTS.slice(0,2),rule('write-op','operation',['workspace.file.write'],'deny')]);
 await mkdir(join(f.project,'src','empty'));
 const result=await f.call('run_shell',{command:'d=empty; mv src/$d /tmp/removed-empty; echo done'});
 const exists=existsSync(join(f.project,'src','empty'));
 const effects=f.rows("SELECT target_kind,target_id,state FROM effect_intents");
 console.log('ASTRA_DIRECTORY_DENY',JSON.stringify({result,exists,effects}));
 expect(result).toMatchObject({card:false});
 expect(exists).toBe(true);
},120000);
