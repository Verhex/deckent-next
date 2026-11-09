export { deliverySummarySchema, deliveryChangeFactsSchema, deliverySummaryOperationSchema, deliveryModelVerdictSchema, deliveryVerificationPhaseSchema,
  deliveryEvidenceKindSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ deliveryRiskFlagSchema, DELIVERY_SUMMARY_ACTIONS, DELIVERY_SUMMARY_LIMITS, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ DELIVERY_SUMMARY_OPERATIONS, DELIVERY_MODEL_VERDICTS,
  DELIVERY_RISK_FLAGS } from './internal/contract.js';
export type { DeliverySummary, DeliveryChangeFacts, DeliverySummaryOperation, DeliveryRiskFlag } from './internal/contract.js';
export { projectDeliverySummary, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ deliveryRiskDataSchema, DELIVERY_RISK_DATA } from './internal/projector.js';
export type { DeliverySummaryFacts, DeliveryRiskData } from './internal/projector.js';
export { evaluateAutonomy, autonomyFacts, autonomyRuleDigest, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ autonomyRuleDataSchema, AUTONOMY_RULE, AUTONOMY_HOLD_REASONS } from './internal/rule.js';
export type { AutonomyFacts, AutonomyEvaluation, AutonomyHoldReason, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AutonomyRuleData } from './internal/rule.js';
export { DeliverySummaryApplication, deliverySummaryRequestSchema, readSystemDeliverySummary } from './internal/application.js';
export type { DeliverySummaryRequest, DeliverySummaryPorts, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ DeliveryChangeSource, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ SystemDeliverySummaryRequest } from './internal/application.js';
export { autonomyShadowId, autonomyShadowRecordSchema, autonomyShadowRecord, autonomyShadowDigest, deliverySummaryDigest, sameAutonomyShadowTicket } from './internal/shadow.js';
export type { AutonomyShadowRecord, AutonomyShadowStore } from './internal/shadow.js';
