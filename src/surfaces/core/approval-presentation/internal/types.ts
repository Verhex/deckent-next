import type { RedactionMatch } from '#platform/index.js';
import type { Span } from '#surfaces/core/terminal-render/index.js';

/** Completed, display-only decision data; no approval DTO, revision, capability, sidecar or raw getter. */
export type ApprovalDecisionProjection = Readonly<{ spans: readonly Span[]; hiddenCount: number; patternMatches: readonly RedactionMatch[] }>;
export type ApprovalDecisionLabels = Readonly<{ hiddenCount?: string; credentialLikeCount?: string }>;
export type ApprovalDecisionLine = Readonly<{ spans: readonly Span[]; fields: readonly ApprovalDecisionProjection[] }>;
export type ApprovalCardParts = Readonly<{
  subject: ApprovalDecisionLine | null;
  summary: ApprovalDecisionProjection;
  risk: ApprovalDecisionLine;
  preview: ApprovalDecisionProjection | null;
  previewMore: string;
  covers: ApprovalDecisionLine | null;
  expiry: ApprovalDecisionLine;
  assurance: ApprovalDecisionLine | null;
}>;
