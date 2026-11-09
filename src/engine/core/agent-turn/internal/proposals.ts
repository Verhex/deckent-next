import { asPolicy, AI_PROPOSAL_REGISTRY, aiSettingResourceIds, evaluatePolicy, isAiSettingKey, type AgentToolSpec, type AiSettingKey, type VerifiedPrincipal } from '#domain/index.js';
import { projectModelIngressField } from './model-ingress-project.js';

/**
 * alpha.64 B + C (owner S4/S5 2026-11-09): the chat AI's three proposal tools. The model only proposes: `propose_work` opens the same plan card
 * as `/do`, `propose_setting` the same before/after card as `/config`, both in every mode (the v20 rules are `require-approval` with no
 * `modeEligible`), and only the person's yes has an effect. Arguments are checked here, before any configuration or policy read.
 */
const tools = AI_PROPOSAL_REGISTRY.tools;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const PROPOSE_WORK_TOOL_SPEC: AgentToolSpec = Object.freeze({ name: tools.work, version: 1, toolClass: 'read' as const,
  description: 'Propose background work for a request that needs changes (files, tests, several steps). Deckent plans it and shows the person the '
    + 'same plan card as /do; nothing runs without their approval. Do not use it for questions or explanations; ask first when the request is unclear.',
  inputSchema: { type: 'object' as const, additionalProperties: false, required: ['request'], properties: {
    request: { type: 'string', description: 'The work request in the person\'s words, complete enough to plan from.' } } } });
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const LIST_SETTING_CHOICES_TOOL_SPEC: AgentToolSpec = Object.freeze({ name: tools.choices, version: 1, toolClass: 'read' as const,
  description: `List the values a setting can take and its current value. Only these settings can be proposed: ${AI_PROPOSAL_REGISTRY.settingKeys.join(', ')}.`,
  inputSchema: { type: 'object' as const, additionalProperties: false, required: ['keyPath'], properties: {
    keyPath: { type: 'string', enum: [...AI_PROPOSAL_REGISTRY.settingKeys] } } } });
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const PROPOSE_SETTING_TOOL_SPEC: AgentToolSpec = Object.freeze({ name: tools.setting, version: 1, toolClass: 'read' as const,
  description: 'Propose changing one setting to a value from list_setting_choices. The person sees a before/after card and decides; nothing changes '
    + 'without their approval. Models and the Brain model are chosen by the person in /model; every other setting in its own window (/config, /policy, /provider).',
  inputSchema: { type: 'object' as const, additionalProperties: false, required: ['keyPath', 'choice'], properties: {
    keyPath: { type: 'string', enum: [...AI_PROPOSAL_REGISTRY.settingKeys] }, choice: { type: 'string', description: 'One value exactly as list_setting_choices returned it.' },
    layer: { type: 'string', enum: [...AI_PROPOSAL_REGISTRY.layers], description: 'project (default) or global.' } } } });
export const AI_PROPOSAL_TOOL_SPECS: readonly AgentToolSpec[] = Object.freeze([PROPOSE_WORK_TOOL_SPEC, LIST_SETTING_CHOICES_TOOL_SPEC, PROPOSE_SETTING_TOOL_SPEC]);

/** Where a key that is not proposable is set: model references in /model, everything else in /config (the person picks the value). */
const windowOf = (keyPath: string) => /(^|\.)(reference|defaultModel|models?)(\.|$)/u.test(keyPath) || keyPath.startsWith('brain_planner') ? '/model' : '/config';
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type AiProposalArgs = { readonly ok: true; readonly tool: 'work'; readonly request: string }
  | { readonly ok: true; readonly tool: 'choices'; readonly keyPath: AiSettingKey }
  | { readonly ok: true; readonly tool: 'setting'; readonly keyPath: AiSettingKey; readonly choice: unknown; readonly layer: 'project' | 'global' }
  | { readonly ok: false; readonly text: string };
/** Checks one proposal call's arguments (the key list is the registry's; a fourth key is refused naming the person's window). Pure. */
export function planAiProposal(name: string, args: Record<string, unknown>): AiProposalArgs {
  const refuse = (detail: string): AiProposalArgs => ({ ok: false, text: `[deckent] ${name}: ${detail}; nothing was proposed` });
  if (name === tools.work) {
    const request = args['request'];
    if (typeof request !== 'string' || !request.trim() || request.length > 4_096 || Object.keys(args).some(key => key !== 'request')) return refuse('error=invalid-request');
    return projectModelIngressField(request).disposition === 'unchanged' ? { ok: true, tool: 'work', request: request.trim() } : refuse('error=ingress-refused:request');
  }
  const keyPath = args['keyPath'];
  if (typeof keyPath !== 'string') return refuse('error=invalid-key');
  if (!isAiSettingKey(keyPath)) return refuse(`error=key-not-proposable: only ${AI_PROPOSAL_REGISTRY.settingKeys.join(', ')} can be proposed; the person sets ${keyPath} in ${windowOf(keyPath)}`);
  if (name === tools.choices) return { ok: true, tool: 'choices', keyPath };
  const layer = args['layer'] ?? 'project';
  if (layer !== 'project' && layer !== 'global' || !('choice' in args) || Object.keys(args).some(key => !['keyPath', 'choice', 'layer'].includes(key))) return refuse('error=invalid-proposal');
  return { ok: true, tool: 'setting', keyPath, choice: args['choice'], layer };
}
/** Whether the AI actor may be offered (and call) one proposal tool on this policy snapshot: while its v20 rule holds (Run create for `propose_work`, a
 * listed setting's write for the other two) and no explicit `agent-tool` deny names the tool (Enterprise closes it). Never the person's grant. Fail closed.
 * The revision is the snapshot's, for the turn's `policy-turn` record (`unknown`: an unreadable policy). */
export function aiProposalToolDecision(policy: unknown, principal: VerifiedPrincipal, scopeId: string, tool: string): { readonly decision: 'allow' | 'deny'; readonly revision: string } {
  try {
    const ask = (action: string, kind: string, id: string) => evaluatePolicy(asPolicy(policy), { principal, scopeId, action, resource: { kind, id } });
    const invoke = ask('invoke', 'agent-tool', tool), decided = (decision: 'allow' | 'deny') => ({ decision, revision: invoke.revision });
    if (invoke.reason === 'DENIED') return decided('deny');
    return decided((tool === tools.work ? ask('create', 'run', 'proposal').decision !== 'deny' : aiSettingResourceIds().some(id => ask('write', 'config', id).decision !== 'deny')) ? 'allow' : 'deny');
  } catch { return { decision: 'deny', revision: 'unknown' }; }
}
