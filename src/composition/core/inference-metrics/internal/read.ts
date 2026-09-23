import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { InferenceServingError, loopbackMetricsUrl, selectInferenceProfile } from '#engine/index.js';
import { readInferenceMetrics, InferenceMetricsError, type InferenceMetricsBody, type InferenceMetricsReadInput } from '#adapters/index.js';

export type InferenceMetricsReading =
  | { readonly ok: true; readonly url: string; readonly body: string }
  | { readonly ok: false; readonly code: string; readonly url: string | null };

export type InferenceMetricsReader = (input: InferenceMetricsReadInput) => Promise<InferenceMetricsBody>;

/** Reads configured loopback metrics. The surface supplies no socket; limits are the profile's metrics object. */
export async function readConfiguredInferenceMetrics(projectRoot: string, input: { readonly profileId?: string } = {},
  options: ConfigLoadOptions = {}, reader: InferenceMetricsReader = readInferenceMetrics): Promise<InferenceMetricsReading> {
  const config = await loadConfig(projectRoot, options);
  let profile;
  try {
    profile = input.profileId === undefined
      ? selectInferenceProfile(config as Record<string, unknown>)
      : selectInferenceProfile(config as Record<string, unknown>, input.profileId);
  } catch (error) {
    if (error instanceof InferenceServingError) return { ok: false, code: error.code, url: null };
    throw error;
  }
  if (!profile) return { ok: false, code: 'INFERENCE_NOT_CONFIGURED', url: null };
  if (!profile.metrics) return { ok: false, code: 'INFERENCE_METRICS_LIMITS_MISSING', url: null };
  const endpoint = loopbackMetricsUrl(profile.serving.openaiBaseUrl);
  if (!endpoint.ok) return { ok: false, code: endpoint.code, url: null };
  try {
    const read = await reader({ url: endpoint.url, timeoutMs: profile.metrics.timeoutMs, responseMaxBytes: profile.metrics.responseMaxBytes });
    return { ok: true, url: endpoint.url, body: read.body };
  } catch (error) {
    return { ok: false, code: error instanceof InferenceMetricsError ? error.code : 'INFERENCE_METRICS_UNAVAILABLE', url: endpoint.url };
  }
}
