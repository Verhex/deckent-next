import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import { applySuppliedInstallation } from '#composition/core/installation/index.js';
import { evaluatePolicy, firstRunPolicyTemplate, mcpPrincipalRef, policyFileSchema, resolvePolicyBindings } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES, hashInstallationProfilePayload, InstallationPreviewApplication, installationPublishTargets } from '#engine/core/installation/index.js';
import { main } from '#surfaces/index.js';
import { installationProfile } from '../support/installation-profile.js';

// H (owner 2026-10-29): `init apply --profile` publishes the SUPPLIED policy verbatim. Content the unwitnessed first-run template would not give the
// installing person (here: edit/shell tools as `allow` where the template says `require-approval`, i.e. full-auto without a mode) is an authority
// write and needs the SEC-1 witness, exactly as `init policy --modes|--upgrade --apply`; a profile inside the template keeps working headless.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const person = adapters.readLocalOsIdentity(), local = { issuer: person.issuer, subject: person.subject };
const widened = { id: 'widened-edit-shell', effect: 'allow' as const, actions: ['invoke'], scopes: ['scope-1'], principals: [local],
  resource: { kind: 'agent-tool', ids: [...FIRST_RUN_TOOL_NAMES.editShellToolNames] } };
function profile(extra: readonly typeof widened[] = [], principal = local) {
  const value = installationProfile(); value.configuration.execution.docker.executable = '/usr/bin/docker'; // config validation needs an absolute path; never run
  value.policy.grants = [...value.policy.grants, ...extra].map(grant => ({ ...grant, principals: [principal] }));
  value.profile.digest = hashInstallationProfilePayload({ ...value, profile: { id: value.profile.id, version: value.profile.version } });
  return value;
}
const actor = { id: 'person', ...local, assurance: 'os-user' as const, scopeIds: ['scope-1'] };
const editCell = { principal: actor, scopeId: 'scope-1', action: 'invoke', resource: { kind: 'agent-tool', id: 'edit_file' } };

describe.skipIf(process.platform !== 'linux')('supplied installation profile authority (owner 2026-10-29, H)', () => {
  it('a supplied policy wider than the first-run template is published verbatim, so applying it needs the authority witness', async () => {
    const supplied = profile([widened]), paths = { config: '/p/.deckent/config.json', policy: '/p/.deckent/policy.json', ledger: '/p/.deckent/state/ledger.db' };
    const prepared = await new InstallationPreviewApplication({ resolvePaths: async (_root, config) => ({ config, layout: { schemaVersion: 2, revision: 'l',
      root: '/p/.deckent', bootstrapConfigPath: paths.config }, paths }), validateProfile: definition => ({ imageId: String(definition.parameters.imageId) }),
    validateEvaluator: () => undefined }).prepare('/p', supplied, { principal: local, allowShutdown: false });
    const policy = installationPublishTargets(prepared, { proposalDigest: 'e'.repeat(64) } as never, 'tx-1').find(target => target.resource === 'policy')!;
    expect(JSON.parse(policy.content)).toEqual(supplied.policy);
    expect(evaluatePolicy(JSON.parse(policy.content), editCell)).toMatchObject({ decision: 'allow', ruleId: 'widened-edit-shell' });
    const template = firstRunPolicyTemplate({ scopeId: 'scope-1', principal: local, ...FIRST_RUN_TOOL_NAMES, serviceId: 'service-1' });
    expect(evaluatePolicy(resolvePolicyBindings(template.policy, template.bindings), editCell)).toMatchObject({ decision: 'require-approval' });
    // A resolved v2 snapshot (the other `policySchema` arm) is not a policy.json the runtime loads: it fails closed rather than widening.
    expect(policyFileSchema.safeParse(resolvePolicyBindings(template.policy, template.bindings)).success).toBe(false);

    // The gate: refused off a terminal and for MCP before any evidence step or write; the template-bounded profile stays headless.
    const root = await mkdtemp(join(tmpdir(), 'deckent-profile-authority-')); roots.push(root);
    const apply = async (value: unknown) => applySuppliedInstallation(root, value, { allowShutdown: false, dockerExecutable: join(root, 'no-docker'),
      proposalDigest: '0'.repeat(64), acceptCustom: true }).then(() => 'applied', (error: { code?: string }) => error.code ?? String(error));
    const profilePath = join(root, 'profile.json'); await writeFile(profilePath, JSON.stringify(profile([widened])), { mode: 0o600 });
    expect(await adapters.attestLocalInteractiveTerminal()).toBe(false); // vitest has no controlling terminal
    expect(await apply(profile([widened]))).toBe('AUTHORITY_WITNESS_REQUIRED');
    // The `init apply` command (in process, host wiring) exits non-zero with the existing EN/TR witness text.
    for (const [lang, words] of [['en', 'needs a person at an interactive terminal'], ['tr', 'etkileşimli terminaldeki bir kişi gerektirir']] as const) {
      const errors: string[] = [], sink = { write(value: string) { errors.push(value); } };
      expect(await main(['init', 'apply', '--profile', profilePath, '--docker-executable', join(root, 'no-docker'), '--proposal', '0'.repeat(64), '--accept-custom', '--lang', lang],
        { root, env: {}, stdout: sink, stderr: sink, applyInstallation: async (projectRoot, input) => applySuppliedInstallation(projectRoot, JSON.parse(await readFile(input.profilePath, 'utf8')),
          { allowShutdown: input.allowShutdown, dockerExecutable: input.dockerExecutable, proposalDigest: input.proposalDigest, acceptCustom: input.acceptCustom }) })).not.toBe(0);
      expect(errors.join('')).toContain(words);
    }
    expect(await readdir(root)).toEqual(['profile.json']); // no .deckent, journal, policy or identity
    // Inside the template (the fixture's pool grant): no witness is asked; it reaches the evidence step, whose executable check refuses before any Docker call.
    const narrow = await apply(profile());
    expect(narrow).toBe('INSTALLATION_PROFILE_CONFIG');
    // A person at the terminal passes the gate (then the same evidence step); the MCP actor never does.
    vi.spyOn(adapters, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
    const witnessed = await apply(profile([widened]));
    expect(witnessed).toBe('INSTALLATION_PROFILE_CONFIG');
    // Under MCP the installer's principal is the MCP actor: a profile naming it passes preview, and the witness refuses it even though it would attest.
    expect(await adapters.withLocalPrincipalChannel('mcp', () => apply(profile([widened], mcpPrincipalRef(local))))).toBe('AUTHORITY_WITNESS_REQUIRED');
  });
});
