import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentWorkspaceDeny, createGlobMatcher, workerTreeViews, CREDENTIAL_WORKSPACE_DENY, DEFAULT_WORKSPACE_READ_DENY, scanWorkerTree, WORKER_TREE_DENY, WORKER_TREE_PATTERN_RULES } from '#adapters/index.js';
import { REDACTION_CONFIG_SECRET, REDACTION_PATTERNS, resolveProductLayout, snapshotKnownSecrets } from '#platform/index.js';

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
    expect(WORKER_TREE_PATTERN_RULES.map(row => row.id)).toEqual(['provider-token', 'bearer-token', 'url-userinfo', 'jwt', 'private-key-block', 'gitlab-token',
      'aws-temporary-key', 'aws-secret-key', 'stripe-key', 'slack-token', 'pypi-token', 'azure-account-key']);
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
      { path: 'tests/fixtures/erp.ts', rule: 'known-secret' }, { path: 'tests/fixtures/server.key', rule: 'deny-path:**/*.key' }],
      // Every lifted hit is returned with the exact entry that lifted it (audited and shown on the Run card by the engine).
      excluded: [{ path: 'tests/deep/nested/jwt.ts', rule: 'pattern:jwt', by: 'allowPatternPaths:tests/**' },
        { path: 'tests/fixtures/token.ts', rule: 'pattern:provider-token', by: 'allowPatternPaths:tests/**' }] });
  });
  it('reads an exactly acknowledged deny path like any file: a settings-only .npmrc passes, a token in it is still refused', async () => {
    const clean = await tree({ '.npmrc': 'engine-strict=true\n', 'pkg/.npmrc': 'x' });
    await expect(scanWorkerTree(clean, { ...options, acknowledgedDenyPaths: ['.npmrc'] })).resolves.toEqual({ status: 'refused', count: 1,
      findings: [{ path: 'pkg/.npmrc', rule: 'deny-path:**/.npmrc' }], excluded: [{ path: '.npmrc', rule: 'deny-path:**/.npmrc', by: 'acknowledgedDenyPaths:.npmrc' }] });
    const leaking = await tree({ '.npmrc': `//registry.npmjs.org/:_authToken=npm_${'A1b2'.repeat(9)}\n` });
    await expect(scanWorkerTree(leaking, { ...options, acknowledgedDenyPaths: ['.npmrc'] })).resolves.toEqual({ status: 'refused', count: 1,
      findings: [{ path: '.npmrc', rule: 'pattern:provider-token' }], excluded: [{ path: '.npmrc', rule: 'deny-path:**/.npmrc', by: 'acknowledgedDenyPaths:.npmrc' }] });
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
    // A filesystem FIFO exists only on POSIX; native Windows still covers case-insensitive deny paths and symlink target text.
    const fifo = process.platform !== 'win32';
    if (fifo) await exec('mkfifo', [join(root, 'pipe')]);
    const findings = [{ path: '.ENV', rule: 'deny-path:.env' }, { path: 'certs/SERVER.PEM', rule: 'deny-path:**/*.pem' }, { path: 'link', rule: 'pattern:provider-token' },
      ...(fifo ? [{ path: 'pipe', rule: 'unscannable:special-file' }] : [])];
    await expect(scanWorkerTree(root, options)).resolves.toEqual({ status: 'refused', count: findings.length, findings });
  });
  it('scans every view the worker receives: profile binds, mounted inputs, handoff files and the prompt dependency context', async () => {
    const known = snapshotKnownSecrets([{ name: 'ERP_PASSWORD', value: 'erp-hunter2-value' }]);
    const workspace = await tree({ 'src/a.ts': 'ok' }), bind = await tree({ '.env': 'x', 'docs/readme.md': 'fine' }), files = await tree({ report: `${PROVIDER_TOKEN}`, note: 'fine' });
    const views = workerTreeViews(workspace, [{ source: bind, target: '/deckent/mounts/shared' }], { inputs: [{ name: 'report', path: join(files, 'report') }],
      handoffInputs: [{ target: '/deckent/inputs/_shared.json', path: join(files, 'note') }], dependencyContext: { text: 'use erp-hunter2-value to log in' } });
    expect(views.map(view => view.label)).toEqual(['', '/deckent/mounts/shared', '/deckent/inputs/report', '/deckent/inputs/_shared.json', 'prompt:dependency-context']);
    const scan = await scanWorkerTree(views, options, known);
    expect(scan).toEqual({ status: 'refused', count: 3, findings: [{ path: 'deckent/mounts/shared/.env', rule: 'deny-path:.env' },
      { path: 'deckent/inputs/report', rule: 'pattern:provider-token' }, { path: 'prompt:dependency-context', rule: 'known-secret' }] });
    expect(JSON.stringify(scan)).not.toContain('hunter2');
    await expect(scanWorkerTree(workerTreeViews(workspace, undefined, { inputs: [], handoffInputs: [] }), options, known)).resolves.toEqual({ status: 'clean' });
  });
  it.skipIf(process.platform === 'win32')('[requires POSIX file modes] rejects (never passes) when an entry cannot be read', async () => {
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

describe('deny anchoring matches the terminal floor in every position a path can appear', () => {
  const refusedPaths = async (views: Parameters<typeof scanWorkerTree>[0]) => {
    const scan = await scanWorkerTree(views, options);
    return scan.status === 'refused' ? scan.findings.map(finding => `${finding.path} ${finding.rule}`) : [scan.status];
  };
  it('nested occurrences, case and directory entries in the checkout', async () => {
    const root = await tree({ 'sub/dir/.env': 'x', 'a/b/key.pem': 'x', 'pkg/.NpmRc': 'x', 'home/.aws/config': 'x', 'ok.ts': 'ok' });
    expect(await refusedPaths(root)).toEqual(['a/b/key.pem deny-path:**/*.pem', 'home/.aws deny-path:**/.aws', 'pkg/.NpmRc deny-path:**/.npmrc', 'sub/dir/.env deny-path:**/.env']);
  });
  it('unicode forms: an NFD directory name and a compatibility (fullwidth) file name', async () => {
    const root = await tree({ ['cafe\u0301/.env']: 'x', 'cfg/\uff53\uff45\uff43\uff52\uff45\uff54\uff53.json': 'x' });
    expect(await refusedPaths(root)).toEqual(['cafe\u0301/.env deny-path:**/.env', 'cfg/\uff53\uff45\uff43\uff52\uff45\uff54\uff53.json deny-path:**/secrets.json']);
  });
  it('.git metadata is held to the same rules', async () => {
    const root = await tree({ '.git/credentials': 'x', '.git/config': '[core]\n' });
    expect(await refusedPaths(root)).toEqual(['.git/credentials deny-path:**/credentials']);
  });
  it('a bind is anchored at its own root like a checkout (root-anchored rules), and labels are normalized', async () => {
    const workspace = await tree({ 'ok.ts': 'ok' }), bind = await tree({ '.deckent/host/token.txt': 'x', 'docs/a.md': 'ok' });
    const views = workerTreeViews(workspace, [{ source: bind, target: './deckent/mounts/shared/' }], { inputs: [], handoffInputs: [] });
    expect(await refusedPaths(views)).toEqual(['deckent/mounts/shared/.deckent/host/token.txt deny-path:.deckent/host/**']);
  });
  it('a single mounted input is matched by its container path and its basename', async () => {
    const workspace = await tree({ 'ok.ts': 'ok' }), files = await tree({ blob: 'x', key: 'x' });
    const views = workerTreeViews(workspace, undefined, { inputs: [{ name: '.env', path: join(files, 'blob') }, { name: 'server.pem', path: join(files, 'key') }], handoffInputs: [] });
    expect(await refusedPaths(views)).toEqual(['deckent/inputs/.env deny-path:.env', 'deckent/inputs/server.pem deny-path:**/*.pem']);
  });
  it('a symlink whose target path is deny-listed is refused, relative or absolute, and is never followed', async () => {
    const root = await tree({ 'docs/readme.md': 'ok' });
    await symlink('../.env', join(root, 'docs/settings')); await symlink('/home/someone/.aws/credentials', join(root, 'creds'));
    expect(await refusedPaths(root)).toEqual(['creds deny-path:**/.aws/**', 'docs/settings deny-path:.env']);
  });
  it('the worker argv and an oversized prompt context are views too; a size bound never passes a partial view', async () => {
    const workspace = await tree({ 'ok.ts': 'ok' });
    expect(await refusedPaths(workerTreeViews(workspace, undefined, { inputs: [], handoffInputs: [] }, ['node', 'task.js', `--key=${PROVIDER_TOKEN}`])))
      .toEqual(['argv pattern:provider-token']);
    await expect(scanWorkerTree(workerTreeViews(workspace, undefined, { inputs: [], handoffInputs: [], dependencyContext: { text: 'x'.repeat(2048) } }), { ...options, maxFileBytes: 1024 }))
      .resolves.toEqual({ status: 'incomplete', limit: 'file-bytes', observed: 2048, bound: 1024 });
  });
});

describe('config-secret: the key-value vocabulary narrowed to config-like files and non-placeholder values', () => {
  const PASSWORD = ['Tr0ub4dor', '3xQz9'].join('&');
  const scanOf = async (files: Record<string, string | Buffer>) => {
    const scan = await scanWorkerTree(await tree(files), options);
    return scan.status === 'refused' ? scan.findings.map(finding => `${finding.path} ${finding.rule}`) : [scan.status];
  };
  it('refuses a real-looking value in a customer config; a placeholder passes; source code with `password` is out of scope', async () => {
    expect(await scanOf({ 'config/database.yml': `production:\n  password: ${PASSWORD}\n`, 'appsettings.json': `{ "ConnectionStrings": { "Db": "Server=db;User Id=sa;Password=${PASSWORD};" } }`,
      'docker-compose.yml': `services:\n  db:\n    environment:\n      - POSTGRES_PASSWORD=${PASSWORD}\n`, 'web.config': `<add key="ApiKey" value="x"/>\n<apiKey>${PASSWORD}</apiKey>\n`,
      'settings.ini': `[db]\nDB_PASSWORD = "${PASSWORD}"\n` })).toEqual(['appsettings.json pattern:config-secret', 'config/database.yml pattern:config-secret',
      'docker-compose.yml pattern:config-secret', 'settings.ini pattern:config-secret', 'web.config pattern:config-secret']);
    expect(await scanOf({ 'config/a.yml': 'password: ${DB_PASSWORD}\ntoken: <your-token>\napi_key: changeme\nsecret: ""\n', 'b.json': '{ "password": "{{ vault_pw }}", "apiKey": "%API_KEY%", "token": "xxxxxxxx", "secret": null }',
      'c.properties': 'db.password=$DB_PASS\nauth.token=***\n', 'd.toml': 'token_ttl = 3600\npassword = "short"\n' })).toEqual(['clean']);
    expect(await scanOf({ 'src/login.ts': `const password = await prompt();\nconst token = createToken('${PASSWORD}');\n`, 'README.md': `password: ${PASSWORD}\n` })).toEqual(['clean']);
  });
  it('reads keys and values the way config parsers do: escapes, YAML block scalars, CRLF, BOM, UTF-16/32', async () => {
    const utf32 = Buffer.alloc(Buffer.byteLength(`password=${PASSWORD}`) * 4); [...`password=${PASSWORD}`].forEach((char, index) => utf32.writeUInt32LE(char.charCodeAt(0), index * 4));
    expect(await scanOf({ 'escaped.json': `{ "pass\\u0077ord": "${PASSWORD}" }`, 'block.yml': `db:\n  password: |\n    ${PASSWORD}\n`, 'crlf.env.json': `{\r\n"secret":\r\n"${PASSWORD}"\r\n}`,
      'bom.ini': `\uFEFFpassword=${PASSWORD}\n`, 'wide.properties': Buffer.from(`password=${PASSWORD}`, 'utf16le'), 'wider.conf': utf32,
      'empty-block.yaml': 'password: >-\n' })).toEqual(['block.yml pattern:config-secret', 'bom.ini pattern:config-secret', 'crlf.env.json pattern:config-secret',
      'empty-block.yaml pattern:config-secret', 'escaped.json pattern:config-secret', 'wide.properties pattern:config-secret', 'wider.conf pattern:config-secret']);
    expect(await scanOf({ 'block.yml': 'password: |\n  ${DB_PASSWORD}\n' })).toEqual(['clean']);
  });
  it('a GitHub Actions expression is a reference resolved at run time, not a literal; a quoted literal inside one is still a value', async () => {
    // Live /do 2026-10-16: `GITHUB_TOKEN: ${{ github.token }}` in .github/workflows refused every worker tree of this repository.
    expect(await scanOf({ '.github/workflows/ci.yml': 'env:\n  GITHUB_TOKEN: ${{ github.token }}\n  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n' })).toEqual(['clean']);
    expect(await scanOf({ '.github/workflows/ci.yml': `env:\n  API_TOKEN: \${{ '${PASSWORD}' }}\n` })).toEqual(['.github/workflows/ci.yml pattern:config-secret']);
    // The expression is a placeholder only as the whole scalar (Astra 2584): a literal glued after it, or a second expression, is still a value.
    expect(await scanOf({ 'a.yml': `API_TOKEN: \${{ secrets.PREFIX }}${PASSWORD}\n`, 'b.yml': 'API_TOKEN: ${{ secrets.A }}${{ secrets.B }}\n',
      'c.yml': 'GITHUB_TOKEN: ${{ github.token }} # comment\nTOKEN: "${{ secrets.T }}"\nNPM_TOKEN: ${{ secrets.NPM }}\n' })).toEqual(['a.yml pattern:config-secret', 'b.yml pattern:config-secret']);
    // A YAML plain scalar continues after spaces: anything but a comment or the line end after the expression is part of the value (Astra 2586).
    expect(await scanOf({ 'd.yml': `API_TOKEN: \${{ secrets.PREFIX }} ${PASSWORD}\n`, 'e.yml': `API_TOKEN: \${{ secrets.PREFIX }};${PASSWORD}\n`,
      'f.yml': `API_TOKEN: \${{ secrets.PREFIX }} \${{ '${PASSWORD}' }}\n` })).toEqual(['d.yml pattern:config-secret', 'e.yml pattern:config-secret', 'f.yml pattern:config-secret']);
    // Only the verifiable shape is a placeholder (Astra 2588): no comma or bracket continuation, `#` needs a space before it, and the
    // value must not continue on a deeper-indented line. Sibling keys and real comments after a reference stay clean.
    expect(await scanOf({ 'g.yml': `API_TOKEN: \${{ secrets.PREFIX }},${PASSWORD}\n`, 'h.yml': `API_TOKEN: \${{ secrets.PREFIX }}#${PASSWORD}\n`,
      'i.yml': `env:\n  API_TOKEN: \${{ secrets.PREFIX }}\n    ${PASSWORD}\n`,
      'j.yml': 'env:\n  API_TOKEN: ${{ secrets.A }}\n  OTHER_TOKEN: ${{ secrets.B }}   # sibling\n\n  # note\nnext: 1\n' }))
      .toEqual(['g.yml pattern:config-secret', 'h.yml pattern:config-secret', 'i.yml pattern:config-secret']);
    // Mixed line breaks use one definition (Astra 2590); an expression is a reference only to a GitHub context, never a bare literal.
    expect(await scanOf({ 'k.yml': `root:\n    other: value\rAPI_TOKEN: \${{ secrets.PREFIX }}\n  ${PASSWORD}\n`,
      'l.yml': 'API_TOKEN: ${{ 12345678901234567890 }}\n', 'm.yml': 'API_TOKEN: ${{ hunter2hunter2 }}\n',
      'n.yml': 'GITHUB_TOKEN: ${{ github.token }}\r\nNPM_TOKEN: ${{ secrets.NPM_TOKEN }}\rnext: 1\n' }))
      .toEqual(['k.yml pattern:config-secret', 'l.yml pattern:config-secret', 'm.yml pattern:config-secret']);
  });
});

describe('parser parity: what the gate cannot read the way the worker can is refused', () => {
  it('compressed and archived files are unscannable, liftable only by an audited allowPatternPaths entry', async () => {
    const { gzipSync } = await import('node:zlib');
    const root = await tree({ 'data/dump.sql.gz': gzipSync(Buffer.from(`password=${PROVIDER_TOKEN}`)), 'vendor/pkg.zip': Buffer.from('504b030414000000', 'hex'),
      'fixtures/bundle.tgz': gzipSync(Buffer.from('x')), 'img/logo.png': Buffer.from('89504e470d0a1a0a', 'hex') });
    await expect(scanWorkerTree(root, { ...options, allowPatternPaths: ['fixtures/**'] })).resolves.toEqual({ status: 'refused', count: 2,
      findings: [{ path: 'data/dump.sql.gz', rule: 'unscannable:archive-gzip' }, { path: 'vendor/pkg.zip', rule: 'unscannable:archive-zip' }],
      excluded: [{ path: 'fixtures/bundle.tgz', rule: 'unscannable:archive-gzip', by: 'allowPatternPaths:fixtures/**' }] });
  });
  it('a token inside UTF-32 text and a Windows-style trailing dot or space on a deny-listed name are refused', async () => {
    const utf32 = Buffer.alloc(PROVIDER_TOKEN.length * 4); [...PROVIDER_TOKEN].forEach((char, index) => utf32.writeUInt32BE(char.charCodeAt(0), index * 4));
    const root = await tree({ 'notes/wide.txt': utf32, 'cfg/.env.': 'x', 'cfg/server.pem ': 'x' });
    const scan = await scanWorkerTree(root, options);
    expect(scan.status === 'refused' ? scan.findings : scan).toEqual([{ path: 'cfg/.env.', rule: 'deny-path:**/.env' }, { path: 'cfg/server.pem ', rule: 'deny-path:**/*.pem' },
      { path: 'notes/wide.txt', rule: 'pattern:provider-token' }]);
  });
});

describe('credential families, regex semantics and name matching (security review of the data files)', () => {
  const join2 = (...parts: string[]) => parts.join('');
  const hits = async (files: Record<string, string | Buffer>, extra: Partial<typeof options> = {}) => {
    const scan = await scanWorkerTree(await tree(files), { ...options, ...extra });
    return scan.status === 'refused' ? Object.fromEntries(scan.findings.map(finding => [finding.path, finding.rule])) : scan;
  };
  it('refuses every listed provider and token family (fixtures built at run time)', async () => {
    const tail = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3';
    expect(await hits({
      'a/openai.ts': join2('const k = "sk', '-proj-', tail, '";'), 'a/anthropic.ts': join2('sk', '-ant-api03-', tail), 'a/github.ts': join2('gh', 'o_', tail),
      'a/ghs.ts': join2('gh', 's_', tail), 'a/pat.ts': join2('github', '_pat_', tail), 'a/gitlab.ts': join2('gl', 'pat-', tail),
      'a/aws.ts': join2('AK', 'IA', 'ABCDEFGHIJKLMNOP'), 'a/sts.ts': join2('AS', 'IA', 'ABCDEFGHIJKLMNOP'),
      'a/aws-pair.ts': join2('const aws_secret', '_access_key = "', 'abcdEFGH1234/+abcdEFGH1234abcdEFGH12345', 'x"'),
      'a/stripe.ts': join2('sk', '_live_', tail), 'a/stripe-rk.ts': join2('rk', '_test_', tail), 'a/slack.ts': join2('xo', 'xe-', tail), 'a/slack-app.ts': join2('xa', 'pp-', tail),
      'a/jwt.ts': join2('ey', 'JhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxIn0.', 'c2lnbmF0dXJl'), 'a/rsa.ts': join2('-----BEGIN RSA ', 'PRIVATE KEY-----'),
      'a/openssh.md': join2('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'), 'a/gcp.ts': join2('{"type":"service_account","private_key":"-----BEGIN ', 'PRIVATE KEY-----\\nMII"}'),
      'a/azure.ts': join2('DefaultEndpointsProtocol=https;AccountName=x;Account', 'Key=', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODk=;'),
      'a/pg.ts': join2('postgres://app:', 'S3cret-Pw', '@db/app'), 'a/mongo.ts': join2('mongodb+srv://app:', 'S3cret-Pw', '@cluster0/x'),
      'a/mysql.ts': join2('mysql://root:', 'S3cret-Pw', '@db/x'), 'a/redis.ts': join2('redis://default:', 'S3cret-Pw', '@cache:6379'), 'a/amqp.ts': join2('amqp://u:', 'S3cret-Pw', '@mq/vhost'),
      'a/npm.ts': join2('np', 'm_', tail), 'a/pypi.ts': join2('py', 'pi-', 'AgEIcHlwaS5vcmcCJGFiY2RlZjEyLTM0NTYtNzg5MC1hYmNkLWVmMTIzNDU2Nzg5MAACJXsicGVybWlzc2lvbnMi'),
      'b/cert.p12': Buffer.from([0x30, 0x82, 1, 2]) })).toEqual({
      'a/amqp.ts': 'pattern:url-userinfo', 'a/anthropic.ts': 'pattern:provider-token', 'a/aws-pair.ts': 'pattern:aws-secret-key', 'a/aws.ts': 'pattern:provider-token',
      'a/azure.ts': 'pattern:azure-account-key', 'a/gcp.ts': 'pattern:private-key-block', 'a/ghs.ts': 'pattern:provider-token', 'a/github.ts': 'pattern:provider-token',
      'a/gitlab.ts': 'pattern:gitlab-token', 'a/jwt.ts': 'pattern:jwt', 'a/mongo.ts': 'pattern:url-userinfo', 'a/mysql.ts': 'pattern:url-userinfo', 'a/npm.ts': 'pattern:provider-token',
      'a/openai.ts': 'pattern:provider-token', 'a/openssh.md': 'pattern:private-key-block', 'a/pat.ts': 'pattern:provider-token', 'a/pg.ts': 'pattern:url-userinfo',
      'a/pypi.ts': 'pattern:pypi-token', 'a/redis.ts': 'pattern:url-userinfo', 'a/rsa.ts': 'pattern:private-key-block', 'a/slack-app.ts': 'pattern:slack-token',
      'a/slack.ts': 'pattern:slack-token', 'a/sts.ts': 'pattern:aws-temporary-key', 'a/stripe-rk.ts': 'pattern:stripe-key', 'a/stripe.ts': 'pattern:stripe-key',
      // PKCS12 is binary ASN.1 without a reliable content signature: it is refused by name (deny list), documented as name-only.
      'b/cert.p12': 'deny-path:**/*.p12' });
  });
  it('regex semantics: one JS flavour, fixed flags, case-insensitive keys; a backtracking input ends the scan as incomplete, never as a pass', async () => {
    for (const row of WORKER_TREE_PATTERN_RULES) expect(row.flags, row.id).toMatch(/^i?$/u);
    expect(REDACTION_CONFIG_SECRET.flags).toBe('gi');
    expect(await hits({ 'a.yml': 'Password: Tr0ub4dor-3xQz9\n', 'b.env.json': '{"DB_PASSWORD":"Tr0ub4dor-3xQz9"}' })).toEqual({ 'a.yml': 'pattern:config-secret', 'b.env.json': 'pattern:config-secret' });
    // `eyJ-` repeated has no dots: every start backtracks over the rest of the run (quadratic) — the worker is terminated at the deadline.
    const started = Date.now();
    await expect(scanWorkerTree(await tree({ 'big.txt': 'eyJ-'.repeat(250_000) }), { ...options, maxFileBytes: 1 << 21, timeoutMs: 500 }))
      .resolves.toMatchObject({ status: 'incomplete', limit: 'time', bound: 500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    // The config expressions are linear by construction: a hostile XML/YAML shape finishes well inside the bound.
    await expect(scanWorkerTree(await tree({ 'x.xml': '<password '.repeat(200_000), 'y.yml': 'password: ${A}\n'.repeat(200_000) }), { ...options, maxFileBytes: 1 << 22, timeoutMs: 20_000 }))
      .resolves.toMatchObject({ status: 'clean' });
  });
  it('config parsing parity: YAML indentation/chomping order, aliases, env defaults and template literals', async () => {
    expect(await hits({ 'a.yml': 'db:\n  password: |2-\n    Tr0ub4dor-3xQz9\n', 'b.yml': 'pw: &pw Tr0ub4dor-3xQz9\ndb:\n  password: *pw\n',
      'docker-compose.override.yml': 'services:\n  db:\n    environment:\n      DB_PASSWORD: ${DB_PASSWORD:-Tr0ub4dor-3xQz9}\n', 'c.json': '{"password": "{{ \'Tr0ub4dor-3xQz9\' }}"}' }))
      .toEqual({ 'a.yml': 'pattern:config-secret', 'b.yml': 'pattern:config-secret', 'c.json': 'pattern:config-secret', 'docker-compose.override.yml': 'pattern:config-secret' });
    expect(await hits({ 'a.yml': 'password: ${DB_PASSWORD:-}\ntoken: ${API_TOKEN:?set it}\nsecret: "{{ vault_secret }}"\n' })).toEqual({ status: 'clean' });
  });
  it('name matching between data and scanner: multi-dot, compound and Windows/Unicode forms', async () => {
    const value = 'password = "Tr0ub4dor-3xQz9"\n';
    expect(await hits({ '.env.production.local': 'x', 'app.config.json': value, 'docker-compose.override.yml': value, 'cfg/ｓｅｔｔｉｎｇｓ.ｊｓｏｎ': value,
      'cfg/settings.json.': value, 'cfg/Web.Config': value, 'src/notes.txt': value })).toEqual({ '.env.production.local': 'deny-path:.env.*', 'app.config.json': 'pattern:config-secret',
      'cfg/Web.Config': 'pattern:config-secret', 'cfg/settings.json.': 'pattern:config-secret', 'cfg/ｓｅｔｔｉｎｇｓ.ｊｓｏｎ': 'pattern:config-secret',
      'docker-compose.override.yml': 'pattern:config-secret' });
  });
});
