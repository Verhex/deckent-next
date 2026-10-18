#!/usr/bin/env node
// Host memory lint (Jev g3-hafiza-yasam, 2026-10-18): read-only warnings for an agent host memory directory.
// The directory is never written. It comes from --dir or DECKENT_HOST_MEMORY_DIR; with neither, or when the
// directory is missing (CI, other hosts), the lint is skipped. Warnings are a report: the exit code stays 0.
// Pruning or rewriting the memory is a main-session task; this tool only makes the lifecycle visible.
//
//   node .agents/refactor/memory-lint.mjs [--dir PATH] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEMORY_DIR_ENV = 'DECKENT_HOST_MEMORY_DIR';
const INDEX = 'MEMORY.md';
const MAX_BYTES = 1024 * 1024;
const stem = value => value.trim().replace(/^\[\[|\]\]$/gu, '').split(/[|#]/u)[0].trim().replace(/\.md$/u, '');
const unquote = value => value.trim().replace(/^(['"])(.*)\1$/u, '$2');

/** Minimal frontmatter reader: top-level scalars, `metadata:` children, and `supersededBy` as scalar, [a, b] or `- a` list. */
export function frontmatter(text) {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const data = { metadata: {} };
  let parent = null;
  for (const line of lines.slice(1, end)) {
    const child = /^\s+([A-Za-z][\w-]*):\s*(.*)$/u.exec(line), item = /^\s+-\s+(.+)$/u.exec(line), top = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (top) {
      const [, key, raw] = top;
      parent = raw === '' ? key : null;
      if (key === 'metadata') continue;
      data[key] = key === 'supersededBy' ? (raw === '' ? [] : /^\[.*\]$/u.test(raw.trim()) ? raw.trim().slice(1, -1).split(',').map(unquote).filter(Boolean) : [unquote(raw)]) : unquote(raw);
    } else if (child && parent === 'metadata') data.metadata[child[1]] = unquote(child[2]);
    else if (item && parent === 'supersededBy') data.supersededBy.push(unquote(item[1]));
  }
  return data;
}

/** Read-only lint of one memory directory. Returns { skipped, reason?, dir, files, lifecycle?, warnings[] }; never throws for content. */
export function lintMemory(dir) {
  if (!dir) return { skipped: true, reason: `no directory given (--dir or ${MEMORY_DIR_ENV})`, dir: null, files: 0, warnings: [] };
  let stat;
  try { stat = fs.statSync(dir); } catch { return { skipped: true, reason: 'directory not found', dir, files: 0, warnings: [] }; }
  if (!stat.isDirectory()) return { skipped: true, reason: 'not a directory', dir, files: 0, warnings: [] };
  const warnings = [];
  const warn = (code, file, detail, line = null) => warnings.push({ code, file, line, detail });
  const texts = new Map();
  const lifecycle = { status: 0, supersededBy: 0 };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile()) { warn('not-regular-file', entry.name, 'symlinks and other entries are not read'); continue; }
    const file = path.join(dir, entry.name);
    if (fs.statSync(file).size > MAX_BYTES) { warn('too-large', entry.name, `larger than ${MAX_BYTES} bytes; not read`); continue; }
    texts.set(entry.name, fs.readFileSync(file, 'utf8'));
  }
  const names = new Set([...texts.keys()].filter(name => name !== INDEX).map(name => name.replace(/\.md$/u, '')));
  const exists = name => names.has(name);
  // 1. Index: every link target exists, every memory file is listed.
  const index = texts.get(INDEX);
  const listed = new Set();
  if (index === undefined) warn('index-missing', INDEX, 'no MEMORY.md index');
  else index.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/gu)) {
      const target = decodeURI(match[1].split('#')[0]);
      if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
      const name = path.posix.normalize(target);
      listed.add(name);
      if (!texts.has(name) && !fs.existsSync(path.join(dir, name))) warn('index-broken-link', INDEX, `links ${target}, which does not exist`, i + 1);
    }
  });
  if (index !== undefined) for (const name of names) if (!listed.has(`${name}.md`)) warn('index-unlisted', `${name}.md`, 'file is not listed in MEMORY.md');
  // 2. Per file: frontmatter fields, [[name]] links, lifecycle fields.
  for (const [file, text] of texts) {
    text.split('\n').forEach((line, i) => {
      for (const match of line.matchAll(/\[\[([^\]]+)\]\]/gu)) if (!exists(stem(match[1]))) warn('wikilink-broken', file, `[[${match[1]}]] has no ${stem(match[1])}.md`, i + 1);
    });
    if (file === INDEX) continue;
    const data = frontmatter(text);
    if (!data) { warn('frontmatter-missing', file, 'no --- frontmatter block'); continue; }
    for (const field of ['name', 'description']) if (!data[field]) warn('frontmatter-field', file, `missing ${field}`);
    if (!data.metadata.type) warn('frontmatter-field', file, 'missing metadata.type');
    if (data.name && data.name !== file.replace(/\.md$/u, '')) warn('name-mismatch', file, `name "${data.name}" differs from the file stem; [[name]] links resolve by file stem`);
    if (data.status) lifecycle.status++;
    if (data.supersededBy?.length) lifecycle.supersededBy++;
    for (const target of data.supersededBy ?? []) if (!exists(stem(target))) warn('superseded-broken', file, `supersededBy ${target} has no ${stem(target)}.md`);
    if (/^superseded$/iu.test(data.status ?? '') && !(data.supersededBy ?? []).length) warn('superseded-without-target', file, 'status superseded needs supersededBy');
  }
  return { skipped: false, dir, files: texts.size, lifecycle, warnings };
}

export function formatReport(result) {
  if (result.skipped) return `memory-lint: skipped (${result.reason})\n`;
  const counts = Object.entries(Object.groupBy(result.warnings, w => w.code)).map(([code, list]) => `${code} ${list.length}`).join(', ');
  return [...result.warnings.map(w => `memory-lint: ${w.code} ${w.file}${w.line ? `:${w.line}` : ''} — ${w.detail}`),
    `memory-lint: ${result.files} file(s), ${result.warnings.length} warning(s)${counts ? ` (${counts})` : ''}; lifecycle fields: status ${result.lifecycle.status}, supersededBy ${result.lifecycle.supersededBy}; read-only, exit 0`].join('\n') + '\n';
}

function main(argv, env) {
  const at = argv.indexOf('--dir');
  if (at > -1 && (!argv[at + 1] || argv[at + 1].startsWith('--'))) { process.stderr.write('memory-lint: --dir needs a path\n'); return 2; }
  const dir = at > -1 ? path.resolve(argv[at + 1]) : env[MEMORY_DIR_ENV] ? path.resolve(env[MEMORY_DIR_ENV]) : null;
  const result = lintMemory(dir);
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2), process.env);
