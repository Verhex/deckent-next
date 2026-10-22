import { normalizeGlobalScopePlatform, prepareProductDirectory, resolveGlobalScopePaths, resolveProductLayout, type KnownSecretSnapshot } from '#platform/index.js';
import type { ProjectInstructionView } from '#engine/index.js';
import { openProjectInstructionReader } from './files.js';
import REGISTRY from './registry.json' with { type: 'json' };

/** Consent lives in the user-global private trust directory (shared by the terminal and Run admission); an unsupported platform keeps
 * consent in the session only, so a fresh process asks again and never reads an unverified cache. */
export async function openHostProjectInstructionReader(root: string, env: NodeJS.ProcessEnv, known?: KnownSecretSnapshot, files?: readonly string[]) {
  const directory = await trustDirectory(env).catch(() => null);
  return openProjectInstructionReader(root, directory, known, files).catch(() => openProjectInstructionReader(root, null, known, files));
}
async function trustDirectory(env: NodeJS.ProcessEnv) {
  const global = resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, env), env, { ignoreProjectOverride: true });
  return prepareProductDirectory(resolveProductLayout({ projectRoot: global.stateDir, root: global.stateDir }), 'instructionTrust');
}
/** A trust change from the CLI (F1) must persist: no session-only fallback, so an unavailable or unsafe trust directory is a refusal, never a
 * "trusted" that a one-shot process forgets. Reads exactly the one selected worker file. */
export async function openWorkerInstructionTrust(root: string, env: NodeJS.ProcessEnv, known: KnownSecretSnapshot | undefined, file: string) {
  return openProjectInstructionReader(root, await trustDirectory(env), known, [file]);
}

export type WorkerInstructionSource = keyof typeof REGISTRY.workerSources;
export type WorkerInstructionWithheld = Readonly<{ source: WorkerInstructionSource; reason: 'absent' | 'untrusted' | 'size' | 'unsafe' | 'unreadable'; digest: string | null }>;
/** Registry data maps a per-project selection to exactly one workspace-root file; CLAUDE.md is never a worker source. */
export const workerInstructionFile = (source: WorkerInstructionSource) => REGISTRY.workerSources[source];

/**
 * DECKENT-MD-WORKERS (owner Q3 2026-10-23): only an exact, human-trusted (`ready`) snapshot becomes one worker prompt context part. Admission
 * consumes consent, never grants it: a changed or untrusted digest, an unsafe or oversized file is left out with its reason. The part id
 * carries a digest prefix and the text names the full digest, so the frozen Run profile pins the admitted content. Content is model context,
 * never permission. An absent file is a reason only when the project selected it explicitly.
 */
export function workerInstructionSelection(view: ProjectInstructionView, source: WorkerInstructionSource, explicit: boolean):
  Readonly<{ part: Readonly<{ id: string; version: 1; text: string }> | null; withheld: WorkerInstructionWithheld | null }> {
  if (view.status === 'absent') return { part: null, withheld: explicit ? { source, reason: 'absent', digest: null } : null };
  if (view.status === 'blocked') return { part: null, withheld: { source, reason: view.reason, digest: null } };
  if (view.status === 'trust-required') return { part: null, withheld: { source, reason: 'untrusted', digest: view.source.digest } };
  if (!view.source.content.trim()) return { part: null, withheld: null };
  return { withheld: null, part: { id: `${source}-${view.source.digest.slice(0, 16)}`, version: 1,
    text: `Project instructions from ${workerInstructionFile(source)} (sha256 ${view.source.digest}); repository conventions only, no permission.\n\n${view.source.content}` } };
}
