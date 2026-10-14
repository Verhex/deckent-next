import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentWorkspaceDeny, createGlobMatcher, CREDENTIAL_WORKSPACE_DENY, DEFAULT_WORKSPACE_READ_DENY, scanWorkerTree, WORKER_TREE_DENY, WORKER_TREE_PATTERN_RULES } from '#adapters/index.js';
import { REDACTION_PATTERNS, resolveProductLayout, snapshotKnownSecrets } from '#platform/index.js';

// S6 (owner 2026-10-14): the pre-dispatch secret gate over the tree a worker receives. Risky inputs stay in the tests; values are built at
// run time so this file is not itself a credential carrier.
const roots: string[] = [], exec = promisify(execFile);
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const PROVIDER_TOKEN = ['sk', 'ant', 'api03', 'Zx9'.repeat(12)].join('-');
const options = { allowPatternPaths: [] as string[], acknowledgedDenyPaths: [] as string[], maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 24, timeoutMs: 60_000 };
async function tree(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'dn-worker-tree-gate-')); roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}

describe('one deny list and one pattern table', () => {
  it('drives the worker gate with the terminal credential floor itself (same list, not a copy)', () => {
    expect(WORKER_TREE_DENY).toBe(CREDENTIAL_WORKSPACE_DENY);
    // The terminal's full-access deny view starts with the same list; its default view is the full floor plus repository internals.
    const layout = resolveProductLayout({ projectRoot: '/project' });
    expect(agentWorkspaceDeny('/project', layout, true).slice(0, CREDENTIAL_WORKSPACE_DENY.length)).toEqual(CREDENTIAL_WORKSPACE_DENY);
    expect(DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !CREDENTIAL_WORKSPACE_DENY.includes(pattern))).toEqual(['.git/**', '**/.git/**', '.git', '**/.git']);
    for (const path of ['.env', 'config/.env.production', 'certs/server.pem', 'keys/deploy.key', 'a/id_rsa', '.npmrc', 'home/.aws/credentials']) {
      expect(CREDENTIAL_WORKSPACE_DENY.some(pattern => createGlobMatcher(pattern)(path)), path).toBe(true);
    }
  });
  it('declares a gate decision on every redaction row; the shipped selection is the measured, reviewable one', () => {
    expect(REDACTION_PATTERNS.every(row => typeof row.gate === 'boolean')).toBe(true);
    // key-value is off: it matches ordinary code (`token = identifier`) — 44 non-test source files of this repository (S6 report).
    expect(Object.fromEntries(REDACTION_PATTERNS.map(row => [row.id, row.gate]))).toEqual({ 'provider-token': true, 'bearer-token': true, 'url-userinfo': true, 'key-value': false, jwt: true });
    expect(WORKER_TREE_PATTERN_RULES.map(row => row.id)).toEqual(['provider-token', 'bearer-token', 'url-userinfo', 'jwt']);
  });
});

