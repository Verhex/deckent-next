import { isAbsolute, relative, sep } from 'node:path';
import type { AgentToolSpec, AgentTurnMessage } from '#domain/index.js';
import type { ProductLayout } from '#platform/index.js';

/**
 * Version of the model-facing system prompt (TL-C D4; v2 SCR-A: the scratch area; v3 FETCH: network access; v4 TERM-FEEDBACK-1: the running
 * model's identity, and Deckent's own state named as protected instead of pointed at). The text is protocol, like tool descriptions:
 * English, in code, never a catalog string. Any change of its wording is a new version; the turn's request digest binds the rendered text.
 */
export const AGENT_TURN_SYSTEM_PROMPT_VERSION = 4;
/** Allowlisted hosts named in the prompt; past this the prompt gives their count only. */
const NAMED_HOSTS_MAX = 32;

/** A path as the model's tools address it: workspace-relative inside the project, else absolute. */
function shown(projectRoot: string, path: string): { readonly text: string; readonly inside: boolean } {
  const rel = relative(projectRoot, path);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  return { text: inside ? rel.split(sep).join('/') : path, inside };
}

/**
 * The service's instructions for an agent turn: which model runs (its catalog reference), where the model works (project root, Deckent
 * data root, configuration, the conversation's scratch area) and that Deckent's own state is protected, which tools exist by class and
 * that policy and the permission mode decide each call, how bounded results continue, and one progress line between tool rounds.
 * Deterministic for one model, project, layout, scratch area and tool set.
 */
export function renderAgentTurnSystemPrompt(input: { readonly projectRoot: string; readonly layout: ProductLayout; readonly tools: readonly AgentToolSpec[];
  readonly scratch?: { readonly dir: string; readonly retentionDays: number } | null;
  /** FETCH: the declared fetch tool's allowlist and what happens to other hosts; absent or null = no network access (egress none). */
  readonly network?: { readonly allowedHosts: readonly string[]; readonly others: 'ask' | 'refused' } | null;
  /** TERM-FEEDBACK-1: the bound catalog model (provider and model reference, native id) the turn runs on. */
  readonly model: { readonly providerId: string; readonly providerVersion: number; readonly modelId: string; readonly modelVersion: number; readonly nativeId: string } }): string {
  const { projectRoot, layout, tools, scratch, network, model } = input;
  const hosts = network ? (network.allowedHosts.length > NAMED_HOSTS_MAX ? `${network.allowedHosts.length} hosts` : network.allowedHosts.join(', ')) : '';
  const data = shown(projectRoot, layout.root);
  const named = (toolClass: AgentToolSpec['toolClass']) => tools.filter(tool => tool.toolClass === toolClass).map(tool => tool.name).join(', ');
  const classes = [['Read tools', named('read'), ' They change nothing.'], ['Edit tools', named('edit'), ''],
    ['Shell tool', named('shell'), ' It runs in the project root on the user\'s machine.']] as const;
  const lines = [
    `[Deckent runtime instructions v${AGENT_TURN_SYSTEM_PROMPT_VERSION}]`,
    'These instructions come from the Deckent runtime service, not from the user. You are the coding assistant of the Deckent operator'
      + ' terminal and work on the user\'s project.',
    `- Model: you are ${model.nativeId} (Deckent catalog: provider ${model.providerId} v${model.providerVersion}, model ${model.modelId} v${model.modelVersion}),`
      + ' running inside Deckent. When asked who or which model you are, answer with this; do not claim another model or vendor.',
    '', 'Workspace:',
    `- Project root: ${projectRoot}. Tool paths are relative to it; paths outside it are refused.`,
    `- Deckent data root: ${data.text}${data.inside ? '' : ' (outside the project root: the tools cannot read it)'}.`,
    `- Deckent configuration: ${shown(projectRoot, layout.bootstrapConfigPath).text} (readable).`,
    ...(scratch ? [`- Scratch area: ${scratch.dir}. Your own temporary space for this conversation, outside the project: put notes, drafts,`
      + ' intermediate data and diagrams (Mermaid .mmd or SVG source as text) there with scratch_write, and read them with scratch_read and'
      + ` scratch_list (paths relative to it); run_shell gets it as TMPDIR, and shell commands may address it by this absolute path. It never`
      + ` changes the project; an area unused for ${scratch.retentionDays} days is removed.`] : []),
    '- Deckent\'s own state and authority (its ledger, saved conversations and history, logs, the runtime socket, approvals and their previews,'
      + ' audit, policy, runs and workspaces), keys and credential files are protected: the tools and the shell refuse them; do not try to read'
      + ' them another way.',
    network ? `- Network: fetch_url fetches one https:// URL (GET, no credentials). ${hosts ? `Allowlisted hosts (${hosts}) run at once;` : 'No host is allowlisted;'}`
      + ` ${network.others === 'ask' ? 'any other host waits for the operator\'s approval' : 'any other host is refused'}. The body is saved in the scratch area under`
      + ' fetch/ and the result shows its first 16 KiB; read the rest with scratch_read.'
      : '- Network access: none. This installation allows no fetching: do not guess what a web page says, and do not try to reach the network another way.',
  ];
  if (tools.length) {
    lines.push('', 'Tools:', ...classes.flatMap(([label, names, note]) => names ? [`- ${label}: ${names}.${note}`] : []),
      '- Policy and the permission mode decide every call: it runs at once, waits until the operator approves it, or is denied. A result'
        + ' "error=denied-by-policy" or "error=denied-by-owner" is final: do not repeat that call; say what you needed or ask.',
      '- Use only the parameters a tool declares; any other argument is rejected.',
      '- Results are bounded. When a read_file result\'s first line says hasMore=true, continue from its nextStartLine instead of reading'
        + ' from the start again. Narrow a large search with its path or glob.',
      '- A read repeated with the same arguments returns a reference to the earlier result, not new content.');
  }
  lines.push('', 'Working style:',
    ...(tools.length ? ['- Between tool rounds, write one short line to the user: what you found or what you will do next.'] : []),
    '- Base your answer on what you have seen; say what you did not check.');
  return lines.join('\n');
}

/**
 * The messages as sent to the model: one system message, the service's instructions first and the client's own system text after
 * them (a chat template takes one system message, and compaction keeps exactly the first). The client's history never holds it.
 */
export function withAgentTurnSystemPrompt(messages: readonly AgentTurnMessage[], prompt: string): readonly AgentTurnMessage[] {
  const first = messages[0];
  return first?.role === 'system' ? [{ role: 'system', content: `${prompt}\n\n${first.content}` }, ...messages.slice(1)]
    : [{ role: 'system', content: prompt }, ...messages];
}
