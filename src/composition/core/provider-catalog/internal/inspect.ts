import { loadComposedConfig } from '#composition/core/root/index.js';
import { DeclaredModelsApplication, type DeclaredModelsInspection } from '#engine/index.js';
import { type ConfigLoadOptions } from '#platform/index.js';

/** Local config inspection shares the OS user's file access; it grants no execution authority. */
export async function inspectDeclaredModels(projectRoot: string, options: ConfigLoadOptions = {}): Promise<DeclaredModelsInspection> {
  return new DeclaredModelsApplication({ read: async () => {
    const config = await loadComposedConfig(projectRoot, { ...options, heal: false });
    return config['provider_catalog'];
  } }).inspect();
}