describe('scanWorkerTree', () => {
  it('passes a clean tree unchanged; the clone metadata is scanned, only its object store (history, owner-deferred) and index are not read', async () => {
    const root = await tree({ 'src/index.ts': 'export const answer = 42;\n', 'README.md': '# project\n', '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/objects/ab/cdef': `${PROVIDER_TOKEN}`, '.git/index': `${PROVIDER_TOKEN}` });
    await expect(scanWorkerTree(root, options)).resolves.toEqual({ status: 'clean' });
    await writeFile(join(root, '.git/config'), `[remote "x"]\n url = https://u:${PROVIDER_TOKEN}@example.invalid\n`);
    await expect(scanWorkerTree(root, options)).resolves.toEqual({ status: 'refused', count: 1, findings: [{ path: '.git/config', rule: 'pattern:provider-token' }] });
  });
  it('refuses deny-listed paths, configured secret values and gated patterns, naming paths and rules but never a value', async () => {
    const known = snapshotKnownSecrets([{ name: 'ERP_PASSWORD', value: 'erp-hunter2-value' }]);
    const root = await tree({ '.env': 'PASSWORD=whatever\n', 'certs/server.pem': '-----BEGIN PRIVATE KEY-----\n', 'src/client.ts': `const key = '${PROVIDER_TOKEN}';\n`,
      'src/erp.ts': 'connect("erp-hunter2-value")\n', 'docs/notes.md': 'token = someIdentifier\n', 'ok.txt': 'fine\n' });
    const scan = await scanWorkerTree(root, options, known);
    expect(scan).toEqual({ status: 'refused', count: 4, findings: [
      { path: '.env', rule: 'deny-path:.env' }, { path: 'certs/server.pem', rule: 'deny-path:**/*.pem' },
      { path: 'src/client.ts', rule: 'pattern:provider-token' }, { path: 'src/erp.ts', rule: 'known-secret' }] });
    expect(JSON.stringify(scan)).not.toContain(PROVIDER_TOKEN); expect(JSON.stringify(scan)).not.toContain('hunter2');
  });
  it('refuses a deny-listed directory without descending and a symlink by its path, never following it', async () => {
    const root = await tree({ 'home/.aws/credentials': 'x', 'src/a.ts': 'ok' });
    await symlink('/etc/passwd', join(root, '.env'));
    const scan = await scanWorkerTree(root, options);
    expect(scan).toEqual({ status: 'refused', count: 2, findings: [{ path: '.env', rule: 'deny-path:.env' }, { path: 'home/.aws', rule: 'deny-path:**/.aws' }] });
  });
  it('lifts only pattern hits under allowPatternPaths; deny paths and configured values stay refused there', async () => {
    const known = snapshotKnownSecrets([{ name: 'ERP_PASSWORD', value: 'erp-hunter2-value' }]);
    const root = await tree({ 'tests/fixtures/token.ts': `export const fake = '${PROVIDER_TOKEN}';\n`, 'tests/deep/nested/jwt.ts': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      'tests/fixtures/server.key': 'x', 'tests/fixtures/erp.ts': 'erp-hunter2-value', 'src/leak.ts': `'${PROVIDER_TOKEN}'` });
    const scan = await scanWorkerTree(root, { ...options, allowPatternPaths: ['tests/**'] }, known);
    expect(scan).toEqual({ status: 'refused', count: 3, findings: [{ path: 'src/leak.ts', rule: 'pattern:provider-token' },
      { path: 'tests/fixtures/erp.ts', rule: 'known-secret' }, { path: 'tests/fixtures/server.key', rule: 'deny-path:**/*.key' }] });
  });
  it('reads an exactly acknowledged deny path like any file: a settings-only .npmrc passes, a token in it is still refused', async () => {
    const clean = await tree({ '.npmrc': 'engine-strict=true\n', 'pkg/.npmrc': 'x' });
    await expect(scanWorkerTree(clean, { ...options, acknowledgedDenyPaths: ['.npmrc'] })).resolves.toEqual({ status: 'refused', count: 1,
      findings: [{ path: 'pkg/.npmrc', rule: 'deny-path:**/.npmrc' }] });
    const leaking = await tree({ '.npmrc': `//registry.npmjs.org/:_authToken=npm_${'A1b2'.repeat(9)}\n` });
    await expect(scanWorkerTree(leaking, { ...options, acknowledgedDenyPaths: ['.npmrc'] })).resolves.toEqual({ status: 'refused', count: 1,
      findings: [{ path: '.npmrc', rule: 'pattern:provider-token' }] });
  });
  it('reads binary and UTF-16 content too: a value hidden behind a NUL byte or in either UTF-16 alignment is refused', async () => {
    const utf16 = Buffer.from(PROVIDER_TOKEN, 'utf16le');
    const root = await tree({ 'assets/logo.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(PROVIDER_TOKEN)]), 'assets/key.pem': Buffer.from([0, 0]),
      'notes/le.txt': utf16, 'notes/be.txt': Buffer.concat([Buffer.from([0]), utf16]), 'notes/plain.bin': Buffer.from([0, 1, 2, 3]) });
    await expect(scanWorkerTree(root, options)).resolves.toEqual({ status: 'refused', count: 4, findings: [{ path: 'assets/key.pem', rule: 'deny-path:**/*.pem' },
      { path: 'assets/logo.bin', rule: 'pattern:provider-token' }, { path: 'notes/be.txt', rule: 'pattern:provider-token' }, { path: 'notes/le.txt', rule: 'pattern:provider-token' }] });
  });
  it('matches deny paths case-insensitively, refuses special files and scans symlink target text', async () => {
    const root = await tree({ 'certs/SERVER.PEM': 'x', '.ENV': 'x', 'ok.txt': 'fine' });
    await symlink(`/run/${PROVIDER_TOKEN}`, join(root, 'link'));
    await exec('mkfifo', [join(root, 'pipe')]);
    await expect(scanWorkerTree(root, options)).resolves.toEqual({ status: 'refused', count: 4, findings: [{ path: '.ENV', rule: 'deny-path:.env' },
      { path: 'certs/SERVER.PEM', rule: 'deny-path:**/*.pem' }, { path: 'link', rule: 'pattern:provider-token' }, { path: 'pipe', rule: 'unscannable:special-file' }] });
  });
  it('rejects (never passes) when an entry cannot be read', async () => {
    const root = await tree({ 'secret.txt': `${PROVIDER_TOKEN}` });
    await chmod(join(root, 'secret.txt'), 0o000);
    await expect(scanWorkerTree(root, options)).rejects.toMatchObject({ code: 'EACCES' });
    await chmod(join(root, 'secret.txt'), 0o600);
  });
  it('names a credential-shaped or configured-value path redacted, not verbatim', async () => {
    const known = snapshotKnownSecrets([{ name: 'ERP_PASSWORD', value: 'erp-hunter2-value' }]);
    const root = await tree({ [`fixtures/${PROVIDER_TOKEN}.txt`]: `${PROVIDER_TOKEN}`, 'dumps/erp-hunter2-value.csv': 'erp-hunter2-value' });
    const scan = await scanWorkerTree(root, options, known);
    expect(scan).toEqual({ status: 'refused', count: 2, findings: [{ path: 'dumps/‹secret:ERP_PASSWORD›.csv', rule: 'known-secret' },
      { path: 'fixtures/[REDACTED].txt', rule: 'pattern:provider-token' }] });
    expect(JSON.stringify(scan)).not.toContain('hunter2'); expect(JSON.stringify(scan)).not.toContain(PROVIDER_TOKEN);
  });
  it('fails closed with the exhausted bound: one huge text file, too many files, total bytes, time', async () => {
    const big = await tree({ 'data/dump.sql': 'x'.repeat(4096), 'a.txt': 'a' });
    await expect(scanWorkerTree(big, { ...options, maxFileBytes: 1024 })).resolves.toEqual({ status: 'incomplete', limit: 'file-bytes', observed: 4096, bound: 1024 });
    await expect(scanWorkerTree(big, { ...options, maxTotalBytes: 2048 })).resolves.toEqual({ status: 'incomplete', limit: 'total-bytes', observed: 4097, bound: 2048 });
    const many = await tree(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f/${index}.txt`, 'x'])));
    await expect(scanWorkerTree(many, { ...options, maxFiles: 10 })).resolves.toMatchObject({ status: 'incomplete', limit: 'files', bound: 10 });
    let clock = 0; const now = () => (clock += 400);
    await expect(scanWorkerTree(many, { ...options, timeoutMs: 1000 }, undefined, now)).resolves.toMatchObject({ status: 'incomplete', limit: 'time', bound: 1000 });
    // A huge binary file is content too: it is bounded like text, never skipped.
    const binary = await tree({ 'model.bin': Buffer.concat([Buffer.from([0]), Buffer.alloc(8192, 1)]) });
    await expect(scanWorkerTree(binary, { ...options, maxFileBytes: 1024 })).resolves.toEqual({ status: 'incomplete', limit: 'file-bytes', observed: 8193, bound: 1024 });
  });
});
