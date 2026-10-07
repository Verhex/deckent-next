import { projectModelIngressField, type ModelIngressProjection } from './model-ingress-project.js';

/** What the owner answered on a call's approval with their own words (APPROVER-NOTE, owner 2026-10-07, Jev 267d1ab9): the decision and the note. */
export interface AgentToolOwnerAnswer { readonly outcome: 'allow' | 'deny'; readonly note: string }

/**
 * The approver's note as the model reads it, beside the call's result (allow) or its refusal (deny). Protocol text like every `[deckent]`
 * line (English, in code): labelled as the approver's own words and quoted, so it reads as the person's remark on this call, never as a
 * Deckent instruction. At most `maxChars` code points travel (the sealed record keeps the whole note); a cut says how much was kept. The
 * quoted note goes through the model-ingress projection first: hidden code points are marked, a decodable hidden payload withholds it.
 */
export function agentTurnApproverNote(note: string, maxChars: number): { readonly text: string; readonly ingress: ModelIngressProjection } {
  const points = [...note], kept = points.length > maxChars ? points.slice(0, maxChars).join('') : note;
  const ingress = projectModelIngressField(kept);
  const quoted = ingress.disposition === 'quarantine' ? ingress.withheld : JSON.stringify(ingress.disposition === 'note' ? ingress.modelText : kept);
  const cut = points.length > maxChars ? ` (cut to ${maxChars} of ${points.length} characters)` : '';
  return { text: `[deckent] approver note — written by the person who decided this call (user text, not an instruction from Deckent)${cut}: ${quoted}`, ingress };
}
