import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(process.env.DECKENT_TEST_ARCH_SCRIPT ?? 'scripts/lint-arch.mjs');
const roots: string[] = [];
const file = 'src/engine/core/example/index.tsx';
const policy = {
  slugs: ['claude', 'codex', 'cursor', 'docker', 'openai', 'anthropic', 'gemini', 'qwen', 'llama', 'vllm', 'sglang', 'openrouter', 'bedrock'],
  registryFiles: [], vendorUnits: [], invariants: [], allowlist: 'baseline.json',
};
function put(root: string, path: string, text: string) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); }
function fixture(source: string, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hardcode-ratchet-')); roots.push(root);
  const arch = JSON.parse(readFileSync('arch.json', 'utf8'));
  arch.hardcodeRatchet = { ...policy, ...extra };
  put(root, 'arch.json', JSON.stringify(arch));
  put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve' }, include: ['src/**/*'] }));
  put(root, 'package.json', JSON.stringify({ dependencies: {}, devDependencies: {} }));
  put(root, file, source);
  put(root, 'baseline.json', '[]');
  return root;
}
function run(root: string, inventory = false) {
  const result = spawnSync(process.execPath, [script, '--root', root, inventory ? '--hardcode-inventory' : '--hardcode-only'], { encoding: 'utf8', timeout: 20000 });
  return { code: result.status, out: result.stdout + result.stderr };
}
function freeze(root: string) {
  const entries = JSON.parse(run(root, true).out).map(({ file: path, fingerprint, rule }: { file: string; fingerprint: string; rule: string }) => ({ file: path, fingerprint, rule }));
  put(root, 'baseline.json', JSON.stringify(entries));
  const arch = JSON.parse(readFileSync(join(root, 'arch.json'), 'utf8'));
  // Frozen membership hashes are independent of the editable allowance list.
  arch.hardcodeRatchet.frozen = entries.map((entry: unknown) => createHash('sha256').update(JSON.stringify(entry)).digest('hex'));
  put(root, 'arch.json', JSON.stringify(arch));
  return entries;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('hardcode ratchet admission', () => {
  const history = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' });
  // Export/shallow checks below exercise the warning; they cannot prove admission history.
  it('matches the first admission exactly to the detector inventory of the introduction base tree (requires full Git history)', context => {
    if (history.status !== 0 || history.stdout.trim() !== 'false') context.skip('GIT_ADMISSION_HISTORY_UNAVAILABLE: full first-parent history required');
    const base = '19a6bb42c8eefb0985287f91adeea487e4fc616f';
    const list = 'scripts/hardcode-allowlist.json';
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const first = git('log', '--first-parent', '--full-history', '--reverse', '--format=%H', 'HEAD', '--', list).split('\n')[0];
    // Before the lead's single introduction commit, the working list is admission.
    // Afterward read the FIRST version, so legitimate later cleanup stays valid.
    const admittedFile = (path: string) => first ? git('show', `${first}:${path}`) : readFileSync(path, 'utf8');
    const root = mkdtempSync(join(tmpdir(), 'hardcode-admission-')); roots.push(root);
    // Windows spawnSync pipe transport returned EOF for this binary archive. Files preserve the exact bytes.
    const archive = join(root, 'source.tar');
    execFileSync('git', ['archive', '--output', archive, base, 'src', 'package.json', 'tsconfig.json']);
    // A drive-letter archive is remote syntax to GNU tar; cwd + relative names work with GNU and BSD tar.
    execFileSync('tar', ['-xf', 'source.tar'], { cwd: root });
    rmSync(archive);
    put(root, 'arch.json', admittedFile('arch.json'));
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    // Admission equality is a claim about the detector AT admission: run that commit's scanner.
    // Later narrowing (e.g. the batch-27 G4 protocol-version exemption) may only retire identities.
    const detector = mkdtempSync(join(tmpdir(), 'hardcode-detector-')); roots.push(detector);
    if (first) {
      const archive = join(detector, 'scripts.tar');
      execFileSync('git', ['archive', '--output', archive, first, 'scripts']);
      execFileSync('tar', ['-xf', 'scripts.tar'], { cwd: detector });
      rmSync(archive);
    }
    else cpSync('scripts', join(detector, 'scripts'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(detector, 'node_modules'), 'dir');
    // The historical scanner exits immediately after stdout.write. File stdout is
    // synchronous on every supported OS, preserving its exact historical inventory.
    const inventoryFile = join(detector, 'inventory.json');
    const fd = openSync(inventoryFile, 'w');
    let admitted;
    try {
      admitted = spawnSync(process.execPath, [join(detector, 'scripts/lint-arch.mjs'), '--root', root, '--hardcode-inventory'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', fd, 'pipe'] });
    } finally { closeSync(fd); }
    expect(admitted.status, admitted.stderr).toBe(0);
    const result = run(root, true);
    expect(result.code).toBe(0);
    const identity = ({ file: path, fingerprint, rule }: { file: string; fingerprint: string; rule: string }) => JSON.stringify({ file: path, fingerprint, rule });
    const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8')).map(identity).sort();
    const admission = JSON.parse(admittedFile(list)).map(identity).sort();
    // Array equality detects missing, phantom and duplicate members, in both directions.
    expect(admission).toEqual(inventory);
    const current: string[] = JSON.parse(result.out).map(identity);
    expect(current.filter(id => !admission.includes(id))).toEqual([]);
    expect(admission).toHaveLength(514);
    const frozen = JSON.parse(admittedFile('arch.json')).hardcodeRatchet.frozen;
    expect(frozen.slice().sort()).toEqual(admission.map((id: string) => createHash('sha256').update(id).digest('hex')).sort());
  // Two scanner children keep their 20s bounds; 20s remains for archive/history fixture IO on Windows.
  }, 60_000);
  it('admits a first introduction absent from history, then refuses growth with one list version', () => {
    const root = fixture("if (provider === 'claude') act();");
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
    const commit = (message: string) => { git('add', '.'); git('commit', '-m', message); };
    rmSync(join(root, 'baseline.json'));
    git('init', '-b', 'main'); commit('base before ratchet');
    freeze(root);
    expect(git('log', '--format=%H', 'HEAD', '--', 'baseline.json')).toBe('');
    expect(run(root)).toEqual({ code: 0, out: '\n' });
    commit('single initial admission');
    expect(git('log', '--format=%H', 'HEAD', '--', 'baseline.json').split('\n')).toHaveLength(1);
    expect(run(root)).toEqual({ code: 0, out: '\n' });
    put(root, file, "if (provider === 'claude') act(); if (provider === 'codex') act();");
    freeze(root); // Even editing frozen alongside the list cannot bypass history.
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('entry absent in first-parent list version') });
    commit('illegal growth');
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('entry absent in first-parent list version') });
  });
});

