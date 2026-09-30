import type { ModelReference } from '#domain/index.js';
import type { DeclaredModelsInspection, ModelBindingInspection } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { ModelActivationAdmissionHandler, ModelActivationInspectionHandler } from './model-activation.js';
import type { ModelInvocationCancellationHandler, ModelInvocationHandler, ModelInvocationInspectionHandler, ModelInvocationPurgeHandler } from './model-invocation.js';
import type { ProviderSpendAccountInspectionHandler, ProviderSpendAuditHandler } from './model-spending.js';
import type { ModelCatalogApplyHandler, ModelCatalogInspectionHandler } from './model-catalog.js';

export type InferenceMetricsReading =
  | { readonly ok: true; readonly url: string; readonly body: string }
  | { readonly ok: false; readonly code: string; readonly url: string | null };

/** The host operations the model, spending and inference commands use; the CLI's full command context satisfies it. */
export interface ModelCommandContext extends CliBaseContext {
  readInferenceMetrics?: (root: string, input: { readonly profileId?: string }, options: ConfigLoadOptions) => Promise<InferenceMetricsReading>;
  invokeModel?: ModelInvocationHandler;
  inspectModelInvocation?: ModelInvocationInspectionHandler;
  purgeModelInvocationContent?: ModelInvocationPurgeHandler;
  cancelModelInvocation?: ModelInvocationCancellationHandler;
  inspectProviderSpendAccount?: ProviderSpendAccountInspectionHandler;
  auditProviderSpendAccount?: ProviderSpendAuditHandler;
  inspectDeclaredModels?: (root: string, options: ConfigLoadOptions) => Promise<DeclaredModelsInspection>;
  inspectModelBinding?: (root: string, reference: ModelReference, options: ConfigLoadOptions) => Promise<ModelBindingInspection>;
  inspectModelActivation?: ModelActivationInspectionHandler;
  admitModelActivation?: ModelActivationAdmissionHandler;
  inspectModelCatalog?: ModelCatalogInspectionHandler;
  applyModelCatalog?: ModelCatalogApplyHandler;
}
