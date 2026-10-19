import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation, upgradePolicyTemplateInstallation as upgradeInstallation } from '#composition/core/installation/index.js';
import { createConfiguredConfigApplication } from '#composition/core/config/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { restartConfiguredRuntimeService, stopConfiguredRuntimeService } from '#composition/core/cli/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { DispatchInventoryPolicyAuthorization, ServicePolicyAuthorization } from '#engine/index.js';
import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS } from '#domain/index.js';
import { clearConfigCache, productResourcePath, resolveProductLayout } from '#platform/index.js';

/** SEC-1 (I-POL): `init policy --upgrade --apply` is an authority write and vitest has no terminal, so this file attests the witness; the refusal
 * without one is tests/contracts/composition/policy-upgrade-witness.test.ts. */
const upgradePolicyTemplateInstallation = (...args: Parameters<typeof upgradeInstallation>) =>
  upgradeInstallation(args[0], args[1], args[2], args[3], args[4], args[5], args[6], { attest: async () => true });

// POLICY-V12 (owner 2026-10-16, clean-install rehearsal F1/F2): on a fresh `init policy --apply` installation, with nothing configured by hand,
// the owner observes their own scope, the service's recovery passes are not refused, and `runtime restart` / `runtime shutdown` work through the
// governed stop. Real composition: the installer journal, the first-session config, the ledger, the runtime socket and the policy file.
const SCOPE = 'installation', SERVICE = 'installation-runtime', V12 = ['first-run-scope-inspect', 'first-run-service-shutdown'];
// I-POL (alpha.48): the current template is v13; an older (v11) template also lacks the v13 delta, which the upgrade then adds after the v12 rules.
const V13: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, OLDER = (id: string) => V12.includes(id) || V13.includes(id);
/** How long the recovery passes get to show a refusal: both passes run at start and then poll, so their first page arrives well inside this. */
const RECOVERY_WINDOW_MS = 5_000;
const roots: string[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); await service.settled; }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function installed(edit?: (policy: { revision: string; grants: { id: string }[] }) => unknown) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-fresh-owner-')); roots.push(project);
  const env = { HOME: join(project, 'home'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' }; await mkdir(env.HOME, { mode: 0o700 });
  const result = await applyPolicyTemplateInstallation(project, SCOPE);
  const policyPath = productResourcePath(resolveProductLayout({ projectRoot: project }), 'policy');
  if (edit) await writeFile(policyPath, `${JSON.stringify(edit(JSON.parse(await readFile(policyPath, 'utf8'))))}\n`, { mode: 0o600 });
  clearConfigCache();
  const errors: { readonly pass: string; readonly code: string }[] = [], pages: string[] = [];
  const observer = { onPage() { pages.push('cancellation'); }, onError(_command: unknown, error: { code: string }) { errors.push({ pass: 'cancellation', code: error.code }); },
    onReconciliationPage() { pages.push('reconciliation'); }, onReconciliationError(_command: unknown, error: { code: string }) { errors.push({ pass: 'reconciliation', code: error.code }); } };
  const start = async (startEnv: Record<string, string> = env) => { const service = await startConfiguredRuntimeService(project, observer, { env: startEnv }); services.push(service); return service; };
  /** Both recovery passes have reported (a page or an error), or the window is over. */
  const settle = async () => { const deadline = Date.now() + RECOVERY_WINDOW_MS;
    while (Date.now() < deadline && !(['cancellation', 'reconciliation'].every(pass => pages.includes(pass) || errors.some(error => error.pass === pass)))) await new Promise(resolve => setTimeout(resolve, 50)); };
  return { project, env, result, policyPath, errors, pages, start, settle };
}

describe.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket and OS-user identity] fresh install: the owner observes and restarts their own installation', () => {
  it('init policy --apply → service start → inventory → no POLICY_DENIED recovery → runtime restart → runtime shutdown', async () => {
    const f = await installed();
    expect(f.result).toMatchObject({ status: 'installed', template: { version: 13 }, serviceIdentity: { status: 'written', identity: { scopeId: SCOPE, serviceId: SERVICE } } });
    // `config explain service.identity` shows the deterministic, non-secret identity from the project layer.
    expect(await createConfiguredConfigApplication(f.project, { env: f.env }).explain({ keyPath: 'service.identity' }))
      .toMatchObject({ value: { scopeId: SCOPE, serviceId: SERVICE }, source: 'project', apply: 'restart', redacted: false });
    const me = readLocalOsIdentity();
    expect((JSON.parse(await readFile(f.policyPath, 'utf8')) as { grants: { id: string; principals: unknown }[] }).grants.filter(rule => V12.includes(rule.id))
      .map(rule => rule.principals)).toEqual([[{ issuer: me.issuer, subject: me.subject }], [{ issuer: me.issuer, subject: me.subject }]]);

    await f.start();
    expect(await createConfiguredRuntimeClient(f.project, { env: f.env }).describeService()).toMatchObject({ shutdownAvailable: true, identity: { scopeId: SCOPE, serviceId: SERVICE } });
    // `deckent inventory --scope installation --json`: the owner reads their own scope (v11: POLICY_DENIED).
    expect(await inspectConfiguredInventory(f.project, { schemaVersion: 1, scopeId: SCOPE }, { env: f.env })).toMatchObject({ schemaVersion: 1, page: { entries: [], nextAfter: null } });
    await f.settle();
    expect(f.pages).toEqual(expect.arrayContaining(['cancellation', 'reconciliation']));
    expect(f.errors).toEqual([]);

    // `deckent runtime restart`: governed stop of this service, then a new start (the launch is the in-process stand-in of the detached process).
    const launched: Record<string, string>[] = [];
    const restarted = await restartConfiguredRuntimeService(f.project, { env: f.env }, async launch => { launched.push(launch.env); await services.at(-1)!.done;
      await f.start(launch.env); return { pid: process.pid }; }, fileURLToPath(import.meta.url));
    expect(restarted.mode).toBe('started'); expect(launched).toHaveLength(1);
    // `deckent runtime shutdown`: admitted on the owner's v12 rule; the service ends.
    const stopped = await stopConfiguredRuntimeService(f.project, { env: f.env });
    expect(stopped.result).toMatchObject({ replayed: false, admission: { scopeId: SCOPE, command: { serviceId: SERVICE },
      authorization: { revision: expect.stringContaining('first-run-template-v13'), ruleId: 'first-run-service-shutdown' }, actor: { principal: { assurance: 'os-user' } } } });
    await services.at(-1)!.done;
    await expect(createConfiguredRuntimeClient(f.project, { env: f.env }).describeService()).rejects.toBeDefined();
  });

  it('negatives: the MCP actor cannot shut the service down; another person cannot inspect or shut down; a foreign scope stays denied', async () => {
    const f = await installed(); await f.start();
    // The local MCP actor is the same OS peer on the MCP channel: admitted as an actor, refused by policy (it keeps v9 observation only).
    await expect(withMcpPrincipal(() => stopConfiguredRuntimeService(f.project, { env: f.env }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await createConfiguredRuntimeClient(f.project, { env: f.env }).describeService()).toMatchObject({ shutdownAvailable: true });
    const me = readLocalOsIdentity(), source = createLayoutPolicySource(resolveProductLayout({ projectRoot: f.project }), process.getuid!(), 1_048_576);
    const colleague = { id: 'colleague', issuer: me.issuer, subject: `${me.subject}9`, assurance: 'os-user' as const, scopeIds: [SCOPE] };
    const owner = { id: 'owner', issuer: me.issuer, subject: me.subject, assurance: 'os-user' as const, scopeIds: [SCOPE, 'foreign'] };
    await expect(new DispatchInventoryPolicyAuthorization(source).authorize(SCOPE, colleague)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(new ServicePolicyAuthorization(source).authorize({ scopeId: SCOPE, serviceId: SERVICE }, colleague)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(new DispatchInventoryPolicyAuthorization(source).authorize('foreign', owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(new ServicePolicyAuthorization(source).authorize({ scopeId: 'foreign', serviceId: SERVICE }, owner)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(inspectConfiguredInventory(f.project, { schemaVersion: 1, scopeId: 'foreign' }, { env: f.env })).rejects.toBeDefined();
  });

  it('control: the exact v11 policy reproduces F2 (inventory and recovery POLICY_DENIED); the installer upgrade fixes it once the service restarts', async () => {
    const f = await installed(policy => ({ ...policy, revision: 'first-run-template-v11', grants: policy.grants.filter(rule => !OLDER(rule.id)) }));
    const service = await f.start();
    await expect(inspectConfiguredInventory(f.project, { schemaVersion: 1, scopeId: SCOPE }, { env: f.env })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.settle();
    expect(f.errors.filter(error => error.code === 'POLICY_DENIED').map(error => error.pass)).toEqual(expect.arrayContaining(['reconciliation']));
    await expect(stopConfiguredRuntimeService(f.project, { env: f.env })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // The exact-template upgrade (identity already configured at install: kept) adds exactly the two owner rules (and the v13 delta).
    const preview = await upgradePolicyTemplateInstallation(f.project, SCOPE, false, undefined, { env: f.env });
    expect(preview).toMatchObject({ status: 'preview', basis: 'first-run', exact: true, serviceIdentity: { status: 'kept' } });
    expect(preview.rules.map(rule => (rule as { id: string }).id)).toEqual([...V12, ...V13]);
    expect(await upgradePolicyTemplateInstallation(f.project, SCOPE, true, preview.expect!, { env: f.env })).toMatchObject({ status: 'upgraded', template: { to: 13 } });
    await expect(inspectConfiguredInventory(f.project, { schemaVersion: 1, scopeId: SCOPE }, { env: f.env })).resolves.toMatchObject({ page: { entries: [], nextAfter: null } });
    await stopConfiguredRuntimeService(f.project, { env: f.env }); await service.done;
    f.errors.length = 0; f.pages.length = 0; await f.start(); await f.settle();
    expect(f.errors).toEqual([]);
  });

  it('Astra 2596: an identity changed between preview and apply is a typed conflict; nothing is written for the stale service id', async () => {
    const f = await installed(policy => ({ ...policy, revision: 'first-run-template-v11', grants: policy.grants.filter(rule => !OLDER(rule.id)) }));
    const preview = await upgradePolicyTemplateInstallation(f.project, SCOPE, false, undefined, { env: f.env });
    expect(preview).toMatchObject({ status: 'preview', expect: expect.stringMatching(/^first-run-template-v11~[a-f0-9]{12}$/u) });
    const configPath = join(f.project, '.deckent', 'config.json'), config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    // An authorized configuration change in between: the service is now `moved`.
    await writeFile(configPath, `${JSON.stringify({ ...config, service: { identity: { scopeId: SCOPE, serviceId: 'moved' } } })}\n`, { mode: 0o600 }); clearConfigCache();
    const policyBefore = await readFile(f.policyPath, 'utf8'), configBefore = await readFile(configPath, 'utf8');
    expect(await upgradePolicyTemplateInstallation(f.project, SCOPE, true, preview.expect!, { env: f.env }))
      .toMatchObject({ status: 'conflict', reason: 'service-identity-changed', rules: [] });
    expect(await readFile(f.policyPath, 'utf8')).toBe(policyBefore); expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    // A new preview names the current service; its token applies, and the stop rule names `moved`, never the stale id.
    const again = await upgradePolicyTemplateInstallation(f.project, SCOPE, false, undefined, { env: f.env });
    expect(again.expect).not.toBe(preview.expect);
    expect(await upgradePolicyTemplateInstallation(f.project, SCOPE, true, again.expect!, { env: f.env })).toMatchObject({ status: 'upgraded', serviceIdentity: { status: 'kept' } });
    expect((JSON.parse(await readFile(f.policyPath, 'utf8')) as { grants: { id: string; resource: unknown }[] }).grants.find(rule => rule.id === V12[1])?.resource)
      .toEqual({ kind: 'service', ids: ['moved'] });
  });

  it('upgrade writes a missing service.identity for an exact or an edited first-run policy (option A); an existing identity is never replaced', async () => {
    const config = (project: string) => readFile(join(project, '.deckent', 'config.json'), 'utf8');
    const unset = async (project: string) => { const text = JSON.parse(await config(project)) as { service?: unknown }; delete text.service;
      await writeFile(join(project, '.deckent', 'config.json'), `${JSON.stringify(text)}\n`, { mode: 0o600 }); clearConfigCache(); };
    const exact = await installed(policy => ({ ...policy, revision: 'first-run-template-v11', grants: policy.grants.filter(rule => !OLDER(rule.id)) }));
    await unset(exact.project);
    const preview = await upgradePolicyTemplateInstallation(exact.project, SCOPE, false, undefined, { env: exact.env });
    expect(preview).toMatchObject({ status: 'preview', serviceIdentity: { status: 'planned', identity: { scopeId: SCOPE, serviceId: SERVICE } } });
    expect(JSON.parse(await config(exact.project))).not.toHaveProperty('service');
    expect(await upgradePolicyTemplateInstallation(exact.project, SCOPE, true, preview.expect!, { env: exact.env }))
      .toMatchObject({ status: 'upgraded', serviceIdentity: { status: 'written', identity: { scopeId: SCOPE, serviceId: SERVICE } } });
    expect(JSON.parse(await config(exact.project))).toMatchObject({ service: { identity: { scopeId: SCOPE, serviceId: SERVICE } } });
    expect(await upgradePolicyTemplateInstallation(exact.project, SCOPE, true, undefined, { env: exact.env })).toMatchObject({ status: 'current', serviceIdentity: { status: 'kept' } });

    const edited = await installed(policy => ({ ...policy, revision: 'a-edited', grants: policy.grants.filter(rule => !OLDER(rule.id))
      .concat([{ id: 'hand-added', effect: 'allow', actions: ['invoke'], scopes: [SCOPE], principals: (policy.grants[0] as unknown as { principals: unknown }).principals,
        resource: { kind: 'agent-tool', ids: ['fetch_url'] } } as never]) }));
    await unset(edited.project); const before = JSON.parse(await readFile(edited.policyPath, 'utf8')) as { grants: unknown[] };
    const editedPreview = await upgradePolicyTemplateInstallation(edited.project, SCOPE, false, undefined, { env: edited.env });
    expect(editedPreview).toMatchObject({ status: 'preview', basis: 'first-run', exact: false, revision: 'a-edited', serviceIdentity: { status: 'planned' } });
    expect(editedPreview.rules.map(rule => (rule as { id: string }).id)).toEqual([...V12, ...V13]);
    expect(JSON.parse(await config(edited.project))).not.toHaveProperty('service');
    expect(await upgradePolicyTemplateInstallation(edited.project, SCOPE, true, editedPreview.expect!, { env: edited.env }))
      .toMatchObject({ status: 'upgraded', serviceIdentity: { status: 'written', identity: { scopeId: SCOPE, serviceId: SERVICE } } });
    const editedAfter = JSON.parse(await readFile(edited.policyPath, 'utf8')) as { grants: { id: string }[] };
    expect(editedAfter.grants.slice(0, before.grants.length)).toEqual(before.grants); // hand-added and every existing rule kept
    expect(editedAfter.grants.slice(before.grants.length).map(rule => rule.id)).toEqual([...V12, ...V13]);
    expect(await upgradePolicyTemplateInstallation(edited.project, SCOPE, true, undefined, { env: edited.env })).toMatchObject({ status: 'current', serviceIdentity: { status: 'kept' } });
    // The edited installation now observes its scope and stops its own service; the MCP actor still cannot stop it.
    clearConfigCache(); const service = await edited.start();
    await expect(inspectConfiguredInventory(edited.project, { schemaVersion: 1, scopeId: SCOPE }, { env: edited.env })).resolves.toMatchObject({ page: { entries: [], nextAfter: null } });
    await expect(withMcpPrincipal(() => stopConfiguredRuntimeService(edited.project, { env: edited.env }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await stopConfiguredRuntimeService(edited.project, { env: edited.env }); await service.done;

    // An identity configured for another scope is kept as it is (never overwritten) and named.
    const other = await installed(policy => ({ ...policy, revision: 'first-run-template-v11', grants: policy.grants.filter(rule => !OLDER(rule.id)) }));
    const text = JSON.parse(await config(other.project)) as Record<string, unknown>;
    await writeFile(join(other.project, '.deckent', 'config.json'), `${JSON.stringify({ ...text, service: { identity: { scopeId: 'elsewhere', serviceId: 'theirs' } } })}\n`, { mode: 0o600 });
    clearConfigCache();
    expect(await upgradePolicyTemplateInstallation(other.project, SCOPE, true, undefined, { env: other.env }))
      .toMatchObject({ status: 'upgraded', serviceIdentity: { status: 'other-scope', identity: { scopeId: 'elsewhere', serviceId: 'theirs' } } });
  });
});
