import { z } from 'zod';

/**
 * C2 (owner Q4 2026-10-23): the repository instruction surface a worker checkout leaves out. Exactly two literal forms, so a Git
 * sparse pattern built from an entry and {@link workspacePathHidden} mean the same thing: `name` is every file or directory with that
 * exact name at any depth (with everything under a directory); `/a/b` is that one repository-root path (file, or directory and
 * everything under it). No wildcards, negations, comments or trailing slashes. This hides content from automatic discovery only: the
 * objects stay in the clone, so it is a context-cost measure, never confidentiality.
 */
const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,127}$|^\.[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,126}$/u;
export const workspaceHiddenPathSchema = z.string().min(1).max(256).refine(value => {
  const anchored = value.startsWith('/'), parts = (anchored ? value.slice(1) : value).split('/');
  return (anchored || parts.length === 1) && parts.every(part => SEGMENT.test(part));
});
export const workspaceHiddenPathsSchema = z.array(workspaceHiddenPathSchema).min(1).max(32)
  .refine(values => new Set(values).size === values.length).readonly();
export type WorkspaceHiddenPaths = z.infer<typeof workspaceHiddenPathsSchema>;

/** Whether a repository-relative path (`a/b/c`, no leading slash) is inside the hidden set. */
export function workspacePathHidden(path: string, hidden: readonly string[]): boolean {
  const parts = path.split('/');
  return hidden.some(entry => entry.startsWith('/') ? path === entry.slice(1) || path.startsWith(`${entry.slice(1)}/`) : parts.includes(entry));
}

/**
 * G1: the changed paths inside the instruction surface `hidden` that `declared` (a task's K6 scope) does not name explicitly. Explicit is the
 * exact path, or a wildcard-free `dir/**` whose `dir` is itself inside the surface (`.agents/**` names `.agents/x`); a glob or a parent
 * directory that merely contains it (`**`, `src/**` for `src/AGENTS.md`) is never a grant. No declared scope grants nothing.
 */
export function instructionSurfaceWrites(paths: readonly string[], hidden: readonly string[], declared: readonly string[] | null): readonly string[] {
  const directories = (declared ?? []).flatMap(entry => entry.endsWith('/**') && !/[*?]/u.test(entry.slice(0, -3)) && workspacePathHidden(entry.slice(0, -3), hidden) ? [`${entry.slice(0, -3)}/`] : []);
  return Object.freeze(paths.filter(path => workspacePathHidden(path, hidden) && !declared?.includes(path) && !directories.some(dir => path.startsWith(dir))));
}
