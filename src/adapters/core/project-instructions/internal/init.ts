import { basename } from 'node:path';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstructionInitPreview, InstructionFileChange } from '#engine/index.js';
import { instructionDigest, PROJECT_INSTRUCTION_REGISTRY as registry, readInstructionFile } from './files.js';

/** Derived project facts only; scripts are described by npm script name and never executed. */
export async function previewProjectInstructions(root: string, selected: readonly string[], skeleton: (name: string, commands: readonly string[]) => string): Promise<InstructionInitPreview> {
  if (selected.some(id => !registry.bridges.some(row => row.id === id)) || new Set(selected).size !== selected.length) throw new Error('unsafe');
  const exists = async (name: string) => { try { const info = await lstat(join(root, name)); return !info.isSymbolicLink(); } catch { return false; } };
  const bridges = await Promise.all(registry.bridges.map(async row => ({ ...row, detected: await exists(row.path) || await exists(row.marker) })));
  const project = await readInstructionFile(root, 'package.json', registry.projectFactsMaxBytes);
  let name = basename(root), commands: string[] = [];
  if (project) {
    const value = JSON.parse(project.toString('utf8')) as { name?: unknown; scripts?: unknown };
    if (typeof value.name === 'string') name = value.name;
    if (value.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts)) commands = Object.keys(value.scripts).filter(key => /^[a-zA-Z0-9:_-]+$/.test(key)).sort().map(key => `npm run ${key}`);
  }
  const changes: InstructionFileChange[] = [];
  const before = await readInstructionFile(root, registry.files[0]!, registry.maxBytes);
  if (before === null) {
    const after = skeleton(name, commands);
    if (Buffer.byteLength(after) > registry.maxBytes) throw new Error('size');
    changes.push({ path: registry.files[0]!, before: null, beforeDigest: 'absent', after, append: after });
  }
  for (const row of bridges.filter(bridge => selected.includes(bridge.id))) {
    const bytes = await readInstructionFile(root, row.path, registry.maxBytes);
    const before = bytes?.toString('utf8') ?? null;
    if (before?.split(/\r?\n/).some(line => line.trim() === row.line)) continue;
    const append = `${before && !before.endsWith('\n') ? '\n' : ''}${row.line}\n`;
    const after = (before ?? '') + append;
    if (Buffer.byteLength(after) > registry.maxBytes) throw new Error('size');
    changes.push({ path: row.path, before, beforeDigest: bytes === null ? 'absent' : instructionDigest(bytes), after, append });
  }
  return { schemaVersion: 1, digest: instructionDigest(JSON.stringify(changes)), changes, bridges };
}
