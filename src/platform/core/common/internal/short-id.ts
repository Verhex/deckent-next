const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The short form of an identity on a primary line: the first 8 characters of a UUID (the form `/resume` shows); anything else is already human-sized. The full value stays in the details. */
export function shortId(value: string): string { return UUID.test(value) ? value.slice(0, 8) : value; }
