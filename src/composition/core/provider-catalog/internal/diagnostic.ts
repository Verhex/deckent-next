import { appendRuntimeProviderDiagnostic, type ProviderDiscoveryCause } from '#adapters/index.js';
import { prepareProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
/** Failed metadata reads may occur in the terminal process; use the service's existing log rather than a second store. */
export async function recordConfiguredProviderFailure(root: string, op: 'model-discovery' | 'workspace-discovery' | 'provider-probe',
  failure: Readonly<{ code: string; cause: ProviderDiscoveryCause; status?: number | null | undefined }>, options: ConfigLoadOptions = {}) {
  try {
    const config = await loadComposedConfig(root, { ...options, heal: false });
    await appendRuntimeProviderDiagnostic(await prepareProductFile(config.productLayout, 'runtimeLog'), { op, code: failure.code,
      cause: failure.cause, status: failure.status ?? null });
  } catch { /* Diagnostic storage cannot replace the original typed refusal; no raw fallback. */ }
}
