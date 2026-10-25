import { z } from 'zod';
import { monitorQuerySchema, type MonitorInstall, type MonitorQuery, type MonitorSnapshot } from '#engine/index.js';

/** The list sections of one install a page walks; `map` and `diagnostics` page the same way (one map per install, one code per item). */
const LIST_SECTIONS = ['runs', 'workers', 'approvals', 'pools', 'brainWaits', 'map', 'diagnostics'] as const;
type ListSection = (typeof LIST_SECTIONS)[number];
/** Default page sizes (the largest, 100, is in the input schema). Chosen so a default answer stays far below what common MCP clients keep inline (Claude Code warns above
 * 10,000 tokens and saves text over 50,000 characters to a file, code.claude.com/docs/en/mcp, read 2026-10-25); the server bound stays
 * `mcp.responseMaxBytes`. A Run or worker carries tasks and event excerpts, so its page is smaller. */
const PAGE_SIZE: Readonly<Record<ListSection, number>> = Object.freeze({ runs: 5, workers: 5, approvals: 20, pools: 20, brainWaits: 20, map: 1, diagnostics: 50 });
/** Open Runs listed in the summary per install (oldest proven blocker first); the rest stay reachable through `section: "runs"`. */
const SUMMARY_ATTENTION = 10;
const TERMINAL = new Set(['accepted', 'failed', 'cancelled']);

/** GOZ-30: the MCP `inspect_monitor` input — the v1 monitor query plus what to answer (additive optional fields; collection is unchanged).
 * No section = a bounded summary; a list section is paged; `snapshot` is the whole v1 snapshot (bounded only by `mcp.responseMaxBytes`). */
export const mcpMonitorQuerySchema = monitorQuerySchema.extend({
  section: z.enum(['summary', ...LIST_SECTIONS, 'snapshot']).optional(),
  page: z.number().int().nonnegative().safe().optional(),
  pageSize: z.number().int().positive().max(100).optional(),
}).strict();
export type McpMonitorQuery = z.infer<typeof mcpMonitorQuerySchema>;
export const monitorCollectionQuery = (query: McpMonitorQuery): MonitorQuery => ({ schemaVersion: 1, ...(query.install ? { install: query.install } : {}) });

const itemsOf = (install: MonitorInstall, section: ListSection): readonly unknown[] => section === 'map' ? (install.map ? [install.map] : [])
  : section === 'brainWaits' ? install.brainWaits ?? [] : install[section];

/** One answer of `inspect_monitor` v2 from one collected v1 snapshot (pure; the same value every surface renders, only cut differently). */
export function projectMonitorForMcp(snapshot: MonitorSnapshot, query: McpMonitorQuery): unknown {
  const section = query.section ?? 'summary';
  if (section === 'snapshot') return snapshot;
  const head = { schemaVersion: 2 as const, section, observedAt: snapshot.observedAt, control: snapshot.control, sourcesRead: snapshot.sourcesRead };
  if (section === 'summary') return { ...head, sections: [...LIST_SECTIONS, 'snapshot'], installs: snapshot.installs.map(install => {
    const open = install.runs.filter(run => !TERMINAL.has(run.state))
      .sort((a, b) => (a.blocker?.sinceMs ?? Number.POSITIVE_INFINITY) - (b.blocker?.sinceMs ?? Number.POSITIVE_INFINITY));
    const runStates: Record<string, number> = {};
    for (const run of install.runs) runStates[run.state] = (runStates[run.state] ?? 0) + 1;
    return { id: install.id, path: install.path, status: install.status, scopeIds: install.scopeIds, service: install.service, ledgerVersion: install.ledgerVersion,
      ...(install.hiddenPools ? { hiddenPools: install.hiddenPools } : {}),
      counts: Object.fromEntries(LIST_SECTIONS.map(name => [name, itemsOf(install, name).length])), runStates,
      problems: install.diagnostics.filter(code => !code.startsWith('info:')).slice(0, SUMMARY_ATTENTION),
      attention: open.slice(0, SUMMARY_ATTENTION).map(run => ({ scopeId: run.scopeId, runId: run.runId, state: run.state, blocker: run.blocker, lastActivityMs: run.lastActivityMs })),
      attentionTruncated: open.length > SUMMARY_ATTENTION };
  }) };
  const all = snapshot.installs.flatMap(install => itemsOf(install, section).map(item => ({ install: install.id, item })));
  const pageSize = query.pageSize ?? PAGE_SIZE[section], page = query.page ?? 0, from = page * pageSize;
  return { ...head, page, pageSize, total: all.length, nextPage: from + pageSize < all.length ? page + 1 : null, items: all.slice(from, from + pageSize) };
}
