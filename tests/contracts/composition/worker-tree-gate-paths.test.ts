import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';

// S6 structural guarantee: every way a worker is given a tree goes through the one gated composition (`executeConfiguredTask`). SDK
// `executeTask`, MCP/CLI task execution, run progression, retries and recorded-workspace restarts all call that function; reconciliation,
// cancellation, output recovery and release reuse a recorded dispatch and never launch. A new launch site must fail this test.
const ROOT = join(import.meta.dirname, '../../..');
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
const files = sources(join(ROOT, 'src')).map(path => ({ path: relative(ROOT, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));
const sites = (needle: RegExp) => files.filter(file => needle.test(file.text)).map(file => file.path).sort();
const TASK = 'src/composition/core/execution/internal/task.ts', BEUSER = 'src/composition/core/beuser/internal/application.ts';

it('keeps coding-tree and isolated BeUser launches behind their own admitted gates', () => {
  // A container launch happens only through DispatchApplication.execute (it claims the one dispatch fence of an attempt). Every module
  // that builds a DispatchApplication is listed; configured coding tasks and admitted BeUser tasks call `.execute(` — the others reconcile, cancel,
  // recover output or release a recorded dispatch. Only the bounded BeUser controller receives an execute-capable dispatch port.
  const builders = sites(/new DispatchApplication\(/u);
  expect(builders).toEqual([BEUSER, 'src/composition/core/execution/internal/task.ts', 'src/composition/core/runs/internal/cancellation-runtime.ts',
    'src/composition/core/runs/internal/reconcile.ts', 'src/composition/core/runs/internal/recover-output.ts', 'src/engine/core/workspace-patch/internal/custody.ts']);
  const beuser = files.find(file => file.path === BEUSER)!.text;
  const admitted = beuser.indexOf("await policy.authorizeIdentity('execute', request.identity, c.principal)"), selected = beuser.indexOf('selectReservedTaskProfile(await store.loadRun(');
  expect(admitted).toBeGreaterThan(-1); expect(selected).toBeGreaterThan(admitted);
  expect(beuser.indexOf('if (!isDeepStrictEqual(profile,')).toBeGreaterThan(selected);
  const harness = beuser.indexOf('harness = await createConfiguredBeuserHarness(');
  expect(harness).toBeGreaterThan(beuser.indexOf('if (!isDeepStrictEqual(profile,'));
  expect(beuser.indexOf('new DispatchApplication(')).toBeGreaterThan(harness);
  expect(beuser).toContain('id => hooks?.created(id)');
  expect(builders.filter(path => /\.execute\(/u.test(files.find(file => file.path === path)!.text))).toEqual([BEUSER, TASK]);
  const controller = 'src/engine/core/beuser/internal/supervisor.ts';
  const executePorts = files.flatMap(file => [...file.text.matchAll(/Pick<DispatchApplication,([^>]*)>/gu)]
    .filter(pick => pick[1]!.includes('execute')).map(pick => ({ path: file.path, members: pick[1]!.trim() })));
  expect(executePorts).toEqual([{ path: controller, members: "'execute' | 'cancel' | 'reconcile' | 'recoverOutput' | 'release'" }]);
  const guarded = files.find(file => file.path === controller)!.text;
  expect(guarded).toContain('await this.guard(context, request, false); return this.dispatch.execute(request, credential, context.signal)');
  expect(guarded).toContain('assertBeuserRequestIdentity(checked, request.identity)');
  expect(guarded).toContain("assertBeuserAccess(checked, checked.binding, checked.principal, { kind: 'attempt', id: request.identity.attemptId }, 'evaluate')");
  expect(sites(/\.supervisor\.execute\(/u)).toEqual(['src/engine/core/dispatch/internal/application.ts']);
  // A provider connection for a worker and a launch-capable supervisor are built only there (open.ts is the test/runtime assembly that never
  // launches; its supervisor is not exported from the public SDK).
  expect(sites(/\bopenNativeConnection\(\{/u)).toEqual([TASK]);
  // docker.ts is `restoreProfile` of an already-claimed recorded dispatch (reconcile/cancel/recover/release) and the removal-only probe
  // sweep entry (`sweepPreflightProbes`), never a new claim.
  expect(sites(/new DockerSupervisor\(/u)).toEqual(['src/adapters/core/docker-supervisor/internal/docker.ts', 'src/composition/core/execution/internal/open.ts', TASK]);
  // REVISE 2691: the service-start probe sweep removes only and goes through the adapter's removal-only entry, never a supervisor of its own.
  expect(sites(/DockerSupervisor\.sweepPreflightProbes\(/u)).toEqual(['src/composition/core/execution/internal/preflight.ts']);
  expect(sites(/openConfiguredExecution/u)).toEqual(['src/composition/core/execution/index.ts', 'src/composition/core/execution/internal/open.ts']);
  expect(readFileSync(join(ROOT, 'src/index.ts'), 'utf8')).not.toContain('openConfiguredExecution');
});

it('scans after the tree is final and before any connection, supervisor or claim in the gated path', () => {
  const text = files.find(file => file.path === TASK)!.text, at = (needle: string) => { const index = text.indexOf(needle); expect(index, needle).toBeGreaterThan(-1); return index; };
  // R2 (D3a 2026-10-18): the gate runs through scan admission; its scan port is the adapter scan of exactly those views.
  const gate = at('await enforceAdmittedWorkerTreeGate({ views: workerTreeViews(lease.workspace, readOnlyMounts, start, profile.argv)');
  expect(text.indexOf('enforceAdmittedWorkerTreeGate(')).toBe(text.lastIndexOf('enforceAdmittedWorkerTreeGate(')); expect(at('scan: async views => scanWorkerTree(views,')).toBeGreaterThan(gate);
  // The one decision stays `enforceWorkerTreeGate`, called only by the admitted gate (no second, unadmitted gate path in src).
  expect(sites(/\benforceWorkerTreeGate\(/u)).toEqual(['src/engine/core/workspaces/internal/scan-admission.ts', 'src/engine/core/workspaces/internal/secret-gate.ts']);
  expect(at('.acquire(identity)')).toBeLessThan(gate); expect(at('const readOnlyMounts =')).toBeLessThan(gate); expect(at('start = await prepareTaskStart(')).toBeLessThan(gate); expect(at('applyAcceptedPredecessorPatches(lease')).toBeLessThan(gate);
  // Parity: every host source the container or the prompt receives is a view of the same scan (checkout, binds, inputs, handoff files, context).
  for (const source of ['inputs: start.inputs', 'handoffInputs: start.handoffInputs', '{ readOnlyMounts }', 'dependencyContext: start.dependencyContext', 'workspace: lease.workspace', 'argv: profile.argv']) at(source);
  for (const later of ['recordAttemptHandoffStart(store', 'openNativeConnection({', 'new DockerSupervisor(', 'app.execute(request, undefined, silence.signal)', 'dispatching = true']) expect(at(later)).toBeGreaterThan(gate);
});
