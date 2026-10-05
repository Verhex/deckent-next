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
/** A session writes its own row; a different session may replace a closed row, retaining the previous identity. */
export function setOwnRow(file, slot, patch, { session, revision, now = new Date() } = {}) {
  return mutate(file, { session, revision }, now, board => {
    const index = board.sessions.findIndex(item => item.slot === slot);
    let row = board.sessions[index];
    if (!row) throw fail('BOARD_SLOT', slot);
    if (row.sessionId !== null && row.sessionId !== session) {
      if (row.status !== 'closed') throw fail('BOARD_IDENTITY_MISMATCH', `row ${slot} belongs to another session; leave handoff information for main instead`);
      row = { ...emptyRow(slot, row.role), previousSessionId: row.sessionId, takenOverAt: now.toISOString() };
      board.sessions[index] = row;
    }
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
  const expected = board.sessions.filter(row => row.waitingOn);
  return dashboardPage('Deckent süreç panosu', board, now, `<header><h1>Süreç panosu</h1>${boardNote(board)}</header><main>
${dashboardSummary(board, now)}
<section aria-labelledby="bekleyen"><h2 id="bekleyen">Beklenenler · ${expected.length}</h2><ul class="cards">${expected.map(row =>
    `<li class="card decide"><strong>${escapeHtml(row.name ?? row.role)}</strong><p>${escapeHtml(row.waitingOn)}</p><p>Sıradaki: ${compactText(show(row.next))}</p></li>`).join('') || '<li class="m">Beklenen kayıt yok.</li>'}</ul></section>
<section aria-labelledby="akis"><h2 id="akis">İş akışı</h2>${panelFlow(board)}</section>
<section aria-labelledby="kim"><h2 id="kim">Kim ne yapıyor</h2>${panelPeople(board, now)}</section>
<section aria-labelledby="dagilim"><h2 id="dagilim">İşçi durum dağılımı</h2>${workerChart(board)}</section></main>`);
}
// Owner report (owner 2026-10-03): the agreed flow report as an interactive owner panel — four sections the owner chose
// (what is expected from the owner, who does what, flow and version, where things are), workers derived from the board,
// copyable commands/paths, collapsed evidence and the board text. Plain language (ISO 24495-1 reader-first approach adapted;
// no conformance claim). One file, overwritten, served on localhost. The only script is the fixed PANEL_SCRIPT below: it carries
// no data, is pinned by a CSP hash, and reads copy targets from escaped attributes.
const REPORT_KEYS = ['title', 'headline', 'impact', 'flow', 'limits', 'decisions', 'next', 'details', 'version', 'commands', 'places'];
const CI_STATES = ['ok', 'warn', 'fail'];
const filled = value => typeof value === 'string' && value.trim() && value.length <= TEXT;
// A place is a path or command to copy, or a link; the only links are https and this host's loopback page.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i, LINK = /^(https:\/\/[^\s"'<>]+|http:\/\/127\.0\.0\.1(:\d+)?(\/[^\s"'<>]*)?)$/;
function validateReport(body) {
  const bad = detail => { throw fail('BOARD_REPORT', detail); };
  const items = (key, fields) => body[key] === undefined || (Array.isArray(body[key]) && body[key].length <= 20
    && body[key].every(item => plain(item) && Object.keys(item).every(field => fields.includes(field)) && fields.slice(0, 2).every(field => filled(item[field]))
      && fields.slice(2).every(field => item[field] === undefined || filled(item[field])))) || bad(key);
  if (!plain(body) || Object.keys(body).some(key => !REPORT_KEYS.includes(key))) bad('report body accepts only ' + REPORT_KEYS.join(', '));
  for (const key of ['title', 'headline', 'impact']) if (!filled(body[key])) bad(key);
  if (!Array.isArray(body.flow) || body.flow.length < 2 || body.flow.length > 6) bad('flow needs 2–6 steps');
  for (const step of body.flow) if (!plain(step) || ['label', 'text', 'who'].some(key => !filled(step[key]))) bad('flow step');
  for (const key of ['limits', 'decisions', 'details']) if (!Array.isArray(body[key]) || body[key].some(item => !filled(item))) bad(key);
  if (!plain(body.next) || !filled(body.next.who) || !filled(body.next.text)) bad('next');
  if (body.version !== undefined && (!plain(body.version) || Object.keys(body.version).some(key => !['live', 'n1', 'ci', 'ciState', 'mainSha'].includes(key))
    || !['live', 'n1', 'ci'].every(key => filled(body.version[key])) || (body.version.ciState !== undefined && !CI_STATES.includes(body.version.ciState)))) bad('version needs live, n1, ci (ciState ok|warn|fail)');
  if (body.version?.mainSha !== undefined && (typeof body.version.mainSha !== 'string' || !/^[a-f0-9]{8,40}$/i.test(body.version.mainSha))) bad('version.mainSha needs 8–40 hex characters');
  items('commands', ['label', 'command', 'why']); items('places', ['label', 'path', 'what']);
  if (body.places?.some(place => SCHEME.test(place.path) && !LINK.test(place.path))) bad('place link must be https or http://127.0.0.1');
  return body;
}
// Shared, data-free script. Filtering never changes the source or the overview counts.
const PANEL_SCRIPT = `(()=>{const d=document,t=d.getElementById('toast'),cut=v=>v.length>60?v.slice(0,57)+'…':v;
const show=(m,bad)=>{t.textContent=m;t.className=bad?'bad':'';t.hidden=false;clearTimeout(t._h);t._h=setTimeout(()=>{t.hidden=true},bad?8000:1800)};
const fallback=v=>{const a=d.createElement('textarea');a.value=v;d.body.append(a);try{a.select();return d.execCommand('copy')===true}catch{return false}finally{a.remove()}};
d.addEventListener('click',async e=>{const filter=e.target.closest('[data-filter]');if(filter){
const value=filter.getAttribute('data-filter');let count=0;
d.querySelectorAll('[data-work-state]').forEach(row=>{row.hidden=value!=='all'&&row.getAttribute('data-work-state')!==value;if(!row.hidden)count++});
d.querySelectorAll('[data-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button===filter)));
d.getElementById('filter-result').textContent=count+' kayıt gösteriliyor';d.getElementById('filter-empty').hidden=count!==0;return}
const b=e.target.closest('[data-copy]');if(!b)return;const v=b.getAttribute('data-copy');let ok;
try{await navigator.clipboard.writeText(v);ok=true}catch{ok=fallback(v)}
show(ok?'Kopyalandı: '+cut(v):'Kopyalanamadı — metni sayfadan elle seç ve kopyala: '+cut(v),!ok)});
const g=Date.parse(d.body.dataset.updated),u=d.getElementById('age'),tile=d.getElementById('freshness'),f=()=>{
const m=Math.floor((Date.now()-g)/6e4),unknown=!Number.isFinite(m)||m<0,stale=unknown||m>=30;
u.textContent=unknown?'Zaman bilinmiyor':(m<1?'az önce':m<60?m+' dk önce':Math.floor(m/60)+' sa '+(m%60)+' dk önce')+(stale?' · Bayat':'');
tile.className='tile '+(stale?'tone-warn':'tone-ok')};f();setInterval(f,3e4)})();`;
const PANEL_HASH = crypto.createHash('sha256').update(PANEL_SCRIPT).digest('base64');
const WORKER_TR = { running: 'Çalışıyor', review: 'İncelemede', landed: 'İndi', canceled: 'İptal', failed: 'Başarısız' };
const TONES = { active: 'info', running: 'info', review: 'warn', waiting: 'warn', blocked: 'fail', failed: 'fail', landed: 'ok', closed: 'neutral', canceled: 'neutral', unassigned: 'neutral' };
const compactText = value => escapeHtml(String(value).replace(/\b[0-9a-f]{40}\b/gi, sha => sha.slice(0, 8)));
const copyButton = (value, label = 'Kopyala') => `<button type="button" class="copy" data-copy="${escapeHtml(value)}" aria-label="${escapeHtml(label)}: ${escapeHtml(value)}">${escapeHtml(label)}</button>`;
const badge = status => `<span class="badge tone-${TONES[status] ?? 'neutral'}">${escapeHtml(STATUS_TR[status] ?? WORKER_TR[status] ?? 'Bilinmiyor')}</span>`;
const boardWorkers = board => board.sessions.flatMap(row => row.workers ?? []);
const boardNote = board => `<p class="m">Pano rev ${escapeHtml(board.revision)} · yalnız pano verisi, canlılık/yetki kanıtı değildir · Dogfood: <strong>${escapeHtml(board.dogfood.mode)}</strong> · kaynak: ${escapeHtml(board.dogfood.source)}</p>`;
function dashboardSummary(board, now, version) {
  const workers = boardWorkers(board), sessionCount = status => board.sessions.filter(row => row.status === status).length;
  const workerCount = status => workers.filter(row => row.status === status).length;
  const metric = (key, label, value, tone, note = '') => `<div class="tile tone-${tone}" data-kpi="${key}"><span>${label}</span><strong>${compactText(value)}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
  const minutes = (now.getTime() - Date.parse(board.updatedAt)) / 60_000, known = Number.isFinite(minutes) && minutes >= 0;
  const stale = !known || minutes >= 30;
  const ciState = version?.ciState ?? 'warn', ciLabel = { ok: 'Başarılı', warn: 'Dikkat / belirsiz', fail: 'Başarısız' }[ciState];
  return `<section class="overview" aria-label="Durum özeti"><div class="tiles">
${metric('sessions-active', 'Aktif oturum', sessionCount('active'), 'info')}${metric('sessions-waiting', 'Bekleyen oturum', sessionCount('waiting'), 'warn')}${metric('sessions-blocked', 'Engelli oturum', sessionCount('blocked'), sessionCount('blocked') ? 'fail' : 'neutral')}
${metric('workers-running', 'Çalışan işçi', workerCount('running'), 'info')}${metric('workers-review', 'İncelemede işçi', workerCount('review'), 'warn')}${metric('workers-landed', 'İnen işçi', workerCount('landed'), 'ok')}
${metric('live-version', 'Canlı sürüm', version?.live ?? 'Bilinmiyor', 'neutral', 'Rapor kaydı; canlı doğrulama değil')}
${metric('main-sha', 'Main SHA', version?.mainSha?.slice(0, 8) ?? 'Bilinmiyor', 'neutral')}
${metric('ci', 'CI durumu', version?.ci ?? 'Bilinmiyor', ciState, version ? ciLabel : 'Kaynakta CI kaydı yok')}
<div id="freshness" class="tile tone-${stale ? 'warn' : 'ok'}" data-kpi="age"><span>Son pano güncellemesi</span><strong id="age">${known ? escapeHtml(age(board.updatedAt, now)) + (stale ? ' · Bayat' : '') : 'Zaman bilinmiyor'}</strong><small>30 dk sonrası bayat · canlılık ölçümü değil</small></div>
</div></section>`;
}
function panelPeople(board, now) {
  const cell = (label, content) => `<td data-label="${label}">${content}</td>`;
  const location = value => value ? `<code title="${escapeHtml(value)}">${escapeHtml(value.split(/[\\/]/).filter(Boolean).pop() ?? value)}</code>${copyButton(value, 'Yolu kopyala')}` : '—';
  const stampCell = (iso, label) => `<span class="m">${label}</span><br>${iso ? `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(age(iso, now))}</time>` : 'Kayıt yok'}`;
  const rows = board.sessions.flatMap(row => {
    const session = `<tr data-work-state="${row.status === 'active' ? 'running' : escapeHtml(row.status)}">`
      + cell('Kim', `<strong>${escapeHtml(row.name ?? row.role)}</strong><small>Oturum · ${escapeHtml(row.role)}</small><details><summary>Kimlik</summary><code>${escapeHtml(show(row.sessionId))}</code><p>${escapeHtml(show(row.cwd))}</p>${row.channel ? `<p>Kanal: ${escapeHtml(row.channel)}</p>` : ''}</details>`)
      + cell('Kart / iş', `<strong>${compactText(show(row.workRef))}</strong>${row.focus ? `<p>${compactText(row.focus)}</p>` : ''}`)
      + cell('Durum', badge(row.status)) + cell('Ne zamandan beri', stampCell(row.updatedAt, 'Son kayıt'))
      + cell('Worktree', location(row.cwd)) + cell('Sıradaki adım', `${compactText(show(row.next))}${row.waitingOn ? `<p class="waiting">Beklediği: ${escapeHtml(row.waitingOn)}</p>` : ''}`) + '</tr>';
    return [session, ...(row.workers ?? []).map(w => `<tr data-work-state="${escapeHtml(w.status)}">`
      + cell('Kim', `<strong>${escapeHtml(show(w.id))}</strong><small>İşçi · ${escapeHtml(row.name ?? row.role)}</small><details><summary>Model / araç</summary>${escapeHtml(show(w.model))} · ${escapeHtml(w.kind)}</details>`)
      + cell('Kart / iş', compactText(show(w.card))) + cell('Durum', badge(w.status)) + cell('Ne zamandan beri', stampCell(w.since, 'Başlangıç'))
      + cell('Worktree', location(w.worktree)) + cell('Sıradaki adım', '<span class="m">İşçi için kayıt yok</span>') + '</tr>')];
  });
  return `<div class="filters" role="group" aria-label="İş durumu filtresi">${[['all', 'Tümü'], ['running', 'Çalışan'], ['review', 'İnceleme'], ['landed', 'İnen']].map(([key, label]) =>
    `<button type="button" data-filter="${key}" aria-controls="work-rows" aria-pressed="${key === 'all'}">${label}</button>`).join('')}</div>
<p id="filter-result" class="m" role="status" aria-live="polite">${rows.length} kayıt gösteriliyor</p><table class="work-table"><caption>Oturumlar ve işçiler · kayıtlı durumlar</caption><thead><tr>${['Kim', 'Kart / iş', 'Durum', 'Ne zamandan beri', 'Worktree', 'Sıradaki adım'].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody id="work-rows">${rows.join('')}</tbody></table>
<p id="filter-empty" hidden>Bu filtrede kayıt yok.</p><noscript>Filtre için JavaScript gerekir; tüm kayıtlar gösteriliyor.</noscript>`;
}
function workerChart(board) {
  const workers = boardWorkers(board);
  if (!workers.length) return '<p class="m">İşçi kaydı yok; dağılım hesaplanmadı.</p>';
  const counts = WORKER_STATUS.map(status => ({ status, count: workers.filter(w => w.status === status).length }));
  const legend = counts.map(({ status, count }) => `<li>${badge(status)} <strong>${count}</strong> <span class="m">(%${Math.round(count / workers.length * 100)})</span></li>`).join('');
  return `<figure><figcaption>İşçi durum dağılımı · ${workers.length} işçi</figcaption><div class="stack" aria-hidden="true">${counts.filter(item => item.count).map(({ status, count }) =>
    `<span class="segment tone-${TONES[status]}" style="flex-grow:${count}"></span>`).join('')}</div><ul class="legend">${legend}</ul></figure>`;
}
function panelFlow(board, body) {
  const workers = boardWorkers(board), assigned = board.sessions.filter(row => row.status !== 'unassigned');
  const item = (text, who, label = '') => `<li>${label ? `<strong>${compactText(label)}</strong><br>` : ''}${compactText(text)}<small>Kimde: ${escapeHtml(who)}</small></li>`;
  const current = assigned.filter(row => row.status !== 'closed');
  // A closed session is not evidence that its work landed. Only explicit landed workers populate Yapıldı.
  const completed = workers.filter(w => w.status === 'landed').map(w => item(show(w.card), show(w.id)));
  const parallel = workers.filter(w => ['running', 'review'].includes(w.status)).map(w => item(show(w.card), show(w.id), WORKER_TR[w.status]));
  const stages = body ? [
    [item(body.flow[0].text, body.flow[0].who, body.flow[0].label)],
    [item(body.flow[1].text, body.flow[1].who, body.flow[1].label)],
    [...body.flow.slice(2).map(step => item(step.text, step.who, step.label)), item(body.next.text, body.next.who)], parallel,
  ] : [completed, current.map(row => item(show(row.focus), row.name ?? row.role, STATUS_TR[row.status])), current.filter(row => row.next).map(row => item(row.next, row.name ?? row.role)), parallel];
  return `<div class="flow">${['Yapıldı', 'Şimdi', 'Sonra', 'Paralel'].map((label, i) => `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ''}<article class="step tone-${['ok', 'info', 'warn', 'neutral'][i]}"><h3>${label}</h3><ul>${stages[i].join('') || '<li>Kayıt yok<small>Kimde: —</small></li>'}</ul></article>`).join('')}</div>`;
}
const DASHBOARD_STYLE = `
:root{color-scheme:light dark;--fg:#20252b;--bg:#f3f5f7;--card:#ffffff;--mute:#505b68;--line:#c3cbd4;--info:#174c96;--infobg:#e9f1ff;--warn:#754500;--warnbg:#fff1d6;--fail:#a02024;--failbg:#ffebec;--ok:#185c36;--okbg:#e4f5ea;--neutral:#485360;--neutralbg:#eaf0f4}
@media(prefers-color-scheme:dark){:root{--fg:#edf1f5;--bg:#10151c;--card:#19212b;--mute:#b0bccb;--line:#536478;--info:#a3c7ff;--infobg:#162f50;--warn:#ffcf80;--warnbg:#382a11;--fail:#ffa8ac;--failbg:#411e28;--ok:#99e0b4;--okbg:#133727;--neutral:#c3ceda;--neutralbg:#263240}}
*{box-sizing:border-box;min-width:0}body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);overflow-wrap:anywhere}
header,main,nav{max-width:1440px;margin:auto;padding:18px clamp(12px,3vw,32px)}main{padding-top:0;padding-bottom:40px}h1{font-size:1.6rem;margin:0}h2{font-size:1.15rem;margin:0 0 12px}h3{font-size:1rem;margin:0}h4{margin:16px 0 4px}p{margin:6px 0 12px}small,.m{color:var(--mute);font-size:.85rem}small{display:block}section{margin-top:24px}section.overview{margin-top:8px}.lead{font-size:1.1rem}
.tone-info{--tone:var(--info);--tint:var(--infobg)}.tone-warn{--tone:var(--warn);--tint:var(--warnbg)}.tone-fail{--tone:var(--fail);--tint:var(--failbg)}.tone-ok{--tone:var(--ok);--tint:var(--okbg)}.tone-neutral{--tone:var(--neutral);--tint:var(--neutralbg)}
.tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.tile{border:1px solid var(--line);border-top:4px solid var(--tone);border-radius:10px;padding:12px;background:var(--tint);color:var(--tone)}.tile>span{font-size:.85rem;font-weight:600}.tile>strong{display:block;font-size:1.2rem;line-height:1.35;margin:6px 0}.tile small{color:inherit}.tile[data-kpi^="sessions-"]>strong,.tile[data-kpi^="workers-"]>strong{font-size:1.8rem;font-variant-numeric:tabular-nums}
nav,.filters,.row,.path{display:flex;flex-wrap:wrap;align-items:center;gap:8px}nav{padding-top:0;padding-bottom:0}nav a,button{border:1px solid var(--info);border-radius:7px;background:var(--card);color:var(--info);padding:7px 12px;font:inherit;cursor:pointer;text-decoration:none}a{color:var(--info)}nav a.hot{color:var(--warn);border-color:var(--warn)}button[aria-pressed="true"],button:hover{background:var(--info);color:var(--card)}:focus-visible{outline:3px solid var(--info);outline-offset:3px}button.copy{font-size:.8rem}.row{justify-content:space-between}
.cards{list-style:none;padding:0;margin:0;display:grid;gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.decide{border-left:5px solid var(--warn);background:var(--warnbg)}.cmd{border-left:5px solid var(--info)}
.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr;gap:8px}.step{background:var(--tint);border:1px solid var(--line);border-top:4px solid var(--tone);border-radius:10px;padding:12px}.step h3{color:var(--tone)}.step ul{padding:0;list-style:none;margin:8px 0 0}.step li+li{border-top:1px solid var(--line);margin-top:10px;padding-top:10px}.step small{margin-top:6px}.arrow{align-self:center;font-size:1.4rem;color:var(--mute)}
.badge{display:inline-block;border:1px solid var(--tone);border-radius:6px;padding:2px 7px;font-size:.8rem;font-weight:600;color:var(--tone);background:var(--tint)}
table{width:100%;table-layout:fixed;border-collapse:collapse;background:var(--card)}caption{text-align:left;padding:8px 0;color:var(--mute);font-size:.85rem}th,td{text-align:left;vertical-align:top;padding:12px 10px;border-bottom:1px solid var(--line)}th{font-size:.82rem;background:var(--neutralbg)}td p{margin:6px 0}td .copy{margin-top:6px}.waiting{color:var(--warn)}.work-table th:nth-child(2),.work-table th:nth-child(6){width:24%}.work-table th:nth-child(3){width:10%}.work-table th:nth-child(4){width:12%}
code,pre{font:.85rem/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}pre{padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px}details{margin-top:8px}summary{cursor:pointer;color:var(--info)}summary h2{display:inline}figure{margin:0;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--card)}figcaption{font-weight:600}.stack{display:flex;height:20px;gap:3px;margin:12px 0}.segment{flex-basis:0;background:var(--tone);border:1px solid var(--tone)}.legend{display:flex;flex-wrap:wrap;gap:12px;list-style:none;padding:0;margin:0}
#toast{position:fixed;bottom:16px;left:16px;right:16px;max-width:680px;margin:auto;padding:12px;background:var(--fg);color:var(--bg);border-radius:8px}#toast.bad{background:var(--failbg);color:var(--fail);border:2px solid var(--fail)}[hidden]{display:none!important}
@media(max-width:1000px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.flow{grid-template-columns:1fr}.arrow{justify-self:center;transform:rotate(90deg)}table,tbody,tr,td{display:block}thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}tr{padding:12px 0;border-bottom:2px solid var(--line)}td{border:0;padding:5px 12px}td[data-label]::before{content:attr(data-label);display:block;font-size:.8rem;font-weight:600;color:var(--mute)}}
@media(max-width:640px){.tiles{grid-template-columns:1fr}.row{align-items:flex-start;flex-direction:column}}
@media(forced-colors:active){.tile,.step,.badge,.segment,button{border:1px solid CanvasText}.segment{background:CanvasText}button[aria-pressed="true"]{outline:2px solid Highlight}}
`;
function dashboardPage(title, board, now, content) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${PANEL_HASH}'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title><style>${DASHBOARD_STYLE}</style></head><body data-updated="${escapeHtml(board.updatedAt ?? '')}" data-generated="${escapeHtml(now.toISOString())}">
${content}<div id="toast" role="status" aria-live="polite" hidden></div><script>${PANEL_SCRIPT}</script></body></html>\n`;
}
export function renderOwnerReport(input, board, { now = new Date() } = {}) {
  const body = validateReport(input), list = items => items.length ? `<ul>${items.map(item => `<li>${compactText(item)}</li>`).join('')}</ul>` : '<p class="m">Yok.</p>';
  const commands = body.commands ?? [], places = body.places ?? [], expected = body.decisions.length + commands.length;
  const decide = body.decisions.map(item => `<li class="card decide">${compactText(item)}</li>`).join('')
    + commands.map(c => `<li class="card cmd"><div class="row"><strong>${escapeHtml(c.label)}</strong>${copyButton(c.command, 'Komutu kopyala')}</div>`
      + `<pre><code>${escapeHtml(c.command)}</code></pre>${c.why ? `<p class="m">${escapeHtml(c.why)}</p>` : ''}</li>`).join('');
  const place = p => LINK.test(p.path) ? `<a href="${escapeHtml(p.path)}" rel="noreferrer">${escapeHtml(p.path)}</a>` : `<code>${escapeHtml(p.path)}</code>`;
  const where = places.length ? `<table><caption>Adresler ve kanıtlar</caption><thead><tr><th scope="col">Ne</th><th scope="col">Ne görürsün</th><th scope="col">Adres</th></tr></thead><tbody>${places.map(p =>
    `<tr><td data-label="Ne"><strong>${escapeHtml(p.label)}</strong></td><td data-label="Ne görürsün">${escapeHtml(p.what ?? '')}</td><td data-label="Adres">${place(p)}<div>${copyButton(p.path)}</div></td></tr>`).join('')}</tbody></table>` : '<p class="m">Yok.</p>';
  const section = (id, title, content) => `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${title}</h2>${content}</section>`;
  return dashboardPage(body.title, board, now, `<header><h1>${escapeHtml(body.title)}</h1>${boardNote(board)}
<p class="lead"><strong>${compactText(body.headline)}</strong></p><p>${compactText(body.impact)}</p>
<p class="m">HTML üretimi: ${escapeHtml(now.toISOString())} · Rapor içeriği yazar kaydıdır; kaynak yaşı bilinmiyor.</p></header>
<nav aria-label="Bölümler"><a href="#bekleyen"${expected ? ' class="hot"' : ''}>Senden beklenenler · ${expected}</a><a href="#akis">Akış ve sürüm</a><a href="#kim">Kim ne yapıyor</a><a href="#nerede">Nerede ne var</a><a href="#ayrinti">Ayrıntı</a></nav>
<main>${dashboardSummary(board, now, body.version)}
${section('bekleyen', `Senden beklenenler · ${expected}`, expected ? `<ul class="cards">${decide}</ul>` : '<p class="m">Şu an senden beklenen karar veya komut yok.</p>')}
${section('akis', 'Akış ve sürüm', `${panelFlow(board, body)}${body.version ? `<p>N1 (dogfood): ${compactText(body.version.n1)}</p>` : ''}<h4>Açık sınır</h4>${list(body.limits)}<h4>Sıradaki adım · ${escapeHtml(body.next.who)}</h4><p>${compactText(body.next.text)}</p>`)}
${section('kim', 'Kim ne yapıyor', panelPeople(board, now))}
${section('dagilim', 'İşçi durum dağılımı', workerChart(board))}
${section('nerede', 'Nerede ne var', where)}
<section id="ayrinti"><details><summary><h2>Kanıt ve ayrıntı</h2></summary>${list(body.details)}</details>
<details><summary><h2>Süreç panosu</h2></summary><pre>${escapeHtml(renderText(board, { now }))}</pre></details></section></main>`);
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
