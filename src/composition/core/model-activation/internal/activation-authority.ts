import { isDeepStrictEqual } from 'node:util';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer } from '#adapters/index.js';
import { assertAuthorityWitness, modelActivationPolicyRule, ModelActivationStoreError } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
export async function assertConfiguredActivationWitness(operation: string, context: Context, options: ConfigLoadOptions) {
  const markers = [...context.config.cli.agentEnvironment, 'CI'];
  const marked = (env: NodeJS.ProcessEnv) => markers.some(name => {
    const value = env[name];
    return value !== undefined && value !== '' && !/^(?:0|false)$/iu.test(value.trim());
  });
  await assertAuthorityWitness(operation, localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), {
    attest: async () => context.principal.assurance === 'os-user' && !marked(process.env)
      && !marked(options.env ?? process.env) && await attestLocalInteractiveTerminal(),
  });
}

export function activationAuthority(root: string, scopeId: string, options: ConfigLoadOptions, initial: Context) {
  const channel = localPrincipalChannel(), peer = localPrincipalPeer();
  let { installationId, projectId } = initial;
  let operation: string | undefined;
  const guards: ((current: Context) => Promise<void>)[] = [];
  const conflict = () => new ModelActivationStoreError('MODEL_ACTIVATION_CATALOG_CONFLICT');
  const check = async (current: Context, publishing = false) => {
    if (localPrincipalChannel() !== channel || localPrincipalPeer() !== peer
      || !isDeepStrictEqual(current.principal, initial.principal)
      || current.config.company.id !== initial.config.company.id || current.config.projectRoot !== initial.config.projectRoot
      || !isDeepStrictEqual(current.layout, initial.layout)
      || (!publishing || installationId !== null) && current.installationId !== installationId
      || (!publishing || projectId !== null) && current.projectId !== projectId) {
      throw conflict();
    }
    for (const guard of guards) await guard(current);
    if (operation) await assertConfiguredActivationWitness(operation, current, options);
  };
  return {
    pin<T>(basis: T, observe: (current: Context) => T | Promise<T>) {
      guards.push(async current => { if (!isDeepStrictEqual(basis, await observe(current))) throw conflict(); });
    },
    async authorize<T extends { ruleId: string }>(decide: (current: Context) => Promise<T>) {
      const decision = await decide(initial);
      const rule = (context: Context, id: string) => modelActivationPolicyRule(context.document, context.principal, id);
      const granted = rule(initial, decision.ruleId);
      guards.push(async current => {
        if (current.document === initial.document) return;
        const fresh = await decide(current).catch(() => { throw conflict(); });
        if (fresh.ruleId !== decision.ruleId || !isDeepStrictEqual(granted, rule(current, fresh.ruleId))) throw conflict();
      });
      return decision;
    },
    async witness(name: string) { await assertConfiguredActivationWitness(name, initial, options); operation = name; },
    async write() {
      await check(await loadConfiguredScopeContext(root, scopeId, options, 'read'));
      const context = await loadConfiguredScopeContext(root, scopeId, options, 'write');
      await check(context, true);
      ({ installationId, projectId } = context);
      return context;
    },
  };
}
export type ActivationAuthority = ReturnType<typeof activationAuthority>;
