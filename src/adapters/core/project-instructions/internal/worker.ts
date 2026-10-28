import { normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath, resolveGlobalScopePaths, resolveProductLayout, type CoreConfig, type KnownSecretSnapshot } from '#platform/index.js';
import type { CommittedInstructionSource, ProjectInstructionView } from '#engine/index.js';
import { openProjectInstructionReader } from './files.js';
import REGISTRY from './registry.json' with { type: 'json' };

/** Consent lives in the user-global private trust directory (shared by the terminal and Run admission); an unsupported platform keeps
 * consent in the session only, so a fresh process asks again and never reads an unverified cache. */
export async function openHostProjectInstructionReader(root: string, env: NodeJS.ProcessEnv, known?: KnownSecretSnapshot, files?: readonly string[],
  committed?: CommittedInstructionSource) {
  const directory = await trustDirectory(env).catch(() => null);
  return openProjectInstructionReader(root, directory, known, files, committed).catch(() => openProjectInstructionReader(root, null, known, files, committed));
}
const trustLayout = (env: Readonly<Record<string, string | undefined>>) => { const global = resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, env), env, { ignoreProjectOverride: true });
  return resolveProductLayout({ projectRoot: global.stateDir, root: global.stateDir }); };
const trustDirectory = (env: NodeJS.ProcessEnv) => prepareProductDirectory(trustLayout(env), 'instructionTrust');
/** The user-global trust directory's path, never created here (an uninstall names this folder's records in it, review M12). */
export const instructionTrustDirectory = (env: Readonly<Record<string, string | undefined>>) => productResourcePath(trustLayout(env), 'instructionTrust');
/** A trust change from the CLI (F1) must persist: no session-only fallback, so an unavailable or unsafe trust directory is a refusal, never a
 * "trusted" that a one-shot process forgets. Reads exactly the one selected worker file. */
export async function openWorkerInstructionTrust(root: string, env: NodeJS.ProcessEnv, known: KnownSecretSnapshot | undefined, file: string, committed?: CommittedInstructionSource) {
  return openProjectInstructionReader(root, await trustDirectory(env), known, [file], committed);
}

/** The file-backed sources of the config enum (published declarations must not reference the JSON module; `none` has no file). */
export type WorkerInstructionSource = Exclude<NonNullable<NonNullable<NonNullable<CoreConfig['execution']>['workerInstructions']>['source']>, 'none'>;
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
  // alpha.54 R1: a work target's file names where it was committed (ref and commit); a working-tree read keeps the alpha.53 text.
  const { identity, digest, content } = view.source, from = identity.kind === 'ref' ? `${view.source.path} at commit ${identity.commit}` : workerInstructionFile(source);
  return { withheld: null, part: { id: `${source}-${digest.slice(0, 16)}`, version: 1,
    text: `Project instructions from ${from} (sha256 ${digest}); repository conventions only, no permission.\n\n${content}` } };
}
