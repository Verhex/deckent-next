import { describe, expect, it } from 'vitest';
import { checkAwkProgram, checkSedScript, classifyReadOnlyShellCommand, classifyShellRisk, type ShellPathContext, type ShellReasonCode,
  type ShellRisk } from '#engine/index.js';

// Legacy parity (deckent-dev tests/core/shell-readonly-classifier.test.ts and tests/agent/shell-risk.test.ts @a4ed4ea47^): grammar and
// scanner cases run over a path check that accepts every path; path containment is covered against a real workspace in the adapter test.
const anyPath: ShellPathContext = { async check() { return { ok: true }; } };
const classify = (command: string) => classifyReadOnlyShellCommand(command, anyPath);

describe('read-only shell classification (T-L4 slice 3a, POSIX)', () => {
  it.each<[string, 'none' | 'low']>([
    ["sed -n '1,50p' docs/MASTER-PLAN.md", 'none'], ["sed -n '10,20p' file | head -5", 'none'], ["sed -e 's/a/b/g' -e '/x/d' f", 'none'],
    ["sed -n '/start/,/end/p' f", 'none'], ["sed '1!G;h;$!d' f", 'none'], ["awk 'NR>=10 && NR<=20' file", 'none'], ["awk -F'|' '{print $1}' file", 'none'],
    ["awk '{ if (x > 3) print }' f", 'none'], ['cat f | grep -n foo | wc -l', 'none'], ['grep "foo$" file', 'none'], ['grep -rn foo src', 'low'],
    ['grep -l foo src/*.ts', 'none'], ['grep -r x . 2>&1 | head', 'low'], ['cat f 2>/dev/null', 'none'], ['wc -l < f', 'none'], ['head -c 1000 f', 'none'],
    ['tail -n +5 f', 'none'], ['ls -la', 'none'], ['ls -R src', 'low'], ["find . -name '*.ts'", 'low'],
    ["find . -name '*.md' -path '*docs*' -not -path '*/node_modules/*'", 'low'], ['find . \\( -name a -o -name b \\)', 'low'],
    ["jq -r '.[] | .name' f.json", 'none'], ['sort -u f | uniq -c', 'none'], ['cut -d, -f1 f | tr a-z A-Z', 'none'], ['nl -ba f', 'none'], ['stat f', 'none'],
    ['du -sh .', 'low'], ['diff a b', 'none'], ['git status', 'low'], ['git log --oneline -20', 'low'], ['git log --pretty=format:%H -5', 'low'],
    ['git diff -M --stat', 'low'], ['git diff HEAD~1 -- src/x.ts', 'low'], ['git branch -vv', 'low'], ["git branch --list 'feat/*'", 'low'],
    ['git show HEAD:src/a.ts', 'low'], ['git blame -L 10,20 src/a.ts', 'low'], ['git rev-parse --show-toplevel', 'low'], ['git ls-files src | head', 'low'],
    ['git stash list', 'low'], ['git remote -v', 'low'], ['git config --get user.name', 'low'], ['git tag -l "v*"', 'low'], ['echo hello', 'none'],
    ['echo "> literal"', 'none'], ['cat f # comment', 'none'], ['cat f; echo done', 'none'], ['cat f && cat g || echo x', 'none'], ['ls -la; pwd; whoami', 'none'],
    ['node --version', 'none'], ['npm -v', 'none'], ['env', 'low'], ['printenv PATH', 'low'], ['ps aux', 'low'], ['df -h', 'low'], ['which node', 'none'],
    ['rg needle src', 'low'], ['less README.md', 'none'], ["cat 'file with space.txt'", 'none'], ['cat -- -file', 'none'], ['tr -d "\\n" < f', 'none'],
  ])('%s → read-only (risk %s)', async (command, risk) => {
    const verdict = await classify(command);
    expect(verdict, command).toMatchObject({ readOnly: true, risk, reasonCode: 'READ_ONLY' });
    expect(verdict.stageCount).toBeGreaterThan(0);
  });

  it.each<[string, ShellReasonCode]>([
    ["sed -n '1p' f; rm -rf x", 'PROGRAM_NOT_ALLOWLISTED'], ['cat f > g', 'OUTPUT_REDIRECTION'], ['echo hello > file', 'OUTPUT_REDIRECTION'],
    ['cat input >> output', 'OUTPUT_REDIRECTION'], ['grep x $(rm y)', 'COMMAND_SUBSTITUTION'], ['echo `id`', 'COMMAND_SUBSTITUTION'],
    ['find . -exec rm {} \\;', 'BRACE_EXPANSION'], ["find . -exec rm '{}' \\;", 'MUTATING_FLAG'], ['find . -execdir sh -c x', 'MUTATING_FLAG'],
    ['find . -ok rm', 'MUTATING_FLAG'], ['find . -delete', 'MUTATING_FLAG'], ["awk '{system(\"id\")}' file", 'SCRIPT_UNSAFE'],
    ["awk '{print $1 > \"out\"}' file", 'SCRIPT_UNSAFE'], ["awk 'BEGIN{while((\"id\"|getline l)>0)print l}'", 'SCRIPT_UNSAFE'], ['awk -f s.awk f', 'MUTATING_FLAG'],
    ["sed -i 's/a/b/' f", 'MUTATING_FLAG'], ["sed -n 's/a/b/w out' f", 'SCRIPT_UNSAFE'], ['git push origin main', 'GIT_SUBCOMMAND_NOT_READ_ONLY'],
    ['git branch new', 'GIT_SUBCOMMAND_NOT_READ_ONLY'], ['git log --output=x', 'GIT_SUBCOMMAND_NOT_READ_ONLY'], ['git -c core.pager=cat log', 'FLAG_NOT_ALLOWLISTED'],
    ['git grep -O vim foo', 'GIT_SUBCOMMAND_NOT_READ_ONLY'], ['git stash drop', 'GIT_SUBCOMMAND_NOT_READ_ONLY'], ['git config user.name x', 'GIT_SUBCOMMAND_NOT_READ_ONLY'],
    ['git tag v1', 'GIT_SUBCOMMAND_NOT_READ_ONLY'], ['git remote add x y', 'GIT_SUBCOMMAND_NOT_READ_ONLY'], ['git worktree add x', 'GIT_SUBCOMMAND_NOT_READ_ONLY'],
    ['git symbolic-ref -d refs/x', 'GIT_SUBCOMMAND_NOT_READ_ONLY'], ['cat f | tee g', 'OUTPUT_TEE'], ['cat f | xargs rm', 'XARGS'], ['sudo cat f', 'PRIVILEGE_ESCALATION'],
    ["node -e 'x'", 'INTERPRETER'], ['cat f | bash', 'INTERPRETER'], ['cat f | python', 'INTERPRETER'], ['eval cat f', 'EVAL'], ['env sh -c true', 'EVAL'],
    ['FOO=bar cat f', 'ENV_ASSIGNMENT'], ['cat f &', 'BACKGROUND_JOB'], ['(cat f)', 'SUBSHELL'], ['cat {a,b}', 'BRACE_EXPANSION'], ['cat <<EOF\nhi\nEOF', 'HEREDOC'],
    ['cat f |& head', 'PIPE_STDERR'], ['echo $HOME', 'VARIABLE_EXPANSION'], ['cat "$FILE"', 'VARIABLE_EXPANSION'], ['sort -o out f', 'MUTATING_FLAG'],
    ["sort '--output=out' f", 'MUTATING_FLAG'], ["sort '-o' out f", 'MUTATING_FLAG'], ['sort \\-o out f', 'MUTATING_FLAG'], ["sort ''-o out f", 'MUTATING_FLAG'],
    ["sed '-i' 's/a/b/' f", 'MUTATING_FLAG'], ["find . '-delete'", 'MUTATING_FLAG'], ["git log '--output=x'", 'GIT_SUBCOMMAND_NOT_READ_ONLY'],
    ['uniq f out', 'OUTPUT_FILE_POSITIONAL'], ['cat f | sort -o /dev/stdout', 'MUTATING_FLAG'], ['date -s x', 'MUTATING_FLAG'], ['rg --pre cat x', 'MUTATING_FLAG'],
    ['curl http://x', 'PROGRAM_NOT_ALLOWLISTED'], ['yes', 'PROGRAM_NOT_ALLOWLISTED'], ['/usr/bin/cat f', 'PROGRAM_PATH'], ['./cat f', 'PROGRAM_PATH'],
    ['', 'EMPTY_COMMAND'], ['   ', 'EMPTY_COMMAND'], ['echo "unterminated', 'UNPARSEABLE'],
  ])('%s → not read-only (%s)', async (command, reasonCode) => {
    expect(await classify(command), command).toMatchObject({ readOnly: false, risk: null, reasonCode });
  });

  it('refuses the PowerShell dialect as not ported, so a Windows host asks for every shell command', async () => {
    expect(await classifyReadOnlyShellCommand('Get-Content f', anyPath, 'powershell')).toMatchObject({ readOnly: false, reasonCode: 'UNSUPPORTED_DIALECT' });
  });

  it('asks the path check about every path argument, input redirection and path-valued option, and stops at its refusal', async () => {
    const asked: string[] = [];
    const recording: ShellPathContext = { async check(word) {
      asked.push(word.text);
      return word.text === 'secret' ? { ok: false, reasonCode: 'PATH_PROTECTED', detail: 'secret' } : { ok: true };
    } };
    expect(await classifyReadOnlyShellCommand('wc -l < in && grep -f pats.txt x a b && git -C sub log -- p', recording)).toMatchObject({ readOnly: true });
    // With -f the patterns come from the file, so the first positional (x) is a path too.
    expect(asked).toEqual(['in', 'pats.txt', 'x', 'a', 'b', 'sub', 'p']);
    expect(await classifyReadOnlyShellCommand('cat ok secret later', recording)).toMatchObject({ readOnly: false, reasonCode: 'PATH_PROTECTED', detail: 'secret' });
  });
});

