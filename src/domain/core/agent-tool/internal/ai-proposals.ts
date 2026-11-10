import limits from './proposal-limits.json' with { type: 'json' };
/**
 * alpha.64 B + C (owner S4/S5/S6, 2026-11-09): the chat AI's proposal tools and the only settings it may propose, as versioned registry data
 * (Kanun 6: one source for the template's v20 rules, the tools and their refusals). The AI proposes; a person's card decides in every mode.
 * A lane may only narrow `settingKeys`; widening it is the owner's decision. Model and Brain choices stay in /model, every other key in its window.
 */
export const AI_PROPOSAL_REGISTRY = Object.freeze({ version: 1, maxCardRounds: limits.maxCardRounds,
  tools: Object.freeze({ work: 'propose_work', setting: 'propose_setting', choices: 'list_setting_choices' } as const),
  settingKeys: Object.freeze(['language', 'output_mode', 'terminal.responseStyle'] as const),
  layers: Object.freeze(['project', 'global'] as const) });
export type AiSettingKey = typeof AI_PROPOSAL_REGISTRY.settingKeys[number];
export const isAiSettingKey = (keyPath: unknown): keyPath is AiSettingKey => (AI_PROPOSAL_REGISTRY.settingKeys as readonly unknown[]).includes(keyPath);
/** The `config` resource ids (`<layer>:<key>`, as `evaluateConfigWrite` names a write) the v20 setting rule covers. */
export const aiSettingResourceIds = (): readonly string[] => AI_PROPOSAL_REGISTRY.layers.flatMap(layer => AI_PROPOSAL_REGISTRY.settingKeys.map(key => `${layer}:${key}`));
