import { Worker } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { evaluatePolicy, explicitDecisionGrant, getDecisionSteps, getPolicyVocabulary } from '#domain/index.js';
import { generateReport, checkReport, summaryLine, guideWithTable, root, reportBase, reportExitCode } from '../../../scripts/ai-floor-report.mjs';
import { floorFamilies, protectedPaths, inventory } from '../../../scripts/ai-floor-inventory.mjs';

const api = { evaluatePolicy, explicitDecisionGrant, getDecisionSteps, getPolicyVocabulary };
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function sourceWorker(removeSecretFloor = false): Promise<{ report: ReturnType<typeof generateReport>; drift: string[]; summary: string; exit: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(join(root, 'tests/fixtures/ai-floor-worker.mjs')), { workerData: { removeSecretFloor }, execArgv: [] });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('AI_FLOOR_WORKER_TIMEOUT')); }, 10_000);
    let result: Omit<Awaited<ReturnType<typeof sourceWorker>>, 'exit'> | undefined;
    worker.once('message', message => { result = message; });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', exit => { clearTimeout(timer); if (result) resolve({ ...result, exit }); else reject(new Error(`AI_FLOOR_NO_RESULT:${exit}`)); });
  });
}

it('evaluates every vocabulary cell and every independently inventoried floor route, including all decision steps', () => {
  const report = generateReport(api);
  expect(report.summary.violations).toBe(0);
  expect(new Set(report.rows.map(row => row.context)).size).toBe(6);
  expect(new Set(report.rows.filter(row => row.floor).map(row => row.family))).toEqual(new Set([...floorFamilies.map(family => family.id), 'vocabulary']));
  for (const resource of getPolicyVocabulary().resources) for (const action of resource.actions)
    expect(report.rows.some(row => row.kind === resource.kind && row.action === action)).toBe(true);
  for (const [kind, action] of [['run-decision', 'resume'], ['run-decision', 'close'], ['task-decision', 'accept'], ['task-decision', 'reject'], ['task-decision', 'answer'], ['approval', 'decide']]) {
    const steps = report.stepRows.filter(row => row.kind === kind && row.action === action);
    expect(steps).toHaveLength(8);
    expect(steps.filter(row => row.actual !== null).map(row => row.context)).toEqual(['exact-cell']);
  }
});

it('keeps all protected config roots and authority card ids represented independently of the runtime constants', () => {
  const source = readFileSync(join(root, 'src/domain/core/policy/internal/ai-floor.ts'), 'utf8');
  const strings = (constant: string) => [...source.match(new RegExp(`const ${constant} = Object.freeze\\(\\[([\\s\\S]*?)\\]\\)`))![1].matchAll(/'([^']+)'/gu)].map(match => match[1]);
  expect(strings('PROTECTED_CONFIG_PATHS')).toEqual(protectedPaths);
  expect(strings('AUTHORITY_APPROVAL_IDS')).toEqual(floorFamilies.find(family => family.id === 'cards')!.routes.map(route => route[1]));
  const rows = inventory(getPolicyVocabulary());
  for (const id of ['project:', 'project:terminal', 'project:terminal.shell', 'global:terminal.fetch', 'global:terminal.shell.environment[0]'])
    expect(rows.find(row => row.kind === 'config' && row.id === id)?.floor).toBe(true);
});

it('regenerates committed JSON, Markdown and both guide tables from actual source, prints the CI summary, and fails on drift', async () => {
  const result = await sourceWorker();
  expect(result.exit).toBe(0); expect(result.drift).toEqual([]);
  const committed = JSON.parse(readFileSync(join(root, `${reportBase}.json`), 'utf8'));
  expect(committed.summary.violations).toBe(0);
  expect(result.summary).toBe(summaryLine(committed));
  expect(result.report).toEqual(committed);
  console.log(result.summary);
  expect(generateReport(api, committed.sources)).toEqual(committed);
});

it.each(['.json', '.md', 'guide'])('detects committed %s drift without repairing or overwriting it', extension => {
  const temp = mkdtempSync(join(tmpdir(), 'ai-floor-drift-')); temporary.push(temp);
  const report = generateReport(api);
  for (const locale of ['en', 'tr']) {
    const path = `docs/policy-and-ai${locale === 'tr' ? '.tr' : ''}.md`;
    mkdirSync(dirname(join(temp, path)), { recursive: true }); writeFileSync(join(temp, path), readFileSync(join(root, path)));
  }
  checkReport(report, temp, false);
  const changed = extension === 'guide' ? 'docs/policy-and-ai.tr.md' : `${reportBase}${extension}`;
  const path = join(temp, changed), original = readFileSync(path, 'utf8');
  const drifted = extension === 'guide' ? original.replace('<!-- ai-floor:start -->', '<!-- ai-floor:start -->\nDRIFT') : original + '\nDRIFT\n';
  writeFileSync(path, drifted);
  const drift = checkReport(report, temp, true);
  expect(drift).toEqual([changed]); expect(reportExitCode(report, drift)).toBe(1);
  expect(readFileSync(path, 'utf8')).toBe(drifted);
});

it('removing the real secret floor guard produces İHLAL and a failing exit, without changing product source', async () => {
  const result = await sourceWorker(true);
  expect(result.exit).toBe(1);
  const violations = result.report.rows.filter(row => row.verdict === 'İHLAL');
  expect(violations.length).toBeGreaterThan(0);
  expect(violations.every(row => row.kind === 'secret')).toBe(true);
  expect(violations.some(row => row.context === 'ai-granting-cell' && row.actual.decision === 'allow')).toBe(true);
  console.log(`negative proof (expected failing mutant): ${result.summary}`);
});

it('keeps EN/TR examples and executable command/flag blocks identical and generated tables current', () => {
  const en = readFileSync(join(root, 'docs/policy-and-ai.md'), 'utf8'), tr = readFileSync(join(root, 'docs/policy-and-ai.tr.md'), 'utf8');
  const blocks = (text: string) => [...text.matchAll(/```(?:sh|json)\n([\s\S]*?)```/gu)].map(match => match[1]);
  const commands = (text: string) => [...text.matchAll(/`(deckent [^`]+)`/gu)].map(match => match[1]);
  expect(blocks(en)).toEqual(blocks(tr)); expect(commands(en)).toEqual(commands(tr));
  expect(guideWithTable(en, 'en')).toBe(en); expect(guideWithTable(tr, 'tr')).toBe(tr);
});