it('delivers a complete inventory larger than a pipe buffer before exiting', async () => {
    const declarations = Array.from({ length: 600 }, (_, i) => `function check${i}() { if (provider === 'claude') act(); }`);
    const root = fixture(declarations.join('\n'));
    const child = spawn(process.execPath, [script, '--root', root, '--hardcode-inventory'], { timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    child.stderr.on('data', chunk => errors.push(chunk));
    // Hold the first readable chunk so the producer must keep pending pipe writes
    // alive, rather than relying on this host's consumer scheduling speed.
    child.stdout.once('readable', () => {
      setTimeout(() => { child.stdout.on('data', chunk => chunks.push(chunk)); child.stdout.resume(); }, 50);
    });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const output = Buffer.concat(chunks).toString('utf8');
    expect(code, Buffer.concat(errors).toString('utf8')).toBe(0);
    expect(Buffer.byteLength(output)).toBeGreaterThan(65_536);
    const inventory = JSON.parse(output) as { symbol: string }[];
    expect(inventory.map(row => row.symbol).sort()).toEqual(declarations.map((_, i) => `check${i}`).sort());
  });
describe('hardcode ratchet', () => {
  it.each(['G1', 'G2', 'G3', 'G4'])('detects %s new literals through the CLI', rule => {
    const source = readFileSync(resolve(`tests/fixtures/hardcode-ratchet/${rule}.fixture`), 'utf8');
    const root = fixture(source);
    if (rule === 'G4') put(root, 'src/platform/core/config-fields/internal/fields.ts', "const fields = { pageSize: field('config.pageSize', { state: 'bound', consumers: ['src/engine/core/example'] }, 'live', z.number().default(73)) };");
    const result = run(root);
    expect(result.out).toContain(`[hardcode-${rule}]`);
    expect(result.code).toBe(1);
    const inventory = JSON.parse(run(root, true).out).filter((row: { rule: string }) => row.rule === rule);
    expect(inventory).toHaveLength({ G1: 7, G2: 7, G3: 6, G4: 1 }[rule]!);
  });
  it('permits explicit protocol invariants, registry JSON, machine codes and arithmetic', () => {
    const root = fixture("const HEADER_BYTES = 64; const maxItems = 2; const index = 1; const offset = -1; const zero = 0; throw new Error('FOO_BAR'); emit(t('status.ready'));", {
      invariants: [{ file, symbol: 'HEADER_BYTES', values: [64], reason: 'Versioned frame header size' }],
    });
    put(root, 'src/engine/core/example/registry.json', '{"provider":"claude","timeoutMs":9999}');
    expect(run(root)).toMatchObject({ code: 0 });
  });
  it('limits vendor exemptions to the exact adapter and slug', () => {
    const root = fixture("if (provider === 'claude') act();", { vendorUnits: [{ unit: 'src/adapters/core/example', slugs: ['claude'], reason: 'Implements this wire protocol' }] });
    put(root, 'src/adapters/core/example/index.ts', "if (provider === 'claude') act(); if (other === 'codex') act();");
    const findings = JSON.parse(run(root, true).out);
    expect(findings.filter((row: { literal: string }) => row.literal === 'claude')).toHaveLength(1);
    expect(findings.filter((row: { literal: string }) => row.literal === 'codex')).toHaveLength(1);
  });
  it('keeps fingerprints stable across lines and quotes but catches a second identical occurrence', () => {
    const root = fixture("function pick() { if (provider === 'claude') act(); }");
    freeze(root);
    put(root, file, '\n// unrelated comment\nfunction pick() { if (provider === "claude") act(); }');
    expect(run(root).code).toBe(0);
    put(root, file, "function pick() { if (provider === 'claude') act(); if (provider === 'claude') act(); }");
    expect(run(root).out).toContain('[hardcode-G1]');
  });
  it('rejects allowlist additions and equal-size replacement and reports shrink delta', () => {
    const root = fixture("if (provider === 'claude') act();");
    const entries = freeze(root);
    put(root, 'baseline.json', JSON.stringify([...entries, { ...entries[0], fingerprint: 'new' }]));
    expect(run(root).out).toContain('[hardcode-allowlist-growth]');
    put(root, 'baseline.json', JSON.stringify([{ ...entries[0], fingerprint: 'replacement' }]));
    expect(run(root).out).toContain('[hardcode-allowlist-growth]');
    put(root, file, 'export {};');
    put(root, 'baseline.json', '[]');
    expect(run(root).out).toContain('allowlist delta: -1');
    expect(run(root).code).toBe(0);
  });
  it('forbids restoring an allowance removed in Git history', () => {
    const root = fixture("if (provider === 'claude') act();"); const entries = freeze(root);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
    git('init'); git('add', '.'); git('commit', '-m', 'initial');
    put(root, 'baseline.json', '[]'); put(root, file, 'export {};'); git('add', '.'); git('commit', '-m', 'shrink');
    put(root, 'baseline.json', JSON.stringify(entries));
    expect(run(root).out).toContain('[hardcode-allowlist-growth]');
    git('add', '.'); git('commit', '-m', 'illegal restoration');
    expect(run(root).out).toContain('[hardcode-allowlist-growth]');
  });
  it.each(['parentheses', 'assertion', 'membership', 'shorthand'])('rejects G1 %s counterexample with empty admission', example => {
    const root = fixture(readFileSync(`tests/fixtures/hardcode-ratchet/G1-${example}.fixture`, 'utf8'), { frozen: [] });
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('[hardcode-G1]') });
  });
  it('classifies plain and wrapped G1 syntax without treating typed registry reads as literals', () => {
    const contexts = [
      "provider === VALUE;", "switch (provider) { case VALUE: break; }",
      "known.has(VALUE);", "[VALUE].includes(provider);", "const keys = { [VALUE]: true };",
      "const selected = registry[VALUE];",
    ];
    const values = ["'claude'", "('claude')", "('claude' as const)", "('claude' satisfies string)", "('claude'!)"];
    const root = fixture(contexts.flatMap(context => values.map(value => context.replace('VALUE', value))).join('\n') +
      "\nconst claude = true; const keys = { claude };", { frozen: [] });
    // Type assertion syntax belongs in .ts, since <string> is JSX in .tsx.
    put(root, 'src/engine/core/example/assertion.ts', "declare const provider: string; provider === (<string>'claude');");
    const findings = JSON.parse(run(root, true).out);
    expect(findings.filter((row: { rule: string }) => row.rule === 'G1')).toHaveLength(contexts.length * values.length + 2);
    expect(run(root).code).toBe(1);
    put(root, file, "declare const registry: { claude: string }; type Provider = 'claude'; type Ref = typeof registry.claude; const value = registry.claude; const allowed = value === (registry.claude as Provider); known.has((registry.claude));");
    put(root, 'src/engine/core/example/assertion.ts', 'export {};');
    expect(run(root).code).toBe(0);
  });
  it('preserves exact vendor exemptions for wrapped literals and shorthand keys', () => {
    const root = fixture('export {};', { frozen: [], vendorUnits: [{ unit: 'src/adapters/core/example', slugs: ['claude'], reason: 'Own protocol' }] });
    put(root, 'src/adapters/core/example/index.ts', "declare const provider: string; const claude = true; provider === ('claude' as const); const keys = { claude };");
    expect(run(root).code).toBe(0);
    put(root, 'src/adapters/core/example/other.ts', "declare const provider: string; provider === ('codex');");
    put(root, file, "declare const provider: string; provider === ('claude');");
    expect(JSON.parse(run(root, true).out).filter((row: { rule: string }) => row.rule === 'G1')).toHaveLength(2);
    expect(run(root).code).toBe(1);
  });
  it.each(['final T', 'no-op', 'later shrink', 'merge'])('retains retired membership at %s without running the intermediate restoration gate', stage => {
    const parts = ["if (provider === 'claude') act();", "if (provider === 'codex') act();", "if (provider === 'cursor') act();"];
    const root = fixture(parts.join('\n')); const entries = freeze(root);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
    const commit = (message: string) => { git('add', '.'); git('commit', '--allow-empty', '-m', message); };
    const set = (indexes: number[]) => {
      put(root, file, indexes.map(index => parts[index]).join('\n'));
      // Select identities from the production scanner, but never change frozen admission.
      const found = JSON.parse(run(root, true).out) as { fingerprint: string }[];
      put(root, 'baseline.json', JSON.stringify(entries.filter((entry: { fingerprint: string }) => found.some(row => row.fingerprint === entry.fingerprint))));
    };
    git('init', '-b', 'main'); commit('I');
    set([1, 2]); commit('S removes A');
    if (stage === 'merge') {
      git('switch', '-c', 'restoration'); set([0, 1, 2]); commit('R'); set([0, 1]); commit('T');
      git('switch', 'main'); commit('main no-op'); git('merge', '--no-ff', 'restoration', '-m', 'merge restoration');
    } else {
      set([0, 1, 2]); commit('R'); set([0, 1]); commit('T');
      if (stage === 'no-op') commit('no-op');
      if (stage === 'later shrink') { set([0]); commit('remove B'); }
    }
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('[hardcode-allowlist-growth]') });
  });
  it('allows initial admission and monotonic cleanup through commits and merges', () => {
    const root = fixture("if (provider === 'claude') act();"); freeze(root);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
    git('init', '-b', 'main');
    expect(run(root).code).toBe(0);
    git('add', '.'); git('commit', '-m', 'initial');
    expect(run(root).code).toBe(0);
    git('switch', '-c', 'cleanup'); put(root, file, 'export {};'); put(root, 'baseline.json', '[]');
    expect(run(root).code).toBe(0);
    git('add', '.'); git('commit', '-m', 'shrink'); git('switch', 'main'); git('merge', '--no-ff', 'cleanup', '-m', 'merge cleanup');
    expect(run(root)).toMatchObject({ code: 0, out: expect.stringContaining('allowlist delta: -1') });
  });
  it('makes export and shallow history limits visible', () => {
    const root = fixture("if (provider === 'claude') act();"); freeze(root);
    expect(run(root)).toMatchObject({ code: 0, out: expect.stringContaining('[hardcode-history-unavailable]') });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
    git('init'); git('add', '.'); git('commit', '-m', 'initial'); git('commit', '--allow-empty', '-m', 'later');
    const shallow = mkdtempSync(join(tmpdir(), 'hardcode-shallow-')); roots.push(shallow);
    git('clone', '--depth=1', `file://${root}`, shallow);
    expect(run(shallow)).toMatchObject({ code: 0, out: expect.stringContaining('[hardcode-history-unavailable]') });
  });
  it('uses registered schemas and binding consumers for nested numeric and string defaults', () => {
    const root = fixture("const selected = { timeoutMs: 8765, mode: 'steady' };");
    put(root, 'src/adapters/core/example/index.ts', "const schema = z.object({ nested: z.object({ timeoutMs: z.number().default(8765), mode: z.string().default('steady') }) }); registerConfigSection('example', schema, { metadata: { binding: { state: 'bound', consumers: ['src/engine/core/example'] }, apply: 'live' } }); const rogueTimeoutMs = 8766;");
    const findings = JSON.parse(run(root, true).out);
    expect(findings.filter((row: { rule: string }) => row.rule === 'G4')).toHaveLength(2);
    expect(findings.filter((row: { literal: number }) => row.literal === 8765)).toHaveLength(2);
    expect(findings.some((row: { literal: number }) => row.literal === 8766)).toBe(true);
  });
});

