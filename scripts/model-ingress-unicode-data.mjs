// Offline parsers for hash-pinned primary data. These facts do not decide natural-language legitimacy.
const scalar = cp => Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
const order = (a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

export function parseUnicodeRanges(text) {
  const rows = [];
  for (const source of text.split(/\r?\n/)) {
    const line = source.split('#', 1)[0].trim();
    if (!line) continue;
    const match = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*([A-Za-z_0-9]+)\s*$/.exec(line);
    if (!match) throw new Error('MODEL_INGRESS_UCD_RANGE_INVALID');
    const first = parseInt(match[1], 16), last = parseInt(match[2] ?? match[1], 16);
    // Full GC sources intentionally include the surrogate category; extracted scalar facts are checked separately.
    if (first > last || last > 0x10ffff) throw new Error('MODEL_INGRESS_UCD_RANGE_INVALID');
    rows.push([first, last, match[3]]);
  }
  rows.sort(order);
  const ends = new Map();
  for (const [first, last, property] of rows) {
    if (first <= (ends.get(property) ?? -1)) throw new Error('MODEL_INGRESS_UCD_RANGE_OVERLAP');
    ends.set(property, last);
  }
  if (!rows.length) throw new Error('MODEL_INGRESS_UCD_RANGE_EMPTY');
  return rows;
}

export function parseEmojiVariations(text) {
  const rows = [];
  for (const source of text.split(/\r?\n/)) {
    const line = source.split('#', 1)[0].trim();
    if (!line) continue;
    const match = /^([0-9A-F]{4,6}) (FE0E|FE0F)\s*;\s*(?:text|emoji) style;\s*$/.exec(line);
    if (!match) throw new Error('MODEL_INGRESS_VARIATION_INVALID');
    const base = parseInt(match[1], 16);
    if (!scalar(base)) throw new Error('MODEL_INGRESS_VARIATION_INVALID');
    rows.push([base, parseInt(match[2], 16)]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i][0] === rows[i - 1][0] && rows[i][1] === rows[i - 1][1]) throw new Error('MODEL_INGRESS_VARIATION_DUPLICATE');
  }
  if (!rows.length) throw new Error('MODEL_INGRESS_VARIATION_EMPTY');
  return rows;
}

/** UTS35 StringRange: corresponding character ranges form a Cartesian product; shortened end inherits the prefix. */
export function expandCldrStringRange(token) {
  if (!/^[A-Za-z0-9]+(?:~[A-Za-z0-9]+)?$/.test(token)) throw new Error('MODEL_INGRESS_CLDR_RANGE_INVALID');
  if (!token.includes('~')) return [token];
  const [start, suffix] = token.split('~');
  if (suffix.length > start.length) throw new Error('MODEL_INGRESS_CLDR_RANGE_WIDTH');
  const prefix = start.slice(0, start.length - suffix.length), tail = start.slice(prefix.length);
  let expanded = [prefix];
  for (let index = 0; index < suffix.length; index += 1) {
    const first = tail.charCodeAt(index), last = suffix.charCodeAt(index);
    if (first > last) throw new Error('MODEL_INGRESS_CLDR_RANGE_ORDER');
    const next = [];
    for (const item of expanded) for (let cp = first; cp <= last; cp += 1) next.push(item + String.fromCharCode(cp));
    expanded = next;
  }
  return expanded;
}

/** Read only the pinned CLDR validity grammar. Never load its external DTD or resolve entities. */
export function parseCldrValidity(xml, type) {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const result = Object.create(null);
  const statuses = ['regular', 'deprecated', 'macroregion', 'special', 'private_use', 'reserved', 'unknown'];
  for (const match of text.matchAll(/<id\s+([^>]+)>([^<]*)<\/id>/g)) {
    const attrs = [...match[1].matchAll(/([A-Za-z]+)=['"]([^'"]+)['"]/g)];
    const attributes = Object.fromEntries(attrs.map(attr => [attr[1], attr[2]]));
    if (attrs.length !== 2 || attributes.type !== type || !statuses.includes(attributes.idStatus) || Object.hasOwn(result, attributes.idStatus)) {
      throw new Error('MODEL_INGRESS_CLDR_VALIDITY_INVALID');
    }
    const expanded = match[2].trim().split(/\s+/).flatMap(expandCldrStringRange);
    if (new Set(expanded).size !== expanded.length) throw new Error('MODEL_INGRESS_CLDR_VALIDITY_DUPLICATE');
    result[attributes.idStatus] = expanded.sort();
  }
  if (!result.regular || !result.deprecated) throw new Error('MODEL_INGRESS_CLDR_VALIDITY_MISSING');
  return result;
}
