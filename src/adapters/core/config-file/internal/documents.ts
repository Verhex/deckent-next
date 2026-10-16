import { ConfigApplicationError, configFieldView, type ConfigLayer, type ConfigSnapshot, type ConfigDocumentPort } from '#engine/index.js';
import { loadConfig, productResourcePath, resolveProductLayout, resolveGlobalConfigPaths,
  readJsonFile, versionedConfig, withConfigWriteLock, writeJsonAtomic, serializeJsonDocument, type ConfigLoadOptions } from '#platform/index.js';
import { isRecord, digestText } from '#platform/index.js';
import { assertConfigPreimage, backupConfig, pruneConfigBackups, ErrorRegistry } from '#platform/index.js';
/** Filesystem adapter: fixed bootstrap paths, guarded preimages, durable backups and atomic publication. */
export function createConfigFileDocuments(projectRoot: string, options: ConfigLoadOptions = {}): ConfigDocumentPort {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // The loader's fixed bootstrap path is the existing config owner; layout overrides govern other product resources.
  const projectPath = productResourcePath(resolveProductLayout({ projectRoot, platform: platform === 'win32' ? 'win32' : 'posix' }), 'config');
  const globalPath = resolveGlobalConfigPaths(env, platform).platformPath;
  const pathFor = (layer: ConfigLayer) => layer === 'global' ? globalPath : projectPath;
  async function snapshot(layer: ConfigLayer): Promise<ConfigSnapshot> {
    const [globalRead, projectRead, effective] = await Promise.all([
      readJsonFile(globalPath), readJsonFile(projectPath), loadConfig(projectRoot, { ...options, force: true, heal: false }),
    ]);
    for (const read of [globalRead, projectRead]) if (read.kind === 'io' || read.kind === 'corrupt' || read.kind === 'ready' && !isRecord(read.value)) throw new ConfigApplicationError('CONFIG_READ_IO_HOLD');
    const global = globalRead.kind === 'ready' && isRecord(globalRead.value) ? versionedConfig(globalRead.value) : {};
    const project = projectRead.kind === 'ready' && isRecord(projectRead.value) ? versionedConfig(projectRead.value) : {};
    const targetRead = layer === 'global' ? globalRead : projectRead;
    return { document: layer === 'global' ? global : project, global, project, effective,
      digest: targetRead.kind === 'ready' ? targetRead.digest : null, layer, env };
  }
  return { snapshot, async publish(input, planner) {
    const layer = input.layer ?? 'project', path = pathFor(layer);
    const waitingPolicy = (await snapshot(layer)).effective.configFile;
    return withConfigWriteLock(path, async () => {
      const before = await snapshot(layer), plan = await planner(before);
      await assertConfigPreimage(path, before.digest);
      const current = await readJsonFile(path);
      if (current.kind === 'io' || current.kind === 'corrupt') throw new ConfigApplicationError('CONFIG_READ_IO_HOLD');
      const backupPath = current.kind === 'ready' ? await backupConfig(path, current.text) : null;
      await assertConfigPreimage(path, before.digest);
      await writeJsonAtomic(path, plan.document);
      if (backupPath !== null) {
        try { await pruneConfigBackups(path, before.effective.configFile.backupKeep, backupPath); }
        catch (cause) { throw ErrorRegistry.createError('CONFIG_BACKUP_PRUNE_FAILED', { cause }); }
      }
      const after = { ...before, document: plan.document, ...(layer === 'project' ? { project: plan.document } : { global: plan.document }) };
      return { keyPath: input.keyPath, layer, beforeDigest: before.digest, afterDigest: digestText(serializeJsonDocument(plan.document)), backupPath,
        overridden: configFieldView(after, input.keyPath).source === 'env' || layer === 'global' && configFieldView(after, input.keyPath).source === 'project' };
    }, waitingPolicy.writeLockTimeoutMs);
  } };
}
