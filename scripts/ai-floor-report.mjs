import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, floorTable } from './ai-floor-inventory.mjs';
import { loadPolicySource } from './ai-floor-source.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const reportBase = 'docs/reports/ai-floor-compliance';
const human = { id: 'fixture-human', issuer: 'fixture-host', subject: 'fixture-person', assurance: 'os-user', scopeIds: ['fixture-scope'] };
const ai = { ...human, id: 'fixture-mcp', issuer: 'fixture-host/mcp', assurance: 'workload-verified' };
const principalRef = principal => ({ issuer: principal.issuer, subject: principal.subject });
const grant = (principal, route) => ({ id: 'fixture-grant', effect: 'allow', principals: [principalRef(principal)], scopes: ['fixture-scope'],
  actions: [route.action], resource: { kind: route.kind, ids: [route.id] } });
const policyFor = grants => ({ schemaVersion: 1, revision: 'fixture-policy', grants, restrictions: [] });
const requestFor = (principal, route) => ({ principal, scopeId: 'fixture-scope', action: route.action, resource: { kind: route.kind, id: route.id } });

/** Each expectation is an independent fixture, not a call to the floor predicate under test. */
export function generateReport(api, sources = {}) {
  const routes = inventory(api.getPolicyVocabulary());
  const contexts = [
    { id: 'ai-no-cell', principal: ai, granted: false },
    { id: 'ai-granting-cell', principal: ai, granted: true },
    { id: 'human-tty-policy', principal: human, granted: true },
    { id: 'legacy-mcp-os-user-granted', principal: { ...ai, assurance: 'os-user' }, granted: true },
    { id: 'workload-granted', principal: { ...ai, issuer: 'fixture-workload' }, granted: true },
    { id: 'token-granted', principal: { ...ai, issuer: 'fixture-token', assurance: 'token-verified' }, granted: true },
  ];
  const rows = routes.flatMap(route => contexts.map(context => {
    const aiFloor = route.floor && context.principal !== human;
    const expected = aiFloor ? { decision: 'deny', reason: 'AI_NON_DELEGABLE' }
      : context.granted ? { decision: 'allow', reason: 'GRANTED' } : { decision: 'deny', reason: 'NO_GRANT' };
    const actual = api.evaluatePolicy(policyFor(context.granted ? [grant(context.principal, route)] : []), requestFor(context.principal, route));
    return { ...route, context: context.id, expected, actual: { decision: actual.decision, reason: actual.reason },
      verdict: actual.decision === expected.decision && actual.reason === expected.reason ? 'uyumlu' : 'İHLAL', reason: actual.reason };
  }));
  // The additional step gate requires exact named actor + explicit action, even after evaluatePolicy allows.
  const steps = routes.filter(route => ['task-decision', 'run-decision'].includes(route.kind) || route.kind === 'approval' && route.id === 'fixture-target' && route.action === 'decide');
  const stepRows = steps.flatMap(route => ['no-cell', 'exact-cell', 'wildcard-action', 'wildcard-principal', 'deny', 'require-approval', 'revoked', 'wrong-scope'].map(context => {
    let rule = grant(ai, route);
    if (context === 'wildcard-action') rule = { ...rule, actions: 'all' };
    if (context === 'wildcard-principal') rule = { ...rule, principals: 'all' };
    if (context === 'wrong-scope') rule = { ...rule, scopes: ['other-scope'] };
    const policy = policyFor(['no-cell', 'revoked'].includes(context) ? [] : [rule]);
    if (context === 'deny' || context === 'require-approval') policy.grants.push({ ...grant(ai, route), id: 'fixture-override', effect: context });
    const decision = api.evaluatePolicy(policy, requestFor(ai, route));
    const actual = api.explicitDecisionGrant(policy, ai, 'fixture-scope', route.kind, route.id, route.action);
    const expected = context === 'exact-cell' ? 'fixture-grant' : null;
    return { kind: route.kind, id: route.id, action: route.action, context, expected, actual, policyDecision: decision.decision,
      verdict: actual === expected ? 'uyumlu' : 'İHLAL', reason: decision.reason };
  }));
  const violations = [...rows, ...stepRows].filter(row => row.verdict === 'İHLAL').length;
  return { schemaVersion: 1, scope: 'Pure source policy evaluator and explicit step gate; human-tty-policy is a verified os-user fixture, not terminal attestation.',
    sources, summary: { routes: routes.length, floorRoutes: routes.filter(route => route.floor).length, contexts: contexts.length,
      policyChecks: rows.length, stepChecks: stepRows.length, violations }, rows, stepRows };
}
export function summaryLine(report) {
  const s = report.summary;
  return `ai-floor: routes=${s.routes} floor=${s.floorRoutes} policy=${s.policyChecks} steps=${s.stepChecks} uyumlu=${s.policyChecks + s.stepChecks - s.violations} İHLAL=${s.violations}`;
}
export function renderReport(report) {
  const cell = value => String(value).replaceAll('|', '\\|');
  return ['# AI floor compliance / AI yetki tabanı uyumu', '', summaryLine(report), '', report.scope, '',
    'Synthetic fixtures only. No service, TTY witness, secret store, paid call or business-process acceptance is exercised.',
    'Expectations come from the independent inventory, not the current floor predicate. All vocabulary actions plus floor families and boundary controls are enumerated.',
    'Open-ended resource IDs, config descendants and future actions are represented by boundary cases; this is not an exhaustive state-space proof.',
    'An allow is policy eligibility only: application surface restrictions, state, approval, session, assurance and effect settlement still apply.', '',
    'Regenerate: `npm run report:ai-floor`. Check without writing: `npm run report:ai-floor -- --check`.', '',
    '## Policy checks', '', '| Kind / id / action | Family | Context | Expected | Actual | Verdict | Reason |', '|---|---|---|---|---|---|---|',
    ...report.rows.map(row => `| ${[`${row.kind} / ${row.id} / ${row.action}`, row.family, row.context, `${row.expected.decision}/${row.expected.reason}`,
      `${row.actual.decision}/${row.actual.reason}`, row.verdict, row.reason].map(cell).join(' | ')} |`), '',
    '## Explicit decision-step checks', '', '| Kind / id / action | Context | Expected grant | Actual grant | Verdict | Reason |', '|---|---|---|---|---|---|',
    ...report.stepRows.map(row => `| ${[`${row.kind} / ${row.id} / ${row.action}`, row.context, row.expected ?? 'null', row.actual ?? 'null', row.verdict, row.reason].map(cell).join(' | ')} |`), '',
    '## Source custody (LF-normalized SHA-256)', '', ...Object.entries(report.sources).map(([path, hash]) => `- \`${path}\`: \`${hash}\``), ''].join('\n');
}
export function guideWithTable(text, locale) {
  const start = '<!-- ai-floor:start -->', end = '<!-- ai-floor:end -->';
  if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error('AI_FLOOR_GUIDE_MARKERS');
  return text.slice(0, text.indexOf(start) + start.length) + '\n' + floorTable(locale) + '\n' + text.slice(text.indexOf(end));
}
export function checkReport(report, baseRoot = root, check = true) {
  const artifacts = { [`${reportBase}.json`]: JSON.stringify(report, null, 2) + '\n', [`${reportBase}.md`]: renderReport(report) };
  for (const locale of ['en', 'tr']) {
    const path = `docs/policy-and-ai${locale === 'tr' ? '.tr' : ''}.md`;
    artifacts[path] = guideWithTable(readFileSync(join(baseRoot, path), 'utf8').replace(/\r\n/gu, '\n'), locale);
  }
  const drift = [];
  for (const [path, content] of Object.entries(artifacts)) {
    if (check) {
      try { if (readFileSync(join(baseRoot, path), 'utf8').replace(/\r\n/gu, '\n') !== content) drift.push(path); } catch { drift.push(path); }
    } else { mkdirSync(dirname(join(baseRoot, path)), { recursive: true }); writeFileSync(join(baseRoot, path), content); }
  }
  return drift;
}
export function reportExitCode(report, drift) { return report.summary.violations || drift.length ? 1 : 0; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--check') throw new Error('AI_FLOOR_ARGUMENT_INVALID');
  const { policy, sources } = await loadPolicySource(root);
  const report = generateReport(policy, sources);
  const drift = checkReport(report, root, args[0] === '--check');
  console.log(summaryLine(report));
  if (drift.length) console.error(`AI_FLOOR_DRIFT: ${drift.join(', ')}`);
  process.exitCode = reportExitCode(report, drift);
}
