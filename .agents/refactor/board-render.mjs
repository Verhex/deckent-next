// Development-host process board: the owner-facing HTML page (owner 2026-10-09, Jev 5dcab8df). Offline, one file, no network:
// system fonts, text glyphs, CSS variables for light/dark. Every string from the board, channel, Jev journal or release status
// is untrusted data and is HTML-escaped; a missing optional source shows "veri yok" and never fails the render.
// The only script is the fixed data-free FILTER_SCRIPT below, pinned by a CSP hash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse as parseChannel, safeRead as readChannelFile } from './channel.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const compact = value => esc(String(value ?? '').replace(/\b[0-9a-f]{40}\b/gi, sha => sha.slice(0, 8)));
const clip = (value, n) => { const s = String(value ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const NODATA = '<span class="m">veri yok</span>';
const OWNER = /\b(owner|sahip)\b/i, DOGFOOD = /dogfood/i;

export function ageText(iso, now) {
  const ms = iso ? now.getTime() - Date.parse(iso) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return 'zaman bilinmiyor';
  const min = Math.floor(ms / 60_000), hours = Math.floor(min / 60);
  if (min < 1) return 'az önce'; if (min < 60) return `${min} dk önce`;
  if (hours < 48) return `${hours} sa ${min % 60} dk önce`; return `${Math.floor(hours / 24)} gün önce`;
}
const spanText = (iso, now) => ageText(iso, now).replace(/ önce$/, '');
const clock = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toISOString().slice(5, 16).replace('T', ' ') + ' UTC' : '—'; };

// ---- optional sources (each returns null/[] on any problem; nothing here is authority)
const JEV_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const readJson = (file, limit = 262_144) => { try { return JSON.parse(readChannelFile(file, limit)); } catch { return null; } };
export function readDecisions(journalRoot, limit = 6) {
  let names; try { names = fs.readdirSync(journalRoot).filter(n => JEV_ID.test(n)); } catch { return null; }
  const found = [];
  for (const id of names) { const d = readJson(path.join(journalRoot, id, 'decision.json'), 65_536); if (d && Number.isFinite(Date.parse(d.at)) && typeof d.selectedOption === 'string') found.push({ id, d }); }
  found.sort((a, b) => Date.parse(b.d.at) - Date.parse(a.d.at));
  return found.slice(0, limit).map(({ id, d }) => {
    const req = readJson(path.join(journalRoot, id, 'request.json')), res = readJson(path.join(journalRoot, id, 'response.json'));
    const na = res?.answers?.next_action, num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { id, at: d.at, actor: typeof d.actor === 'string' ? d.actor : '', selected: d.selectedOption,
      title: req?.case?.objective ?? req?.case?.scope ?? d.selectedOption, choice: num(na?.probabilities?.[d.selectedOption]) ?? num(na?.confidence), sufficiency: num(res?.answers?.sufficiency?.noul) };
  });
}
/** Owner protocol (Astra 2475 N1): a body may open with a routing line, `TO: reviewer <session>` or `TO: main opus`; the kind line
 * (REQUEST_REVIEW / REVIEW) follows it. The routing text is kept as the shown recipient; pairing still uses the channel's from/to fields. */
export function splitRouting(body) {
  const lines = String(body ?? '').split('\n'), m = /^TO:\s*(.*)$/.exec((lines[0] ?? '').trim());
  return m ? { recipient: m[1].trim() || null, rest: lines.slice(1).join('\n') } : { recipient: null, rest: String(body ?? '') };
}
export function readReviews(channelFile, cutoff = 2000, limit = 5) {
  let entries; try { entries = parseChannel(readChannelFile(channelFile), cutoff).map(e => ({ ...e, ...splitRouting(e.body) })); } catch { return null; }
  const firstLines = body => body.split('\n').map(l => l.trim()).filter(Boolean);
  const requests = entries.filter(e => e.to === 'astra' && /^\s*REQUEST_REVIEW(\s|$)/.test(e.rest));
  const reviews = entries.filter(e => e.from === 'astra' && /^\s*REVIEW(\s|$)/.test(e.rest));
  const replyFor = req => reviews.find(r => r.seq > req.seq && new RegExp(`\\bre=${req.seq}(:|\\b)`).test(firstLines(r.rest)[0] ?? ''));
  // Two reply shapes: "REVIEW re=…" with the verdict on the next line, or "REVIEW — REVISE re=…" with it on the REVIEW line.
  const verdictOf = body => { const lines = firstLines(body), inline = /^REVIEW\s*[—:-]?\s*(PASS|REVISE)\b/.exec(lines[0] ?? '');
    if (inline) return { verdict: inline[1], headline: (lines[0] ?? '').replace(/^REVIEW\s*[—:-]?\s*(PASS|REVISE)\s*(re=\S+)?\s*[;:—-]?\s*/, '') || (lines[1] ?? '') };
    const m = /^(PASS|REVISE)\b/.exec(lines[1] ?? ''); return { verdict: m?.[1] ?? null, headline: (lines[1] ?? '').replace(/^(PASS|REVISE)\s*[—:-]?\s*/, '') };
  };
  const counts = body => { const c = { P0: 0, P1: 0, P2: 0 }; for (const m of body.matchAll(/^\s*\d+\.\s*(P[012])\b/gm)) c[m[1]]++; return c; };
  const items = [], used = new Set();
  for (const req of requests) {
    const rep = replyFor(req); if (rep) used.add(rep.seq);
    const lines = firstLines(req.rest), head = lines[0].replace(/^REQUEST_REVIEW\s*[—:-]?\s*/, '').trim() || lines[1] || '';
    items.push({ seq: req.seq, at: req.at, title: head, recipient: req.recipient, pending: !rep, verdict: rep ? verdictOf(rep.rest).verdict : null, findings: rep ? counts(rep.rest) : null, replyAt: rep?.at ?? null });
  }
  for (const rep of reviews) if (!used.has(rep.seq)) { const v = verdictOf(rep.rest); items.push({ seq: rep.seq, at: rep.at, title: v.headline || `İnceleme yanıtı ${rep.seq}`, recipient: rep.recipient, pending: false, verdict: v.verdict, findings: counts(rep.rest), replyAt: rep.at, orphan: true }); }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
/** Runs the project's own `dev-release.mjs status` (read-only) and keeps only the fields shown. Any failure gives null. */
export function readRelease(projectRoot, { timeoutMs = 20_000 } = {}) {
  try {
    const run = spawnSync(process.execPath, [path.join(projectRoot, '.agents/refactor/dev-release.mjs'), 'status'], { cwd: projectRoot, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4_000_000 });
    if (run.status !== 0) return null;
    const s = JSON.parse(run.stdout), byId = new Map((s.versions ?? []).filter(v => !v.invalid).map(v => [v.id, v]));
    const semver = commit => { if (!/^[0-9a-f]{40}$/.test(commit ?? '')) return null; const g = spawnSync('git', ['-C', projectRoot, '--no-optional-locks', 'show', `${commit}:package.json`], { encoding: 'utf8', timeout: 5000, maxBuffer: 262_144 });
      try { return g.status === 0 ? JSON.parse(g.stdout).version ?? null : null; } catch { return null; } };
    const view = id => { const v = byId.get(id); return v ? { id, commit: v.sourceCommit, version: semver(v.sourceCommit), ledger: v.ledgerVersion, protocol: v.protocolVersion, stagedAt: v.stagedAt } : null; };
    return { current: view(s.current), previous: view(s.previous), ledgerNow: s.ledgerVersion ?? null };
  } catch { return null; }
}
export function collectSources({ channelFile, journalRoot, projectRoot, cutoff, release = true } = {}) {
  return { reviews: channelFile ? readReviews(channelFile, cutoff) : null, decisions: journalRoot ? readDecisions(journalRoot) : null, release: release && projectRoot ? readRelease(projectRoot) : null };
}

// ---- derived views
/** Owner-action items come only from the board text: segments of waitingOn/next that name the owner, plus a pending DOGFOOD decision. */
export function ownerActions(board) {
  const items = [], seen = new Set();
  for (const row of board.sessions) {
    if (row.status === 'unassigned' || row.status === 'closed') continue;
    for (const field of ['waitingOn', 'next']) for (const part of String(row[field] ?? '').split(/;\s*|\n/)) {
      const text = part.trim(); if (!text || !OWNER.test(text) || seen.has(text)) continue; seen.add(text);
      items.push({ title: clip(text, 160), who: row.name ?? row.role, field: field === 'next' ? 'Sonraki adım' : 'Bekliyor', dogfood: DOGFOOD.test(text) });
    }
  }
  if (board.dogfood.mode === 'OFF' && !items.some(i => i.dogfood)) {
    const main = board.sessions.find(r => r.slot === 'main');
    const hit = ['focus', 'waitingOn', 'next'].flatMap(f => String(main?.[f] ?? '').split(/[.;]\s+|\n/)).find(t => DOGFOOD.test(t) && OWNER.test(t));
    if (hit) items.push({ title: `DOGFOOD kararı bekleniyor: ${clip(hit.trim(), 140)}`, who: main.name ?? main.role, field: 'Ana oturum kaydı', dogfood: true });
  }
  return items;
}
export const WORKER_FILTERS = [['all', 'Tümü'], ['running', 'Çalışıyor'], ['review', 'İncelemede'], ['landed', 'İndi']];
export const filterCounts = workers => Object.fromEntries(WORKER_FILTERS.map(([key]) => [key, key === 'all' ? workers.length : workers.filter(w => w.status === key).length]));
const shortPath = value => { const home = os.homedir(); return value === home ? '~' : value.startsWith(home + path.sep) ? `~${value.slice(home.length)}` : value; };

// ---- sections
const SESSION_STATE = { active: ['info', '●', 'Çalışıyor'], waiting: ['warn', '◔', 'Bekliyor'], blocked: ['fail', '■', 'Engelli'], closed: ['neutral', '✓', 'Kapandı'], unassigned: ['neutral', '○', 'Atanmadı'] };
const WORKER_STATE = { running: ['info', '▶', 'Çalışıyor'], review: ['warn', '◎', 'İncelemede'], landed: ['ok', '✓', 'İndi'], canceled: ['neutral', '–', 'İptal'], failed: ['fail', '✕', 'Başarısız'] };
const KIND_TR = { 'codex-exec': 'Codex', 'claude-subagent': 'Claude alt ajanı', 'claude-headless': 'Claude başsız', cursor: 'Cursor' };
const chip = ([tone, glyph, word]) => `<span class="chip tone-${tone}"><span aria-hidden="true">${glyph}</span> ${esc(word)}</span>`;
const section = (id, title, meta, body) => `<section id="${id}" aria-labelledby="${id}-t"><div class="head"><h2 id="${id}-t">${title}</h2>${meta ? `<span class="m">${meta}</span>` : ''}</div>${body}</section>`;

function calloutSection(board) {
  const items = ownerActions(board); if (!items.length) return '';
  return `<section id="sahip" class="callout" role="region" aria-labelledby="sahip-t"><div class="head"><h2 id="sahip-t"><span aria-hidden="true">⚠</span> Sahip eylemi gerekiyor</h2><span class="m">${items.length} kayıt · pano metninden türetildi</span></div><ul class="rows">${items.map(i =>
    `<li><strong>${compact(i.title)}</strong><small>${esc(i.field)} · ${esc(i.who)}${i.dogfood ? ' · DOGFOOD kararı' : ''}</small></li>`).join('')}</ul></section>`;
}
function versionStrip(board, release) {
  const card = (label, main, sub, tone = 'neutral') => `<div class="vcard tone-${tone}"><span class="vl">${label}</span><strong>${main}</strong><small>${sub}</small></div>`;
  const cur = release?.current, prev = release?.previous;
  const rel = (label, v) => v ? card(label, esc(v.version ?? v.id), `commit ${esc(v.commit.slice(0, 8))}`) : card(label, NODATA, 'dev-release kaydı yok');
  const mode = board.dogfood.mode;
  return `<section id="surum" aria-label="Sürüm ve durum"><div class="vstrip">${rel('Canlı = N1', cur)}${rel('Önceki sürüm', prev)}${card('Ledger şeması', cur ? esc(cur.ledger) : NODATA, 'sürümün kaydı')}${card('Protokol', cur ? esc(cur.protocol) : NODATA, 'sürümün kaydı')}`
    + `${card('DOGFOOD', esc(mode === 'OFF' ? 'KAPALI' : mode), mode === 'OFF' ? 'beklenen durum · kapı: owner kararı' : `kaynak: ${esc(clip(board.dogfood.source, 60))}`, mode === 'OFF' ? 'info' : 'warn')}</div>`
    + `<p class="m">Sürüm kartları dev-release kaydıdır; canlılık veya yetki kanıtı değildir. DOGFOOD kaynağı: ${esc(board.dogfood.source)}</p></section>`;
}
function sessionCards(board, now) {
  const card = row => {
    const st = SESSION_STATE[row.status] ?? SESSION_STATE.unassigned, idle = row.status === 'unassigned';
    return `<article class="scard${idle ? ' idle' : ''}"><div class="sh"><h3>${esc(row.name ?? row.role)}</h3>${chip(st)}</div><p class="m">${esc(row.role)}${row.channel ? ` · kanal ${esc(row.channel)}` : ''}${row.workRef ? ` · ${compact(row.workRef)}` : ''}</p>`
      + (idle ? '<p class="m">Bu yuva boş.</p>' : `<p>${row.focus ? compact(row.focus) : NODATA}</p><dl><dt>Bekliyor</dt><dd>${row.waitingOn ? compact(row.waitingOn) : '—'}</dd><dt>Sonraki adım</dt><dd>${row.next ? compact(row.next) : '—'}</dd></dl>`)
      + `<p class="m foot">${row.updatedAt ? `<time datetime="${esc(row.updatedAt)}">${esc(ageText(row.updatedAt, now))}</time>` : 'kayıt yok'}</p></article>`;
  };
  return section('oturumlar', 'Aktif süreç oturumları', `${board.sessions.filter(r => r.status !== 'unassigned').length} atanmış oturum`, `<div class="cards3">${board.sessions.map(card).join('')}</div>`);
}
function lanes(board, now) {
  const workers = board.sessions.flatMap(r => r.workers ?? []), counts = filterCounts(workers);
  const rows = workers.map(w => `<tr data-state="${esc(w.status)}"><td data-label="İş kartı"><strong>${compact(w.card)}</strong><small class="mono">${esc(w.id)}</small></td><td data-label="Model"><code>${esc(w.model)}</code></td><td data-label="Tür">${esc(KIND_TR[w.kind] ?? w.kind)}</td>`
    + `<td data-label="Durum">${chip(WORKER_STATE[w.status] ?? ['neutral', '?', w.status])}</td><td data-label="Süre"><time datetime="${esc(w.since)}" title="${esc(w.since)}">${esc(spanText(w.since, now))}</time></td><td data-label="Çalışma dizini"><code title="${esc(w.worktree)}">${esc(shortPath(w.worktree))}</code></td></tr>`);
  const filters = `<div class="filters" role="group" aria-label="İş durumu filtresi">${WORKER_FILTERS.map(([key, label]) => `<button type="button" data-filter="${key}" aria-pressed="${key === 'all'}" aria-controls="lane-rows">${label} (${counts[key]})</button>`).join('')}</div>`;
  const table = workers.length ? `<table><caption class="sr">Hatlar ve işçiler</caption><thead><tr>${['İş kartı', 'Model', 'Tür', 'Durum', 'Süre', 'Çalışma dizini'].map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody id="lane-rows">${rows.join('')}</tbody></table>` : '<p class="m">İşçi kaydı yok.</p>';
  return section('hatlar', 'Hatlar ve işçiler', `${workers.length} işçi · süre = kayıtlı başlangıçtan beri`, `${filters}<p id="filter-result" class="m" role="status" aria-live="polite">${workers.length} kayıt gösteriliyor</p>${table}<p id="filter-empty" class="m" hidden>Bu filtrede kayıt yok.</p>`);
}
const VERDICT = { PASS: ['ok', '✓', 'PASS'], REVISE: ['warn', '↻', 'REVISE'] };
function reviewQueue(items, now) {
  const body = items === null ? `<p>${NODATA} <span class="m">(kanal dosyası okunamadı)</span></p>` : !items.length ? '<p class="m">Kuyruk boş: Astra için bekleyen veya kayıtlı inceleme yok.</p>'
    : `<ul class="rows">${items.map(i => { const f = i.findings;
      return `<li><div class="line"><strong>${compact(clip(i.title, 120))}</strong>${i.verdict ? chip(VERDICT[i.verdict]) : i.pending ? chip(['warn', '◔', 'Bekliyor']) : ''}</div><small>#${i.seq}${i.recipient ? ` · → ${compact(clip(i.recipient, 60))}` : ''} · <time datetime="${esc(i.at)}">${esc(clock(i.at))}</time> (${esc(ageText(i.at, now))})`
        + `${f ? ` · Bulgu: P0 ${f.P0} · P1 ${f.P1} · P2 ${f.P2}` : ''}</small></li>`; }).join('')}</ul>`;
  return section('inceleme', 'İnceleme kuyruğu (Astra)', items ? `son ${items.length} kayıt` : '', body);
}
const score = v => (v === null ? '—' : v.toFixed(2).replace('.', ','));
function decisionFeed(items, now) {
  const body = items === null ? `<p>${NODATA} <span class="m">(Jev günlüğü okunamadı)</span></p>` : !items.length ? '<p class="m">Kayıtlı karar yok.</p>'
    : `<ol class="rows feed">${items.map(d => { const owner = /^owner/i.test(d.actor);
      return `<li><div class="line"><strong>${compact(clip(d.title, 130))}</strong><time class="m" datetime="${esc(d.at)}">${esc(clock(d.at))}</time></div><small>Seçilen: <strong>${esc(d.selected)}</strong> · seçim ${score(d.choice)} · yeterlilik ${score(d.sufficiency)}</small>`
        + `<small>${owner ? chip(['info', '★', 'Sahip']) : chip(['neutral', '◆', 'Lead / ajan'])} <span class="m">${esc(/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(d.actor) ? `oturum ${d.actor.slice(0, 8)}` : clip(d.actor, 40))}</span> · <code class="mono">${esc(d.id.slice(0, 8))}</code> · ${esc(ageText(d.at, now))}</small></li>`; }).join('')}</ol>`;
  return section('karar', 'Karar akışı', items ? `son ${items.length} karar · Jev günlüğü` : '', body);
}

const FILTER_SCRIPT = `(()=>{const d=document,rows=[...d.querySelectorAll('#lane-rows tr')],btns=[...d.querySelectorAll('[data-filter]')],out=d.getElementById('filter-result'),empty=d.getElementById('filter-empty');
const apply=b=>{const v=b.getAttribute('data-filter');let n=0;rows.forEach(r=>{r.hidden=v!=='all'&&r.getAttribute('data-state')!==v;if(!r.hidden)n++});btns.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));out.textContent=n+' kayıt gösteriliyor';empty.hidden=n!==0};
btns.forEach((b,i)=>{b.addEventListener('click',()=>apply(b));b.addEventListener('keydown',e=>{const k=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(k){const t=btns[(i+k+btns.length)%btns.length];t.focus();apply(t);e.preventDefault()}})});
const t=Date.parse(d.body.dataset.updated),a=d.getElementById('age'),f=()=>{const m=Math.floor((Date.now()-t)/6e4);if(!Number.isFinite(m)||m<0){a.textContent='zaman bilinmiyor';return}a.textContent=m<1?'az önce':m<60?m+' dk önce':m<2880?Math.floor(m/60)+' sa '+(m%60)+' dk önce':Math.floor(m/1440)+' gün önce'};f();setInterval(f,3e4)})();`;
export const FILTER_HASH = crypto.createHash('sha256').update(FILTER_SCRIPT).digest('base64');
export const BOARD_STYLE = `
:root{color-scheme:light dark;--fg:#20252b;--bg:#f3f5f7;--card:#ffffff;--mute:#505b68;--line:#c3cbd4;--info:#174c96;--infobg:#e9f1ff;--warn:#754500;--warnbg:#fff1d6;--fail:#a02024;--failbg:#ffebec;--ok:#185c36;--okbg:#e4f5ea;--neutral:#485360;--neutralbg:#eaf0f4}
@media(prefers-color-scheme:dark){:root{--fg:#edf1f5;--bg:#10151c;--card:#19212b;--mute:#b0bccb;--line:#536478;--info:#a3c7ff;--infobg:#162f50;--warn:#ffcf80;--warnbg:#382a11;--fail:#ffa8ac;--failbg:#411e28;--ok:#99e0b4;--okbg:#133727;--neutral:#c3ceda;--neutralbg:#263240}}
*{box-sizing:border-box;min-width:0}body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);overflow-wrap:anywhere}
header,main,footer{max-width:1440px;margin:auto;padding:16px clamp(12px,3vw,32px)}main{padding-top:0}footer{border-top:1px solid var(--line);margin-top:32px;color:var(--mute);font-size:.85rem}
h1{font-size:1.5rem;margin:0}h2{font-size:1.1rem;margin:0}h3{font-size:1.05rem;margin:0}p{margin:6px 0}section{margin-top:24px}small{display:block;color:var(--mute);font-size:.85rem}.m{color:var(--mute);font-size:.85rem}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.hbar{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;justify-content:space-between}.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;justify-content:space-between;margin-bottom:10px}
.tone-info{--tone:var(--info);--tint:var(--infobg)}.tone-warn{--tone:var(--warn);--tint:var(--warnbg)}.tone-fail{--tone:var(--fail);--tint:var(--failbg)}.tone-ok{--tone:var(--ok);--tint:var(--okbg)}.tone-neutral{--tone:var(--neutral);--tint:var(--neutralbg)}
.chip{display:inline-block;white-space:nowrap;border:1px solid var(--tone);border-radius:6px;padding:1px 8px;font-size:.8rem;font-weight:600;color:var(--tone);background:var(--tint)}
.callout{border:1px solid var(--warn);border-left:6px solid var(--warn);border-radius:10px;background:var(--warnbg);padding:14px 16px;margin-top:8px}.callout h2{color:var(--warn)}
.rows{list-style:none;margin:0;padding:0}.rows li{padding:10px 0;border-top:1px solid var(--line)}.rows li:first-child{border-top:0}.line{display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between;align-items:baseline}.feed{counter-reset:none}
.vstrip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.vcard{border:1px solid var(--line);border-top:4px solid var(--tone);border-radius:10px;padding:10px 12px;background:var(--tint);color:var(--tone)}.vcard .vl{font-size:.8rem;font-weight:600}.vcard strong{display:block;font-size:1.2rem;margin:2px 0}.vcard small{color:inherit}
.cards3{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.scard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.scard.idle{background:var(--neutralbg)}.sh{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.sh h3{flex:1 1 auto}.sh .chip{flex:none}td time{white-space:nowrap}
dl{margin:8px 0;padding:10px;border-radius:8px;background:var(--bg);border:1px solid var(--line)}dt{font-size:.75rem;font-weight:700;text-transform:uppercase;color:var(--mute)}dd{margin:2px 0 8px}dd:last-child{margin-bottom:0}.foot{margin-top:10px}
.filters{display:flex;flex-wrap:wrap;gap:8px}button{border:1px solid var(--info);border-radius:7px;background:var(--card);color:var(--info);padding:6px 12px;font:inherit;cursor:pointer}button[aria-pressed="true"]{background:var(--info);color:var(--card);font-weight:700}button:hover{text-decoration:underline}:focus-visible{outline:3px solid var(--info);outline-offset:3px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid var(--line)}th{font-size:.8rem;text-transform:uppercase;background:var(--neutralbg);color:var(--mute)}
code,.mono{font:.85rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}code{background:var(--neutralbg);padding:1px 5px;border-radius:4px}small.mono{background:none}
.two{margin-top:24px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.panel section{margin:0}.panel+.panel{margin:0}
[hidden]{display:none!important}
@media(max-width:1000px){.vstrip{grid-template-columns:repeat(2,minmax(0,1fr))}.two{grid-template-columns:1fr}table,tbody,tr,td{display:block}thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}tr{padding:10px 0;border-bottom:2px solid var(--line)}td{border:0;padding:4px 10px}td[data-label]::before{content:attr(data-label);display:block;font-size:.75rem;font-weight:600;color:var(--mute)}}
@media(max-width:640px){.vstrip{grid-template-columns:1fr}}
@media(forced-colors:active){.chip,.vcard,.callout,button{border:1px solid CanvasText}button[aria-pressed="true"]{outline:2px solid Highlight}}
`;

/** `sources` = { reviews, decisions, release }; each is optional (undefined/null shows "veri yok"). */
export function renderBoardPage(board, sources = {}, { now = new Date() } = {}) {
  const workers = board.sessions.flatMap(r => r.workers ?? []);
  const updatedMs = Date.parse(board.updatedAt);
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${FILTER_HASH}'; base-uri 'none'; form-action 'none'">
<title>Deckent süreç panosu</title><style>${BOARD_STYLE}</style></head><body data-updated="${esc(board.updatedAt ?? '')}" data-generated="${esc(now.toISOString())}">
<header><div class="hbar"><h1>Deckent süreç panosu</h1><p class="m">Pano rev <strong>${esc(board.revision)}</strong> · son güncelleme <strong id="age">${esc(Number.isFinite(updatedMs) ? ageText(board.updatedAt, now) : 'zaman bilinmiyor')}</strong></p></div>
<p class="m">Yalnız pano, kanal ve karar günlüğü verisi; canlılık veya yetki kanıtı değildir.</p></header>
<main>${calloutSection(board)}
${versionStrip(board, sources.release ?? null)}
${sessionCards(board, now)}
${lanes(board, now)}
<div class="two"><div class="panel">${reviewQueue(sources.reviews ?? null, now)}</div><div class="panel">${decisionFeed(sources.decisions ?? null, now)}</div></div></main>
<footer>Pano rev ${esc(board.revision)} · ${workers.length} işçi · üretim: <time datetime="${esc(now.toISOString())}">${esc(now.toISOString())}</time></footer>
<script>${FILTER_SCRIPT}</script></body></html>\n`;
}
