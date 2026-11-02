import { composeCore } from '#composition/core/root/index.js';
import { configuredAttachmentStore, inspectConfiguredInstallationSource } from '#composition/core/scoped-request/index.js';
import { localProjectAttachmentPorts, readAttachmentBootstrapConfig } from '#adapters/index.js';
import { ProjectAttachmentApplication } from '#engine/index.js';
import { projectAttachmentCommandSchema } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { applyPolicyTemplateInstallation } from './policy-template.js';
export async function configuredProjectAttachment(root: string, options: ConfigLoadOptions = {}) {
  composeCore(); const config = await readAttachmentBootstrapConfig(root, options), store = configuredAttachmentStore(config, options);
  return new ProjectAttachmentApplication({ store, ...localProjectAttachmentPorts(config, options, store),
    source: (root, scope, actor) => inspectConfiguredInstallationSource(root, scope, actor, options),
    install: (attachment, identity) => applyPolicyTemplateInstallation(root, attachment.scopeId, options, { attachment, identity }) });
}
export async function executeConfiguredProjectAttachment(root: string, input: unknown, options: ConfigLoadOptions = {}) {
  const command = projectAttachmentCommandSchema.parse(input), app = await configuredProjectAttachment(root, options);
  switch (command.action) {
    case 'register-preview': return app.registrationPreview(root, command.scopeId);
    case 'register': return app.register(root, command.scopeId, command.expect);
    case 'preview': return app.preview(command.scopeId);
    case 'apply': return app.apply(command.scopeId, command.expect, command.commandId);
    case 'revoke': return app.revoke(command.projectId);
  }
}