describe('file moves keep the (fingerprint, rule) count', () => {
  const moved = 'src/engine/core/example/moved.ts', source = "function pick() { if (provider === 'claude') act(); }";
  const gitIn = (root: string) => (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
  const relocate = (entries: { file: string; fingerprint: string; rule: string }[]) => entries.map(entry => ({ ...entry, file: moved, origin: entry.file }));
  it('allows a move with an origin claim, with and without Git history', () => {
    const root = fixture(source); const entries = freeze(root);
    put(root, file, 'export {};'); put(root, moved, source);
    // Without the origin claim the moved row is a new identity, and the old row is stale.
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('with origin') });
    put(root, 'baseline.json', JSON.stringify(relocate(entries)));
    expect(run(root)).toMatchObject({ code: 0, out: expect.stringContaining('[hardcode-history-unavailable]') });
    const git = gitIn(root);
    git('init', '-b', 'main'); put(root, file, source); put(root, moved, 'export {};'); put(root, 'baseline.json', JSON.stringify(entries));
    git('add', '.'); git('commit', '-m', 'admission');
    put(root, file, 'export {};'); put(root, moved, source); put(root, 'baseline.json', JSON.stringify(relocate(entries)));
    expect(run(root)).toEqual({ code: 0, out: '\n' });
    git('add', '.'); git('commit', '-m', 'move');
    expect(run(root)).toEqual({ code: 0, out: '\n' });
  });
  it('refuses a move plus copy whether or not the copy is listed', () => {
    const root = fixture(source); const entries = freeze(root); const git = gitIn(root);
    git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'admission');
    put(root, moved, source);
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('[hardcode-G1] src/engine/core/example/moved.ts') });
    put(root, 'baseline.json', JSON.stringify([...entries, ...relocate(entries)]));
    const result = run(root);
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining('duplicate admission claim') });
    expect(result.out).toContain('(count 2 > 1)');
    put(root, 'baseline.json', JSON.stringify([...entries, ...entries.map(entry => ({ ...entry, file: moved }))]));
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('entry outside frozen membership') });
  });
  it('refuses relocating an identity removed in history and malformed origins', () => {
    const root = fixture(source); const entries = freeze(root); const git = gitIn(root);
    git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'I');
    put(root, file, 'export {};'); put(root, 'baseline.json', '[]'); git('add', '.'); git('commit', '-m', 'S removes');
    put(root, moved, source); put(root, 'baseline.json', JSON.stringify(relocate(entries)));
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('entry absent in first-parent list version') });
    const self = fixture(source); const admitted = freeze(self);
    put(self, 'baseline.json', JSON.stringify(admitted.map(entry => ({ ...entry, origin: entry.file }))));
    expect(run(self)).toMatchObject({ code: 1, out: expect.stringContaining('origin must name a different admission file') });
    put(self, file, 'export {};'); put(self, moved, source);
    put(self, 'baseline.json', JSON.stringify(admitted.map(entry => ({ ...entry, file: moved, origin: 'src/engine/core/example/other.ts' }))));
    expect(run(self)).toMatchObject({ code: 1, out: expect.stringContaining('entry outside frozen membership') });
  });
});

