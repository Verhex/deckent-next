import { describe, expect, it } from 'vitest';
import { createGlobMatcher, DEFAULT_WORKSPACE_READ_DENY } from '#adapters/core/workspace-read/index.js';

// SANDBOX-SPEED: the matcher answers the shapes of the deny list without its dynamic program. It must answer exactly as the glob
// semantics say — checked against an independent oracle (a regular expression built from the documented meaning), not against itself.
function oracle(pattern: string): (path: string) => boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') { if (pattern[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i += 1; } }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  const regex = new RegExp(`^${source}$`, 'su');
  return path => regex.test(path);
}

const EXTRA = ['**/x?', 'a/**/b', '*', '**', '**/', '**/*', 'a*', '?x', 'a/*', '**/a/**', '**/*.p*m', '.env*', 'src/**/*.ts', 'x/y', '**/.git', 'a**', '**/**'];
const PATTERNS = [...new Set([...DEFAULT_WORKSPACE_READ_DENY, ...EXTRA])];
const PARTS = ['a', 'b', '.env', '.env.local', 'x', 'y', '.git', 'id_rsa', 'id_rsa.pub', 'k.pem', 'k.key', '.brain', 'memory.db', 'memory.db-wal', 'credentials', '.deckent', 'host', 'src', 'f.ts', ''];
function paths(): string[] {
  let seed = 20260928; const next = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const out = new Set<string>(['', '/', '.env', 'a/.env', '.git', '.git/', '.git/x', 'a/.git/x/', '.brain/memory.db', '.brain/memory.db-wal', '.brain/memory.db/x', '.deckent/host', '.deckent/host/']);
  for (let i = 0; i < 6000; i++) { const depth = 1 + next(4); out.add(Array.from({ length: depth }, () => PARTS[next(PARTS.length)]!).join('/') + (next(6) === 0 ? '/' : '')); }
  return [...out];
}

describe('glob matcher fast paths equal the documented glob meaning', () => {
  const samples = paths();
  it.each(PATTERNS)('pattern %j agrees with the oracle on every sampled path', pattern => {
    const actual = createGlobMatcher(pattern), expected = oracle(pattern);
    const disagreements = samples.filter(path => actual(path) !== expected(path));
    expect(disagreements.slice(0, 5)).toEqual([]);
  });
  it('the default deny list still denies what it protects and lets ordinary source through', () => {
    const denied = (path: string) => DEFAULT_WORKSPACE_READ_DENY.some(pattern => createGlobMatcher(pattern)(path));
    for (const path of ['.env', 'pkg/.env.local', 'a/b/k.pem', '.git', '.git/config', 'sub/.git', '.brain/memory.db-wal', '.deckent/host/x', 'a/id_ed25519.pub', 'x/.npmrc']) expect(denied(path)).toBe(true);
    for (const path of ['src/a.ts', 'README.md', 'environment.ts', '.gitignore', 'a/.environment', 'docs/keys.md']) expect(denied(path)).toBe(false);
  });
});
