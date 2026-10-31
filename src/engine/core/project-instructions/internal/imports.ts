import { z } from 'zod';
/** Only relative @ paths outside Markdown code are imports; email addresses and quoted mentions stay literal. */
export function instructionImports(text: string): readonly string[] {
  let fence = '';
  return text.split(/\r?\n/u).flatMap(line => {
    const mark = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (mark) { if (!fence) fence = mark; else if (mark[0] === fence[0] && mark.length >= fence.length) fence = ''; return []; }
    if (fence) return [];
    return [...line.replace(/(`+)[\s\S]*?\1/gu, '').matchAll(/(?:^|\s)@((?:\\ |[^\s`"'<>])+)/gu)].map(match => match[1]!.replace(/\\ /gu, ' '));
  });
}
const instructionDepthSchema = z.number().int().min(0).max(5);
export interface InstructionImportFile { readonly path: string; readonly text: string; readonly bytes: number; readonly binding: string; readonly external: boolean }
/** Port-driven, deterministic graph expansion. No filesystem or trust authority; the caller masks the completed snapshot. */
export async function expandInstructionImports(first: InstructionImportFile, limits: Readonly<{ maxDepth: number; maxBytes: number }>,
  read: (from: string, relative: string, remaining: number) => Promise<InstructionImportFile | null>) {
  if (!instructionDepthSchema.safeParse(limits.maxDepth).success || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) throw new Error('unsafe');
  const active = new Set<string>(), seen = new Set<string>(), files: InstructionImportFile[] = [];
  let bytes = 0;
  const visit = async (file: InstructionImportFile, depth: number): Promise<void> => {
    if (active.has(file.path) || depth > limits.maxDepth) throw new Error('unsafe');
    if (seen.has(file.path)) return;
    bytes += file.bytes;
    if (bytes > limits.maxBytes) throw new Error('size');
    seen.add(file.path); active.add(file.path); files.push(file);
    for (const name of instructionImports(file.text)) {
      if (/^(?:[\\/]|[a-zA-Z]:|~)/u.test(name) || name.includes('\0')) throw new Error('unsafe');
      if (depth === limits.maxDepth) throw new Error('unsafe');
      const next = await read(file.path, name, limits.maxBytes - bytes);
      if (!next) throw new Error('unreadable');
      await visit(next, depth + 1);
    }
    active.delete(file.path);
  };
  await visit(first, 0);
  return { content: files.map(file => file.text).join('\n'), bytes, files,
    binding: JSON.stringify(files.map(file => [file.path, file.binding, file.text])), external: files.some(file => file.external) };
}