describe('colliding admission history', () => {
  const other = 'src/engine/core/example/other.ts', moved = 'src/engine/core/example/moved.ts';
  const extra = 'src/engine/core/example/extra.ts', source = 'const timeoutMs = 2147483647;';
  type Entry = { file: string; fingerprint: string; rule: string; origin?: string };
  function collision(laterShrink = false) {
    const root = fixture(source);
    put(root, other, source);
    if (laterShrink) put(root, extra, 'const maxItems = 73;');
    const entries: Entry[] = freeze(root);
    const a = entries.find(row => row.file === file)!, b = entries.find(row => row.file === other)!;
    expect(a.rule).toBe('G2');
    expect(b).toEqual({ ...a, file: other }); // Real scanner collision, separate frozen claims.
    expect(entries).toHaveLength(laterShrink ? 3 : 2);
    const spare = entries.filter(row => row.file === extra);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
    const commit = (message: string) => { git('add', '.'); git('commit', '--allow-empty', '-m', message); };
    const list = (rows: Entry[]) => put(root, 'baseline.json', JSON.stringify(rows));
    git('init', '-b', 'main'); commit('I admits A and B');
    expect(git('rev-parse', '--is-shallow-repository')).toBe('false');
    return { root, a, b, spare, git, commit, list };
  }
  describe.each(['original', 'relocated'])('%s retired claim', location => {
    it.each(['final T', 'no-op', 'later shrink', 'merge'])('rejects same-count restoration at %s without an intermediate gate', stage => {
      const { root, a, b, spare, git, commit, list } = collision(stage === 'later shrink');
      put(root, file, 'export {};'); list([b, ...spare]); commit('S removes A');
      const removedAt = git('rev-parse', 'HEAD');
      if (stage === 'merge') git('switch', '-c', 'restoration');
      put(root, other, 'export {};');
      const restored = location === 'relocated' ? { ...a, file: moved, origin: a.file } : a;
      put(root, restored.file, source); list([restored, ...spare]); commit('T restores A and removes B');
      if (stage === 'no-op') commit('no-op after T');
      if (stage === 'later shrink') {
        put(root, extra, 'export {};'); list([restored]); commit('later shrink keeps restored A');
      }
      if (stage === 'merge') {
        git('switch', 'main'); commit('main no-op'); git('merge', '--no-ff', 'restoration', '-m', 'merge restoration');
        expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
      }
      // No gate ran at S or T. Source/list agree; only A's historical removal makes this red.
      const result = run(root);
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain('[hardcode-allowlist-growth]');
      expect(result.out).toContain(`admission claim absent in first-parent list version ${removedAt}: ${JSON.stringify(a)}`);
      expect(result.out).not.toMatch(/hardcode-history-unavailable|hardcode-allowlist-stale|\[hardcode-G2\]|count \d+ >|duplicate|outside frozen/);
    // freeze inventory + final gate are separately bounded 20s scanner processes; history IO gets 20s.
    }, 60_000);
  });
  it('allows the living B claim to move after A retires, including later moves across normalized history', () => {
    const { root, a, b, commit, list } = collision();
    expect(run(root)).toEqual({ code: 0, out: '\n' }); // Legitimate multi-occurrence admission.
    put(root, file, 'export {};'); list([b]); commit('S removes A');
    put(root, other, 'export {};'); put(root, moved, source);
    list([{ ...b, file: moved, origin: b.file }]); commit('move living B to C');
    expect(run(root)).toEqual({ code: 0, out: 'hardcode allowlist delta: -1 from frozen admission (1 remaining)\n\n' });
    // Reuse A's old location with B's live identity; every historical origin must normalize too.
    put(root, moved, 'export {};'); put(root, a.file, source);
    list([{ ...b, file: a.file, origin: b.file }]); commit('move living B again');
    expect(run(root)).toEqual({ code: 0, out: 'hardcode allowlist delta: -1 from frozen admission (1 remaining)\n\n' });
  });
});

describe('G4 protocol version fields', () => {
  it('does not treat schemaVersion/encodingVersion values as config-default copies, but still flags other fields', () => {
    const root = fixture([
      'const a = { schemaVersion: 73 };', 'const b = { encodingVersion: (73 as const) };', 'const c = { schemaVersion: 73 satisfies number };',
      'const d = { pageSize: 73 };', 'const e = { version: 73 };', 'const f = { nested: { schemaVersion: 74 } }; const g = [73];',
    ].join('\n'), { frozen: [] });
    put(root, 'src/platform/core/config-fields/internal/fields.ts', "const fields = { pageSize: field('config.pageSize', { state: 'bound', consumers: ['src/engine/core/example'] }, 'live', z.number().default(73)) };");
    const findings = JSON.parse(run(root, true).out).filter((row: { rule: string }) => row.rule === 'G4');
    expect(findings.map((row: { symbol: string }) => row.symbol).sort()).toEqual(['d/pageSize', 'e/version', 'g']);
    expect(run(root)).toMatchObject({ code: 1, out: expect.stringContaining('[hardcode-G4]') });
  });
});
