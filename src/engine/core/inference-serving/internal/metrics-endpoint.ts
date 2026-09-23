export type InferenceMetricsEndpoint = Readonly<
  { ok: true; url: string } | { ok: false; code: 'INFERENCE_METRICS_HOST_DENIED' | 'INFERENCE_METRICS_URL_INVALID' }
>;

/** Metrics are a loopback read. Any other host is refused; this function does not open a connection. */
export function loopbackMetricsUrl(openaiBaseUrl: string | null | undefined): InferenceMetricsEndpoint {
  if (!openaiBaseUrl) return { ok: false, code: 'INFERENCE_METRICS_URL_INVALID' };
  let url: URL;
  try { url = new URL(openaiBaseUrl); } catch { return { ok: false, code: 'INFERENCE_METRICS_URL_INVALID' }; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return { ok: false, code: 'INFERENCE_METRICS_HOST_DENIED' };
  const metrics = new URL(url.href);
  metrics.pathname = /\/v1\/?$/.test(metrics.pathname) ? metrics.pathname.replace(/\/v1\/?$/, '/metrics') : '/metrics';
  metrics.search = '';
  metrics.hash = '';
  return { ok: true, url: metrics.toString() };
}