describe('script grammars (legacy parity)', () => {
  it('sed: accepts print/address scripts, rejects write/exec/read commands', () => {
    for (const ok of ['1,50p', '/a/,/b/{p;q}', 's/a/b/g;s/c/d/', '$=', '1!G;h;$!d']) expect(checkSedScript(ok), ok).toBeNull();
    for (const [script, code] of [['s/a/b/e', 'SCRIPT_UNSAFE'], ['w out', 'SCRIPT_UNSAFE'], ['r /etc/passwd', 'SCRIPT_UNSAFE'], ['1e id', 'SCRIPT_UNSAFE'],
      ['1k', 'SCRIPT_UNPARSEABLE'], ['s/a/b', 'SCRIPT_UNPARSEABLE']] as const) expect(checkSedScript(script), script).toBe(code);
  });
  it('awk: distinguishes comparison `>` from redirection, rejects pipes/system/getline', () => {
    for (const ok of ['NR>=10 && NR<=20', '{ if (a > b) print }', '$3 > 100 { print $1 }', '/foo|bar/ { n++ } END { print n }']) expect(checkAwkProgram(ok), ok).toBeNull();
    for (const [program, code] of [['{ print > "file" }', 'SCRIPT_UNSAFE'], ['{ print | "sort" }', 'SCRIPT_UNSAFE'], ['{ system("id") }', 'SCRIPT_UNSAFE'],
      ['{ "id" | getline x }', 'SCRIPT_UNSAFE'], ['@load "x"', 'SCRIPT_UNSAFE'], ['{ print "unterminated }', 'SCRIPT_UNPARSEABLE']] as const) expect(checkAwkProgram(program), program).toBe(code);
  });
});

