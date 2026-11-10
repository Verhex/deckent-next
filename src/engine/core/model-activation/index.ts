export { ModelActivationStoreError } from './internal/port.js';
export type { ModelActivationAdmission, ModelActivationResult, ModelActivationStore } from './internal/port.js';
export { modelActivationTargetId, parseModelActivationAdmission, verifyModelActivationRecord,
  verifyModelActivationReceipt, sameModelActivationRequest } from './internal/evidence.js';
export { ModelActivationApplication } from './internal/application.js';
export type { ModelActivationAuthorizer, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelActivationInvocationDelivery, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelActivationDeliverySurface,
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelActivationDeliveryTarget } from './internal/application.js';
export { ModelActivationInspectionApplication } from './internal/inspection.js';
export type { ModelActivationInspection, ModelActivationReader } from './internal/inspection.js';
export { ModelCatalogApplication, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelCatalogInspectionApplication, sameModelCatalogRequest, modelCatalogTargetId, planCatalogStateCascade, refuseRetiredModelActivation } from './internal/catalog.js';
export type { ModelCatalogAdmission, ModelCatalogResult, ModelCatalogStore, ModelCatalogReader, ModelCatalogAuthorizer, ModelCatalogInspection, ModelCatalogChannelView } from './internal/catalog.js';
export { admitWorkerModels, inspectAdmissibleWorkerModels, workerRoleKeys, WorkerModelAdmissionError } from './internal/worker-admission.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkerPlanningTemplate } from './internal/worker-admission.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkerModelAdmissionCode, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkerModelAdmissionDetail, WorkerAdmissionWarning, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkerAdmissionOptions } from './internal/worker-admission.js';
export { ModelConnectApplication, ModelConnectError, workerConnectionModelIds, declareConnectedModel } from './internal/connect.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelConnectBinding, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelConnectDefaults, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelConnectKind, ModelConnectLayer, ModelConnectPorts, ConnectedAdapter } from './internal/connect.js';
export { planProfileCache, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ProfileCacheOffer, type ProfileCachePlan } from './internal/profile-cache.js';
export { planProfileChanges, type ProfileChange, type ProfileChangePlan } from './internal/profile-changes.js';
export { decideRoleModelInScope, inspectRoleModelsInScope, composeModelRolePolicy, roleModelInvocationReference, roleModelPorts, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type RoleModelActivationPorts, type RoleModelSources } from './internal/model-role.js';
export { ModelRoleAdmissionApplication, isOwnedRoleOverlay, catalogRoleFacts, modelRoleCoverage, planModelRoleAssignment, modelRoleQuerySchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelRoleAssignCommandSchema } from './internal/model-role-admission.js';
export type { ModelRoleAdmissionPorts, ModelRoleAssignCommand, ModelRoleAssignResult, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelRoleCatalogFacts, ModelRoleEntry, ModelRoleInspection, ModelRoleQuery,
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelRoleRow } from './internal/model-role-admission.js';
