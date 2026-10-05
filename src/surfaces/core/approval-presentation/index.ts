export { projectApprovalDecisionText, approvalSummarySpans, approvalTemplateSpans } from './internal/text.js';
export { DecisionCard, type DecisionCardProps } from './internal/card.js';
export { ApprovalProjectedNotice, ApprovalProjectedPicker, approvalTemplateLine, assembleApprovalCard } from './internal/view.js';
export type { ApprovalDecisionProjection, ApprovalDecisionLabels, ApprovalDecisionLine, ApprovalCardParts } from './internal/types.js';
export { standingAnswerNotice, clearStandingNotice } from './internal/standing-notice.js';
export { APPROVAL_SCAN_MAX_PAGES, isPendingApproval, scanPendingApprovals } from './internal/approval-list.js';
export type { WorklineApproval, WorklineApprovalPage, ListApprovalPage } from './internal/approval-list.js';
