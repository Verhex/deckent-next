const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, HASH = /^[0-9a-f]{32,}$/iu;

/** The short form of an identity on a primary line: the first 8 characters of a UUID (the form `/resume` shows) or of a generated hex id (a
 * 64-hex Run id, F2-3); anything else is already human-sized and stays whole. The full value stays in the details, commands and `--json`. */
export function shortId(value: string): string { return UUID.test(value) || HASH.test(value) ? value.slice(0, 8) : value; }
