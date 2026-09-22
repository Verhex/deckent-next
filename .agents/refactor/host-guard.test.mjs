import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { guard } from './host-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'host-guard.mjs');
const root = '/tmp/next-root';
const legacy = '/tmp/deckent-dev';

function ctx(over = {}) {
  return {
    root, legacy,
    vitestRunning: () => false,
    readLines: () => 46,
    refreshMemoryManifest: () => 'refreshed (stub)',
    sessionSummary: () => 'summary (stub)',
    ...over,
  };
}
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path } });
const decision = (out) => out.hookSpecificOutput?.permissionDecision ?? 'pass';

test('legacy runtime execution is denied, legacy reads pass', () => {
  assert.equal(decision(guard('pre-tool', bash(`node ${legacy}/dist/cli.js run`), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash('cd /home/alperen/deckent-dev && npm run start'), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash(`docker compose -f ${legacy}/compose.yml up`), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash(`cat ${legacy}/PLAN.md | head`), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', bash(`git -C ${legacy} log --oneline -5`), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', bash(`grep -rn approval ${legacy}/src`), ctx())), 'pass');
  const denied = guard('pre-tool', bash(`node ${legacy}/x.js`), ctx());
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /read-only reference/);
});

test('false-block cases: legacy path as data, not as executable, passes', () => {
  // The exact command that produced the first live false positive: legacy path inside an echo string.
  assert.equal(decision(guard('pre-tool', bash(`echo '{"tool_input":{"command":"node ${legacy}/dist/cli.js"}}' | node .agents/refactor/host-guard.mjs pre-tool`), ctx())), 'pass');
  // Next host script that reads legacy as an argument (legacy-surface-inventory) must not be denied.
  assert.equal(decision(guard('pre-tool', bash(`node .agents/refactor/legacy-surface-inventory.mjs --legacy ${legacy}`), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', bash(`grep -rn "deckent-dev" PLAN.md`), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', bash(`ls ${legacy}/src && wc -l ${legacy}/PLAN.md`), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', bash(`cd ${legacy} && git log -3 && cd -`), ctx())), 'pass');
  // Execution after cd into legacy is still denied.
  assert.equal(decision(guard('pre-tool', bash(`cd ${legacy}; node dist/cli.js`), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash(`cd ${legacy} && ./bin/deckent run`), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash(`npm --prefix ${legacy} run start`), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash(`${legacy}/bin/deckent --help`), ctx())), 'deny');
});

test('legacy writes are denied, Next writes pass', () => {
  assert.equal(decision(guard('pre-tool', edit(`${legacy}/src/a.ts`), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', edit(`${root}/src/a.ts`), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', { tool_name: 'Write', tool_input: { file_path: `${legacy}/x.md` } }, ctx())), 'deny');
});

test('recursive rm is denied, plain rm passes', () => {
  assert.equal(decision(guard('pre-tool', bash('rm -rf node_modules'), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash('rm -r build && ls'), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash('rm --recursive dist'), ctx())), 'deny');
  assert.equal(decision(guard('pre-tool', bash('rm -f /tmp/x.log'), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', bash('npm run test'), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', bash(`echo "never run rm -rf here" >> notes.md`), ctx())), 'pass');
  assert.equal(decision(guard('pre-tool', bash('grep -n "rm -rf" scripts/*.mjs'), ctx())), 'pass');
});

test('build and verify are denied only while vitest runs', () => {
  const running = ctx({ vitestRunning: () => true });
  assert.equal(decision(guard('pre-tool', bash('npm run build'), running)), 'deny');
  assert.equal(decision(guard('pre-tool', bash('npm run verify'), running)), 'deny');
  assert.equal(decision(guard('pre-tool', bash('node scripts/build.mjs'), running)), 'deny');
  assert.equal(decision(guard('pre-tool', bash('tsc --noEmit'), running)), 'pass');
  assert.equal(decision(guard('pre-tool', bash('npm run lint'), running)), 'pass');
  assert.equal(decision(guard('pre-tool', bash('echo "npm run build later"'), running)), 'pass');
  assert.equal(decision(guard('pre-tool', bash('npm run build'), ctx())), 'pass');
});

test('post-tool: CLAUDE.md line cap and core-memory manifest refresh', () => {
  const over = guard('post-tool', edit(`${root}/CLAUDE.md`), ctx({ readLines: () => 71 }));
  assert.equal(over.decision, 'block');
  assert.match(over.reason, /71 lines/);
  assert.deepEqual(guard('post-tool', edit(`${root}/AGENTS.md`), ctx({ readLines: () => 70 })), {});
  let calls = 0;
  const mem = guard('post-tool', edit(`${root}/.deckent/docs/core-memory/new_fact.md`), ctx({ refreshMemoryManifest: () => { calls++; return 'refreshed'; } }));
  assert.equal(calls, 1);
  assert.equal(mem.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(mem.hookSpecificOutput.additionalContext, /refreshed/);
  assert.deepEqual(guard('post-tool', edit(`${root}/src/x.ts`), ctx({ refreshMemoryManifest: () => { throw new Error('must not run'); } })), {});
});

test('session-start injects summary; unknown events and malformed input pass', () => {
  const s = guard('session-start', {}, ctx());
  assert.equal(s.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(s.hookSpecificOutput.additionalContext, 'summary (stub)');
  assert.deepEqual(guard('mystery', bash('rm -rf /'), ctx()), {});
  assert.deepEqual(guard('pre-tool', null, ctx()), {});
  assert.deepEqual(guard('pre-tool', { tool_name: 'Bash', tool_input: { command: 42 } }, ctx()), {});
});

test('CLI: reads stdin JSON, always exits 0, garbage input is fail-open', () => {
  const run = (event, stdin) => execFileSync('node', [script, event, '--root', root, '--legacy', legacy], { input: stdin, encoding: 'utf8' });
  const denied = JSON.parse(run('pre-tool', JSON.stringify(bash(`node ${legacy}/a.js`))));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(JSON.parse(run('pre-tool', 'not json')), {});
  assert.deepEqual(JSON.parse(run('pre-tool', '')), {});
  assert.deepEqual(JSON.parse(run('pre-tool', JSON.stringify(bash('ls -la')))), {});
});
