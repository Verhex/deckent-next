import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { firstRunPolicyTemplate, getPolicyVocabulary, installationOwnerPermissions } from '#domain/index.js';
import { clearConfigCache } from '#platform/index.js';
import { inspectConfiguredMcpCapabilities } from '#composition/core/approvals/index.js';
import { me, runtime } from '../support/mcp-capability-harness.js';

const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, int(sys.argv[2]), 0, 0))
out = b''
frames = []
def read_for(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try: chunk = os.read(fd, 65536)
            except OSError: return False
            if not chunk: return False
            out += chunk
    return True
for wait, send, label in steps:
    mark = len(out)
    deadline = time.time() + 20
    while wait.encode() not in out[mark if label.startswith('+') else 0:]:
        if time.time() > deadline or not read_for(0.1):
            try: os.kill(pid, 9)
            except ProcessLookupError: pass
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace'), 'frames': frames})); sys.exit(3)
    read_for(0.4)
    frames.append([label, out.decode('utf8', 'replace')])
    for char in send:
        os.write(fd, char.encode()); time.sleep(0.06)
os.write(fd, b'\x03'); time.sleep(0.2); os.write(fd, b'\x03')
deadline = time.time() + 15
status = None
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, 9); status = 'killed'
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace'), 'frames': frames}))
`;
const fixturePath = resolve('tests/contracts/surfaces/policy-mcp-pty.fixture.mjs');
const DOWN = '\u001b[B', ESC = '\u001b', ENTER = '\r';
const ANY_COLOR = new RegExp(`${ESC}\\[(?:\\d+;)*(?:3[0-7]|38;)\\d*m`, 'u');
const COLOR_256 = new RegExp(`${ESC}\\[(?:\\d+;)*38;5;\\d+m`, 'u');
const words = {
  en: { scope: 'Choose an existing scope', groups: 'Capability groups', group: 'Spending', action: 'Grant this group',
    applied: 'Applied through policy administration', granted: 'Group granted', none: 'No group grant' },
  tr: { scope: 'Mevcut kapsamı seçin', groups: 'Yetki grupları', group: 'Harcama', action: 'Bu gruba izin ver',
    applied: 'Politika yönetimi', granted: 'Grup izni var', none: 'Grup izni yok' },
};
describe.skipIf(process.platform !== 'linux')('MCP permissions on the real Workline PTY and governed composition', () => {
  for (const [locale, width, color] of [['en', 100, false], ['tr', 100, false], ['tr', 100, true], ['en', 40, false]] as const) {
    it(`${locale}, ${width} columns, ${color ? 'theme colours' : 'NO_COLOR'}: slash selection, exact preview, grant and revoke without text fields`, async () => {
      const f = await runtime(), w = words[locale];
      const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: me[0]!, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
        scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['write_file'], writeOperationId: 'workspace.file.write',
        shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
      await writeFile(join(f.data, 'policy.json'), JSON.stringify({ ...template.policy,
        roles: [{ id: 'owner', permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(resource => resource.kind)) }] }), { mode: 0o600 });
      await writeFile(join(f.data, 'bindings.json'), JSON.stringify({ ...template.bindings,
        bindings: [{ id: 'owner', principals: me, roles: ['owner'], scopes: 'all' }] }), { mode: 0o600 });
      const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
      delete config.provider_spending; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
      const steps = [
        ['READY', [...'/policy', ENTER], 'start'],
        ['> scope', [ENTER], '+scopes'],
        [w.groups, [DOWN, DOWN, DOWN, DOWN, ENTER], '+groups'],
        [w.action, [ENTER], '+action'],
        ['mcp-cap-', ['ignored-text', '\u001b[6~', '\u001b[5~', ENTER], '+grant preview'],
        [w.groups, [DOWN, DOWN, DOWN, DOWN], '+granted groups'],
        [w.granted, [ENTER], '+grant state'],
        [w.action, [DOWN, ENTER], '+revoke action'],
        ['mcp-cap-', [ENTER], '+revoke preview'],
        [w.groups, [DOWN, DOWN, DOWN, DOWN], '+revoked groups'],
        [w.none, [ESC, ESC], '+revoked state'],
        ['READY', [], '+closed'],
      ];
      const env = { ...process.env, ...f.env, TERM: 'xterm-256color', ...(color ? { FORCE_COLOR: '3', NO_COLOR: '' } : { NO_COLOR: '1', FORCE_COLOR: '' }) };
      const result = await promisify(execFile)('python3', ['-c', DRIVER, JSON.stringify(steps), String(width), process.execPath, fixturePath, locale, f.project, color ? 'ansi256' : 'none'],
        { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stdout: String(error.stdout ?? '') }));
      const value = JSON.parse(result.stdout) as { timeout?: string; output: string; frames: [string, string][] };
      expect(value.timeout, value.output.slice(-3000)).toBeUndefined();
      const text = stripVTControlCharacters(value.output).replace(/\r/gu, '');
      expect(text).not.toMatch(/ERR:|TypeError|Error:/u);
      expect(text).toContain('provider-spend-account'); expect(text).toContain('budget-revision');
      expect(text).toContain('> ' + w.group);
      const lines = text.split('\n'), borders: string[] = [];
      for (let index = 1; index < lines.length; index++) {
        if (!lines[index]!.includes(locale === 'tr' ? 'MCP izinleri' : 'MCP permissions') || !lines[index - 1]!.startsWith('╭')) continue;
        borders.push(lines[index - 1]!);
        for (let next = index; next < lines.length; next++) { borders.push(lines[next]!); if (lines[next]!.startsWith('╰')) break; }
      }
      expect(borders.some(line => line.startsWith('╭'))).toBe(true);
      expect(Math.max(...borders.map(line => Array.from(line).length))).toBeLessThanOrEqual(Math.min(width, 80));
      if (!color) expect(value.output).not.toMatch(ANY_COLOR);
      else expect(value.output).toMatch(COLOR_256);
      const current = await inspectConfiguredMcpCapabilities(f.project, 'scope', { env: f.env });
      expect(current.groups.find(group => group.group.id === 'spend')).toMatchObject({ managed: 'none', effective: 'denied' });
      const changes = f.rows('SELECT record FROM audit_events').map(row => JSON.parse(String(row['record'])))
        .filter(row => row.event.subject.kind === 'authority-change'); expect(changes).toHaveLength(2);
      const directory = process.env['DECKENT_MCP_GRANT_FRAMES'];
      if (directory) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, `${locale}-${width}-${color}.txt`), text); }
    }, 120_000);
  }
});
