import { dirname, resolve } from 'node:path';
import { attachmentFailure } from '#engine/index.js';
import { projectAttachmentSchema } from '#domain/index.js';
import { observeBootstrapState, bootstrapPublishesConfig, loadConfig, validateConfig, versionedConfig, deepMerge, resolveProductLayout,
  productResourcePath, digestText, type ResolvedConfig, type ConfigLoadOptions } from '#platform/index.js';
/** The installer's retained first-session material is the only recovery read override. No files are healed or published here. */
export async function readAttachmentBootstrapConfig(projectRoot: string, options: ConfigLoadOptions): Promise<ResolvedConfig> {
  const root = resolve(projectRoot), observed = await observeBootstrapState(root);
  if (observed.record?.recovery['operation'] === 'project-attachment-relocate.v1') return loadConfig(root, { ...options, heal: false, force: true, pendingBootstrap: 'config-settled' });
  if (!bootstrapPublishesConfig(observed, root)) return loadConfig(root, { ...options, heal: false, force: true });
  const targets = observed.record?.recovery['firstSessionTargets'];
  if (!Array.isArray(targets)) return attachmentFailure('PROJECT_ATTACHMENT_INCOMPLETE');
  const ref = targets.find((target: { resource?: string } | null) => target?.resource === 'projectAttachment') as { content?: unknown; path?: unknown; digest?: unknown } | undefined;
  const cfg = targets.find((target: { resource?: string } | null) => target?.resource === 'config') as { content?: unknown; path?: unknown; digest?: unknown } | undefined;
  if (typeof ref?.content !== 'string' || typeof cfg?.content !== 'string') return attachmentFailure('PROJECT_ATTACHMENT_INCOMPLETE');
  if ([ref, cfg].some(target => target.digest !== digestText(String(target.content)) || !observed.record!.resources.some(resource => resource.path === target.path && resource.targetDigest === target.digest))) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  let attachment, document, authored;
  try { attachment = projectAttachmentSchema.parse(JSON.parse(ref.content)); authored = versionedConfig(JSON.parse(cfg.content)); document = validateConfig(authored).config; }
  catch { return attachmentFailure('PROJECT_ATTACHMENT_INVALID'); }
  if (attachment.location.canonicalRoot !== root || ![5, 6].includes(document.schema_version) || document.installation.sharedRegistrationId !== attachment.registrationId
    || document.company.id !== attachment.companyId) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  const global = await loadConfig(root, { ...options, heal: false, globalOnly: true, force: true });
  const { projectRoot: ignoredRoot, productLayout: ignoredLayout, secretPaths: ignoredPaths, ...values } = global;
  void ignoredRoot; void ignoredLayout; void ignoredPaths;
  const config = validateConfig(deepMerge(values, authored)).config;
  const layout = resolveProductLayout({ projectRoot: root, ...(config.layout.root ? { root: config.layout.root } : {}), resources: config.layout.resources });
  if (cfg.path !== productResourcePath(layout, 'config') || ref.path !== productResourcePath(layout, 'projectAttachment')
    || dirname(String(cfg.path)) === global.productLayout.root) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  return { ...config, projectRoot: root, productLayout: layout, secretPaths: global.secretPaths };
}
