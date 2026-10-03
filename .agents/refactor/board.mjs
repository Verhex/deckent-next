// Development-host process board (owner 2026-10-03). Coordination data only: it grants no authority,
// is not an independent PASS, and a row's timestamp is not liveness proof. One JSON file outside Git/npm;
// each session writes only its own row, main reconciles the role map, writes happen only on change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const MAX = 256 * 1024, TEXT = 2000;
export const DEFAULT_SLOTS = Object.freeze([
  { slot: 'main', role: 'Ana oturum' }, { slot: 'review', role: 'Bağımsız inceleme' },
  { slot: 'analysis', role: 'Analiz' }, { slot: 'parallel-1', role: 'Paralel oturum 1' }]);
const STATUS = ['unassigned', 'active', 'waiting', 'blocked', 'closed'];
const ROW_FIELDS = ['name', 'channel', 'cwd', 'workRef', 'focus', 'status', 'waitingOn', 'next'];
const MAP_FIELDS = [...ROW_FIELDS, 'sessionId', 'role'];
const WORKER_KINDS = ['codex-exec', 'claude-subagent', 'claude-headless', 'cursor'];
const WORKER_STATUS = ['running', 'review', 'landed', 'canceled', 'failed'];
const WORKER_FIELDS = ['id', 'kind', 'model', 'worktree', 'card', 'status', 'since'];
const DOGFOOD_MODES = ['OFF', 'TRIAL', 'ON'];
const DOGFOOD_SOURCE = 'AGENTS.md · Current development phase';
const fail = (code, detail, extra = {}) => Object.assign(new Error(`${code}${detail ? `: ${detail}` : ''}`), { code, detail: detail ?? null, ...extra });
const text = (value, field) => { if (value === null) return null; if (typeof value !== 'string' || !value.trim() || value.length > TEXT) throw fail('BOARD_FIELD', field); return value; };
const stamp = (value, field) => { if (value === null) return null; if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('BOARD_FIELD', field); return value; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function safeRead(file, limit = MAX) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw fail('BOARD_FILE', 'expected a bounded regular file');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function emptyRow(slot, role) {
  const row = { slot, role, name: null, sessionId: null, channel: null, cwd: null, workRef: null, focus: null, status: 'unassigned', waitingOn: null, next: null, updatedAt: null };
  return slot === 'main' ? { ...row, workers: [] } : row;
}
function validate(board) {
  if (!plain(board) || board.schemaVersion !== 1 || !Number.isSafeInteger(board.revision) || board.revision < 0 || !Array.isArray(board.sessions)) throw fail('BOARD_SCHEMA');
  if (!plain(board.dogfood) || !DOGFOOD_MODES.includes(board.dogfood.mode) || typeof board.dogfood.source !== 'string') throw fail('BOARD_SCHEMA', 'dogfood');
  const slots = new Set();
  for (const row of board.sessions) {
    if (!plain(row) || typeof row.slot !== 'string' || slots.has(row.slot) || !STATUS.includes(row.status)) throw fail('BOARD_SCHEMA', 'session row');
    slots.add(row.slot);
    if (row.slot === 'main') { if (!Array.isArray(row.workers)) throw fail('BOARD_SCHEMA', 'workers'); row.workers.forEach(validateWorker); }
    else if ('workers' in row) throw fail('BOARD_SCHEMA', 'workers outside main');
  }
  if (!slots.has('main')) throw fail('BOARD_SCHEMA', 'main slot');
  return board;
}
function validateWorker(worker) {
  if (!plain(worker) || Object.keys(worker).some(key => !WORKER_FIELDS.includes(key))) throw fail('BOARD_FIELD', 'worker');
  for (const field of WORKER_FIELDS) if (!(field in worker)) throw fail('BOARD_FIELD', `worker.${field}`);
  for (const field of ['id', 'model', 'worktree', 'card']) text(worker[field], `worker.${field}`);
  if (!WORKER_KINDS.includes(worker.kind) || !WORKER_STATUS.includes(worker.status) || stamp(worker.since, 'worker.since') === null) throw fail('BOARD_FIELD', 'worker');
  return worker;
}
export function readBoard(file) {
  let parsed; try { parsed = JSON.parse(safeRead(file)); } catch (error) { if (error.code === 'BOARD_FILE' || error.code === 'ENOENT') throw error; throw fail('BOARD_SCHEMA', 'invalid JSON'); }
  return validate(parsed);
}
/** Writes `data` beside `file` and publishes it atomically; whatever fails after the temporary exists, that temporary is removed (PB-N1). */
export function writeAtomic(file, data, { create = false, mode = 0o600 } = {}) {
  if (!create && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) throw fail('BOARD_FILE', `${path.basename(file)} is not a regular file`);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (create) { fs.linkSync(temp, file); fs.unlinkSync(temp); } // link fails with EEXIST instead of replacing another writer's board
    else fs.renameSync(temp, file);
  } catch (error) { fs.rmSync(temp, { force: true }); throw error.code === 'EEXIST' ? fail('BOARD_EXISTS') : error; }
}
function write(file, board, { create = false } = {}) {
  const data = JSON.stringify(board, null, 1) + '\n';
  if (Buffer.byteLength(data) > MAX) throw fail('BOARD_FULL');
  writeAtomic(file, data, { create });
}
function locked(file, work) {
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw fail('BOARD_LOCKED', 'another writer holds the board lock; retry'); throw error; }
  try { return work(); } finally { fs.rmdirSync(lock); }
}
export function initBoard(file, { now = new Date() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const board = { schemaVersion: 1, revision: 0, updatedAt: now.toISOString(),
    dogfood: { mode: 'OFF', source: DOGFOOD_SOURCE, observedAt: now.toISOString() },
    sessions: DEFAULT_SLOTS.map(({ slot, role }) => emptyRow(slot, role)) };
  write(file, board, { create: true });
  return board;
}
function mutate(file, { session, revision }, now, change) {
  if (typeof session !== 'string' || !session.trim()) throw fail('BOARD_SESSION', 'pass --session <id>');
  if (!Number.isSafeInteger(revision)) throw fail('BOARD_REVISION', 'pass --revision <current board revision>');
  return locked(file, () => {
    const board = readBoard(file);
    if (board.revision !== revision) throw fail('BOARD_REVISION_CONFLICT', `board is at revision ${board.revision}; re-read and retry`, { currentRevision: board.revision });
    change(board, session);
    board.revision += 1; board.updatedAt = now.toISOString();
    write(file, validate(board));
    return { revision: board.revision, updatedAt: board.updatedAt };
  });
}
function applyRow(row, patch, allowed, now) {
  if (!plain(patch)) throw fail('BOARD_FIELD', 'patch must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'workers') { if (row.slot !== 'main' || !Array.isArray(value)) throw fail('BOARD_FIELD', 'workers belong to the main row'); row.workers = value.map(validateWorker); continue; }
    if (!allowed.includes(key)) throw fail('BOARD_FIELD', key);
    if (key === 'status') { if (!STATUS.includes(value) || value === 'unassigned') throw fail('BOARD_FIELD', 'status'); row.status = value; continue; }
    row[key] = text(value, key);
  }
  row.updatedAt = now.toISOString();
}
/** A session writes its own row. An unassigned row is claimed by the first writer; a different session id is refused. */
export function setOwnRow(file, slot, patch, { session, revision, now = new Date() } = {}) {
  return mutate(file, { session, revision }, now, board => {
    const row = board.sessions.find(item => item.slot === slot);
    if (!row) throw fail('BOARD_SLOT', slot);
    if (row.sessionId !== null && row.sessionId !== session) throw fail('BOARD_IDENTITY_MISMATCH', `row ${slot} belongs to another session; leave handoff information for main instead`);
    applyRow(row, patch, ROW_FIELDS, now);
    row.sessionId = session;
    if (row.status === 'unassigned') row.status = 'active';
  });
}
const requireMain = (board, session) => {
  const main = board.sessions.find(item => item.slot === 'main');
  if (main.sessionId === null || main.sessionId !== session) throw fail('BOARD_NOT_MAIN', 'only the main session reconciles the role map');
};
/** Main reconciles the role map: assigns or renames rows, adds slots and mirrors the owner's dogfood decision with its source. */
export function setMap(file, patch, { session, revision, now = new Date() } = {}) {
  return mutate(file, { session, revision }, now, board => {
    requireMain(board, session);
    if (!plain(patch) || Object.keys(patch).some(key => !['sessions', 'dogfood'].includes(key))) throw fail('BOARD_FIELD', 'map patch accepts sessions and dogfood');
    for (const [slot, rowPatch] of Object.entries(patch.sessions ?? {})) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(slot)) throw fail('BOARD_SLOT', slot);
      let row = board.sessions.find(item => item.slot === slot);
      if (!row) { if (slot === 'main') throw fail('BOARD_SLOT', slot); row = emptyRow(slot, text(rowPatch?.role ?? null, 'role') ?? slot); board.sessions.push(row); }
      const { sessionId, role, ...rest } = plain(rowPatch) ? rowPatch : (() => { throw fail('BOARD_FIELD', slot); })();
      applyRow(row, rest, MAP_FIELDS.filter(key => key !== 'sessionId' && key !== 'role'), now);
      if (sessionId !== undefined) row.sessionId = text(sessionId, 'sessionId');
      if (role !== undefined) row.role = text(role, 'role');
      if (row.sessionId === null) row.status = 'unassigned'; else if (row.status === 'unassigned') row.status = 'active';
    }
    if (patch.dogfood !== undefined) {
      const dogfood = patch.dogfood;
      if (!plain(dogfood) || !DOGFOOD_MODES.includes(dogfood.mode) || typeof dogfood.source !== 'string' || !dogfood.source.trim()) throw fail('BOARD_FIELD', 'dogfood needs mode and source');
      board.dogfood = { mode: dogfood.mode, source: text(dogfood.source, 'dogfood.source'), observedAt: stamp(dogfood.observedAt ?? now.toISOString(), 'dogfood.observedAt') };
    }
  });
}
/** Main removes a closed session from the map after the handoff was checked: the row returns to its empty slot, no residue. */
export function clearRow(file, slot, { session, revision, now = new Date() } = {}) {
  return mutate(file, { session, revision }, now, board => {
    requireMain(board, session);
    const index = board.sessions.findIndex(item => item.slot === slot);
    if (index < 0 || slot === 'main') throw fail('BOARD_SLOT', slot);
    const keep = DEFAULT_SLOTS.some(item => item.slot === slot);
    if (keep) board.sessions[index] = emptyRow(slot, board.sessions[index].role); else board.sessions.splice(index, 1);
  });
}
// ---- views: everything below is derived from the board; strings are escaped, nothing is executed.
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function age(iso, now) {
  if (!iso) return 'kayıt yok';
  const ms = now.getTime() - Date.parse(iso); if (!Number.isFinite(ms)) return 'geçersiz zaman';
  if (ms < 60_000) return 'az önce'; const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} dk önce`; const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} sa ${min % 60} dk önce`; return `${Math.floor(hours / 24)} gün önce`;
}
const STATUS_TR = { unassigned: 'Atanmadı', active: 'Çalışıyor', waiting: 'Bekliyor', blocked: 'Engelli', closed: 'Kapandı' };
const show = value => value ?? '—';
export function renderText(board, { now = new Date() } = {}) {
  const lines = [`Süreç panosu · rev ${board.revision} · ${age(board.updatedAt, now)} · yalnız pano verisi, canlılık/yetki kanıtı değildir`,
    `Dogfood: ${board.dogfood.mode} (kaynak: ${board.dogfood.source})`];
  for (const row of board.sessions) {
    lines.push(`- ${row.role} [${row.slot}] · ${STATUS_TR[row.status]} · ${row.name ?? 'kimlik yok'}${row.channel ? ` · kanal ${row.channel}` : ''} · ${age(row.updatedAt, now)}`);
    if (row.status !== 'unassigned') lines.push(`    kimlik: ${show(row.sessionId)} · cwd: ${show(row.cwd)}`,
      `    odak: ${show(row.focus)} · iş: ${show(row.workRef)} · bekliyor: ${show(row.waitingOn)} · sıradaki: ${show(row.next)}`);
    for (const worker of row.workers ?? []) lines.push(`    · işçi ${worker.id} (${worker.kind}, ${worker.model}) · ${worker.card} · ${worker.status} · ${age(worker.since, now)} · ${worker.worktree}`);
  }
  return lines.join('\n') + '\n';
}
export function renderHtml(board, { now = new Date() } = {}) {
  const cell = value => `<td>${escapeHtml(show(value))}</td>`;
  const rows = board.sessions.map(row => {
    const workers = (row.workers ?? []).map(w => `<li>${escapeHtml(w.id)} · ${escapeHtml(w.kind)} · ${escapeHtml(w.model)} · ${escapeHtml(w.card)} · ${escapeHtml(w.status)} · ${escapeHtml(age(w.since, now))} · <code>${escapeHtml(w.worktree)}</code></li>`).join('');
    return `<tr><td><strong>${escapeHtml(row.role)}</strong><br><small>${escapeHtml(row.slot)}${row.channel ? ` · kanal ${escapeHtml(row.channel)}` : ''}</small></td>` +
      `<td>${escapeHtml(row.name ?? 'kimlik yok')}<br><small>kimlik ${escapeHtml(show(row.sessionId))}</small><br><small>${escapeHtml(row.cwd ?? '')}</small></td>${cell(row.focus)}${cell(row.workRef)}` +
      `<td><span class="s ${escapeHtml(row.status)}">${STATUS_TR[row.status]}</span><br><small>${escapeHtml(age(row.updatedAt, now))}</small></td>${cell(row.waitingOn)}${cell(row.next)}</tr>` +
      (workers ? `<tr class="w"><td colspan="7"><ul>${workers}</ul></td></tr>` : '');
  }).join('');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deckent süreç panosu</title><style>
:root{color-scheme:light dark;--fg:#1b1b1b;--bg:#fff;--mute:#666;--line:#ddd;--wait:#b26a00;--block:#b3261e;--ok:#1b6e3a}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#141414;--mute:#aaa;--line:#333}}
body{margin:0;padding:16px;font:15px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg)}h1{font-size:1.2rem;margin:0 0 4px}
p.m{color:var(--mute);margin:0 0 12px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}
th{font-size:.8rem;color:var(--mute)}small{color:var(--mute)}tr.w td{padding-top:0}ul{margin:0;padding-left:1.2em}
.s.waiting{color:var(--wait)}.s.blocked{color:var(--block)}.s.active{color:var(--ok)}.s.unassigned,.s.closed{color:var(--mute)}
@media (max-width:720px){table,thead,tbody,tr,td,th{display:block}th{display:none}td{border:0;padding:2px 0}tr{border-bottom:1px solid var(--line);padding:8px 0}}
</style></head><body><h1>Süreç panosu</h1>
<p class="m">rev ${board.revision} · ${escapeHtml(age(board.updatedAt, now))} · yalnız pano verisi, canlılık/yetki kanıtı değildir · Dogfood: <strong>${escapeHtml(board.dogfood.mode)}</strong> <small>(kaynak: ${escapeHtml(board.dogfood.source)})</small></p>
<table><thead><tr><th>Rol</th><th>Oturum / kimlik</th><th>Odak</th><th>İş</th><th>Durum</th><th>Beklediği</th><th>Sıradaki</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>\n`;
}
// Owner report (owner 2026-10-03): the agreed short flow format — result, flow (before → now → remaining, who holds), impact,
// open limits, decisions/commands for the owner, next step and who, collapsed evidence, plus the live board. Plain language
// (ISO 24495-1 reader-first approach adapted; no conformance claim). One file, overwritten; delivered over localhost.
const REPORT_KEYS = ['title', 'headline', 'impact', 'flow', 'limits', 'decisions', 'next', 'details'];
function validateReport(body) {
  const bad = detail => { throw fail('BOARD_REPORT', detail); };
  if (!plain(body) || Object.keys(body).some(key => !REPORT_KEYS.includes(key))) bad('report body accepts only ' + REPORT_KEYS.join(', '));
  for (const key of ['title', 'headline', 'impact']) if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > TEXT) bad(key);
  if (!Array.isArray(body.flow) || body.flow.length < 2 || body.flow.length > 6) bad('flow needs 2–6 steps');
  for (const step of body.flow) if (!plain(step) || ['label', 'text', 'who'].some(key => typeof step[key] !== 'string' || !step[key].trim() || step[key].length > TEXT)) bad('flow step');
  for (const key of ['limits', 'decisions', 'details']) if (!Array.isArray(body[key]) || body[key].some(item => typeof item !== 'string' || !item.trim() || item.length > TEXT)) bad(key);
  if (!plain(body.next) || typeof body.next.who !== 'string' || typeof body.next.text !== 'string' || !body.next.who.trim() || !body.next.text.trim()) bad('next');
  return body;
}
export function renderOwnerReport(input, board, { now = new Date() } = {}) {
  const body = validateReport(input), list = items => items.length ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>Yok.</p>';
  const flow = body.flow.map((step, index) => `${index ? '<div class="arrow" aria-hidden="true">→</div>' : ''}<div class="step"><div class="t">${escapeHtml(step.label)}</div>`
    + `<div>${escapeHtml(step.text)}</div><div class="who">Kimde: ${escapeHtml(step.who)}</div></div>`).join('');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(body.title)}</title><style>
:root{color-scheme:light dark;--fg:#1b1b1b;--bg:#fff;--mute:#666;--line:#ddd;--warn:#b26a00}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#141414;--mute:#aaa;--line:#333}}
body{margin:0;padding:16px;font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}main{max-width:960px;margin:0 auto}
h1{font-size:1.3rem;margin:0}h2{font-size:1rem;margin:22px 0 6px}.lead{font-size:1.1rem}.m{color:var(--mute);font-size:.85em}
.flow{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}.step{flex:1 1 170px;border:1px solid var(--line);border-radius:10px;padding:10px}
.step .t{font-weight:700}.step .who{margin-top:6px;font-size:.85em;color:var(--mute)}.arrow{align-self:center;color:var(--mute)}
.decide li{color:var(--warn);font-weight:600}pre{white-space:pre-wrap;font-size:.85em;border:1px solid var(--line);border-radius:8px;padding:10px}
@media (max-width:640px){.arrow{display:none}}
</style></head><body><main><h1>${escapeHtml(body.title)}</h1><p class="m">${escapeHtml(now.toISOString().slice(0, 16).replace('T', ' '))}Z · sonuç → etki → açık sınır → karar → kimde/sıradaki</p>
<p class="lead"><strong>${escapeHtml(body.headline)}</strong></p>
<h2>Akış</h2><div class="flow">${flow}</div>
<h2>Sana etkisi</h2><p>${escapeHtml(body.impact)}</p>
<h2>Açık sınır</h2>${list(body.limits)}
<h2>Senden karar / komut</h2><div class="decide">${list(body.decisions)}</div>
<h2>Sıradaki adım · ${escapeHtml(body.next.who)}</h2><p>${escapeHtml(body.next.text)}</p>
<details><summary>Kanıt ve ayrıntı</summary>${list(body.details)}</details>
<details><summary>Süreç panosu</summary><pre>${escapeHtml(renderText(board, { now }))}</pre></details>
</main></body></html>\n`;
}
// ---- CLI
function configuration() {
  const cfg = JSON.parse(safeRead(path.join(here, 'workspace.json'), 8192));
  if (cfg.version !== 1 || typeof cfg.board !== 'string') throw fail('BOARD_CONFIG', 'workspace.json needs version 1 and board');
  return { file: path.resolve(here, cfg.board), html: path.resolve(here, cfg.boardHtml ?? cfg.board.replace(/\.json$/, '.html')),
    report: cfg.ownerReport ? path.resolve(here, cfg.ownerReport) : null };
}
function options(args) {
  const out = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { out[args[i].slice(2)] = args[i + 1]; i++; } else out.positional.push(args[i]);
  }
  out.session ??= process.env.DECKENT_BOARD_SESSION;
  if (out.revision !== undefined) out.revision = Number(out.revision);
  return out;
}
async function body(source) {
  if (source === '-') { let data = ''; for await (const chunk of process.stdin) { data += chunk; if (Buffer.byteLength(data) > MAX) throw fail('BOARD_FULL'); } return JSON.parse(data); }
  return JSON.parse(safeRead(source));
}
const USAGE = 'Usage: init | get [SLOT] | show | render [--out PATH] | report BODY_FILE|- | set-own-row SLOT BODY_FILE|- --session ID --revision N | set-map BODY_FILE|- --session ID --revision N | clear-row SLOT --session ID --revision N';
async function main() {
  const [command, ...rest] = process.argv.slice(2); const opts = options(rest); const cfg = configuration();
  const print = value => console.log(JSON.stringify(value, null, 1));
  switch (command) {
    case 'init': return print(initBoard(cfg.file));
    case 'get': { const board = readBoard(cfg.file); return print(opts.positional[0] ? board.sessions.find(s => s.slot === opts.positional[0]) ?? (() => { throw fail('BOARD_SLOT', opts.positional[0]); })() : board); }
    case 'show': return process.stdout.write(renderText(readBoard(cfg.file)));
    case 'render': { const out = opts.out ? path.resolve(opts.out) : cfg.html; const html = renderHtml(readBoard(cfg.file));
      writeAtomic(out, html, { create: !fs.existsSync(out) }); return print({ written: out, bytes: Buffer.byteLength(html) }); }
    case 'report': { const [source] = opts.positional; if (!source || !cfg.report) throw fail('BOARD_USAGE', 'report BODY_FILE|- (workspace.json ownerReport)');
      const html = renderOwnerReport(await body(source), readBoard(cfg.file)); fs.mkdirSync(path.dirname(cfg.report), { recursive: true });
      writeAtomic(cfg.report, html, { create: !fs.existsSync(cfg.report) }); return print({ written: cfg.report, bytes: Buffer.byteLength(html) }); }
    case 'set-own-row': { const [slot, source] = opts.positional; if (!slot || !source) throw fail('BOARD_USAGE', USAGE);
      return print(setOwnRow(cfg.file, slot, await body(source), opts)); }
    case 'set-map': { const [source] = opts.positional; if (!source) throw fail('BOARD_USAGE', USAGE); return print(setMap(cfg.file, await body(source), opts)); }
    case 'clear-row': { const [slot] = opts.positional; if (!slot) throw fail('BOARD_USAGE', USAGE); return print(clearRow(cfg.file, slot, opts)); }
    default: throw fail('BOARD_USAGE', USAGE);
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ error: error.code ?? 'BOARD_ERROR', detail: error.detail ?? error.message, currentRevision: error.currentRevision })); process.exitCode = 1; });
}
