/**
 * The one display form of a network address a request tried (Astra R2, alpha.56.1): `scheme://host[:port]/path` only. Userinfo, query and
 * fragment are never kept (any of them can carry a credential); anything but an absolute http(s) URL has no display form. Used for refusal
 * params, their EN/TR text and the service-log diagnostic alike.
 */
export function displayAddress(text: unknown, base?: string): string | undefined {
  if (typeof text !== 'string') return undefined;
  let url: URL;
  try { url = new URL(text, base); } catch { return undefined; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}${url.pathname}` : undefined;
}
