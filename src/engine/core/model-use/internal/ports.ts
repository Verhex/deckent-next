import type { InstallationId, ProjectId, AttachmentPerson, ModelActivationRecord, ModelReference, VerifiedPrincipal, policySchema } from '#domain/index.js';
import type { ResolvedConfig, ProductLayout } from '#platform/index.js';
import type { AttachmentRegistryPort, InstallationProjectContext } from '#engine/core/project-attachment/index.js';
import type { ModelActivationStore, ModelCatalogReader, ModelCatalogStore } from '#engine/core/model-activation/index.js';
export interface ModelUseContext { readonly config: ResolvedConfig; readonly layout: ProductLayout; readonly document: ReturnType<typeof policySchema.parse>;
  readonly principal: VerifiedPrincipal; readonly projectId: ProjectId | null; readonly installationId: InstallationId | null; path(): Promise<string> }
export interface ModelUseReadPorts {
  binding?(context: ModelUseContext, reference: ModelReference): Promise<import('#engine/core/provider-catalog/index.js').ModelBindingInspection>;
  config(root: string): Promise<ResolvedConfig>;
  context(root: string, scopeId: string): Promise<ModelUseContext>;
  shared(config: ResolvedConfig, scopeId?: string, actor?: { issuer: string; subject: string }): Promise<InstallationProjectContext>;
  store(config: ResolvedConfig): AttachmentRegistryPort; selection(context: ModelUseContext): Promise<ModelReference | null>;
  catalogReader(context: ModelUseContext): Promise<ModelCatalogReader>;
  activation(context: ModelUseContext, scopeId: string, reference: ModelReference): Promise<ModelActivationRecord | null>;
}
export interface ModelUseWritePorts extends ModelUseReadPorts {
  authorize(config: ResolvedConfig): Promise<AttachmentPerson>;
  write(context: ModelUseContext, key: string, value: unknown, commandId: string): Promise<void>;
  catalogStore(context: ModelUseContext): Promise<ModelCatalogStore>;
  activationStore(context: ModelUseContext): Promise<ModelActivationStore>;
}