describe('shell risk tiers (legacy parity)', () => {
  const risk = async (command: string) => classifyShellRisk(command, await classify(command)).risk;
  it.each<[string, ShellRisk]>([
    ...['ls -la', 'cat file.txt', 'head -n 2 file', 'tail -f log', 'less README.md', 'grep needle file', 'rg needle src', 'find src -name "*.ts"', 'wc -l file',
      'stat file', 'file archive.zip', 'pwd', 'which node', 'whoami', 'env', 'env FOO=bar', 'printenv PATH', 'du -sh .', 'df -h', 'ps aux', 'echo hello',
      'node --version', 'npm -v', 'npx --version', 'git status', 'git log -1', 'git diff --stat', 'git show HEAD', 'git branch', 'git branch --list "feat/*"']
      .map(command => [command, 'safe-read'] as [string, ShellRisk]),
    ...['rm -r x', 'rm -f x', 'rm -rf x', 'rm -fr x', 'rm --recursive x', 'rm --force x', 'rmdir empty', 'git push --force origin main', 'git push -f origin main',
      'git reset --hard HEAD', 'git clean -fd', 'chmod -R 700 dir', 'chown -R me dir', 'dd if=/dev/zero of=x', 'mkfs.ext4 /dev/x', 'shred secret',
      'truncate -s 0 file', 'kill 123', 'pkill node', 'killall node', 'docker rm box', 'docker rmi image', 'docker system prune', 'deckent kill',
      'deckent cleanup', 'deckent recover'].map(command => [command, 'destructive'] as [string, ShellRisk]),
    ...['curl https://example.test', 'rm file.txt', 'git branch new-feature', 'node script.js', 'npm test', 'npx tsc', 'env sh -c true', 'find . -delete',
      'find . -exec echo {} ;', 'find . -execdir echo {} ;', '', 'echo "unterminated'].map(command => [command, 'modify'] as [string, ShellRisk]),
    ['ls && npm test || cat error.log', 'modify'], ['pwd; rm -rf /tmp/x', 'destructive'], ['cat file | wc -l', 'safe-read'], ['echo $(rm -rf /tmp/x)', 'destructive'],
    ['echo `npm test`', 'modify'], ['echo hello > file', 'modify'], ['cat input >> output', 'modify'], ['cat input | tee output', 'modify'],
    ['echo "> literal"', 'safe-read'], ["mkdir -p /tmp/deckent-x && printf 'test' > /tmp/deckent-x/file.txt", 'modify'],
  ])('%s → %s', async (command, expected) => { expect(await risk(command), command).toBe(expected); });
});
