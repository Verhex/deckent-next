#!/usr/bin/env node
// Enables the tracked hooks for THIS checkout. core.hooksPath is relative ("scripts/git-hooks"), so every worktree
// resolves it against its own root; a worktree on a branch without that directory simply has no hooks.
// With extensions.worktreeConfig enabled the setting is stored per worktree (config.worktree); otherwise the shared
// .git/config is used. We never enable that extension ourselves (older git refuses such repositories).
import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
const perWorktree = git('config', '--get', '--type=bool', 'extensions.worktreeConfig').stdout.trim() === 'true';
for (const hook of ['pre-commit', 'pre-push']) chmodSync(`scripts/git-hooks/${hook}`, 0o755);
const set = git('config', ...(perWorktree ? ['--worktree'] : []), 'core.hooksPath', 'scripts/git-hooks');
if (set.status !== 0) { process.stderr.write(set.stderr); process.exit(1); }
process.stdout.write(`hooks installed: core.hooksPath=scripts/git-hooks (${perWorktree ? 'this worktree only' : 'shared repository config; relative, resolved per worktree'})\n`);
