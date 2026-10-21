import { ErrorRegistry } from '#platform/index.js';
import { SECRET_NAME_PATTERN } from './port.js';
import REGISTRY from './project-vault.json' with { type: 'json' };

/** Where a provider credential name is read from: the installation's main vault (through a grant) or this project's own vault. */
export type SecretVault = 'main' | 'project';
/** What `.deck` says about one name; `undeclared` is a name it does not list (or no `.deck` at all). */
export type DeckDeclaration = SecretVault | 'undeclared';
/** The parsed `.deck`: name → vault. References only; a value can never be expressed (no aliasing, no other right-hand side). */
export type DeckDeclarations = ReadonlyMap<string, SecretVault>;
/** Why a `.deck` was refused as a whole; never its content (a pasted value must not reach an error, a log or an audit record). */
export type DeckInvalidReason = 'too-large' | 'too-many-entries' | 'header' | 'entry' | 'reserved-name' | 'duplicate';

/** `.deck` v1 limits and names, versioned registry data (law 6). */
export const DECK_FILE = Object.freeze({ ...REGISTRY.deck });
const ENTRY = /^([A-Z_][A-Z0-9_]*)=(main|project)$/u;
const invalid = (reason: DeckInvalidReason, line?: number) =>
  ErrorRegistry.createError('DECK_FILE_INVALID', { params: { reason, ...(line === undefined ? {} : { line }) } });

/**
 * PRE-8 v2 (owner 2026-10-21): the project's `.deck` v1, a dotenv-like list of references that may be committed. The first entry is the
 * format header `DECK_FORMAT=1`, every following entry `NAME=main|project` with NAME in the `$DECK:` grammar; empty lines and lines that start
 * with `#` are ignored. Any other line, a duplicate, the reserved header name as an entry, a missing header or a file over the byte or
 * entry bound refuses the whole file (`DECK_FILE_INVALID`, fail closed: nothing resolves from it). The refusal names a reason and a line
 * number only, never the line.
 */
export function parseDeckDeclarations(text: string): DeckDeclarations {
  if (Buffer.byteLength(text, 'utf8') > DECK_FILE.maxBytes) throw invalid('too-large');
  const declarations = new Map<string, SecretVault>();
  let header = false;
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw, number = index + 1;
    if (line === '' || line.startsWith('#')) continue;
    if (!header) {
      if (line !== `${DECK_FILE.formatKey}=${DECK_FILE.format}`) throw invalid('header', number);
      header = true;
      continue;
    }
    const match = ENTRY.exec(line);
    if (!match || !SECRET_NAME_PATTERN.test(match[1]!)) throw invalid('entry', number);
    if (match[1] === DECK_FILE.formatKey) throw invalid('reserved-name', number);
    if (declarations.has(match[1]!)) throw invalid('duplicate', number);
    if (declarations.size >= DECK_FILE.maxEntries) throw invalid('too-many-entries', number);
    declarations.set(match[1]!, match[2] as SecretVault);
  }
  if (!header) throw invalid('header');
  return declarations;
}
/** The declaration of one name; an absent `.deck` (`null`) declares nothing. */
export const deckDeclaration = (declarations: DeckDeclarations | null, name: string): DeckDeclaration => declarations?.get(name) ?? 'undeclared';
