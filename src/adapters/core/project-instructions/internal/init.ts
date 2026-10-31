import { basename } from 'node:path';
import type { InstructionInitPreview, InstructionFileChange } from '#engine/index.js';
import { instructionDigest, PROJECT_INSTRUCTION_REGISTRY as registry, readInstructionFile } from './files.js';

/** Derived project facts only; scripts are described by npm script name and never executed. */
export async function previewProjectInstructions(root: string, selected: readonly string[], skeleton: (name: string, commands: readonly string[]) => string): Promise<InstructionInitPreview> {
  if (selected.length) throw new Error('unsafe');
  const project = await readInstructionFile(root, 'package.json', registry.projectFactsMaxBytes);
  let name = basename(root), commands: string[] = [];
  if (project) {
    const value = JSON.parse(project.toString('utf8')) as { name?: unknown; scripts?: unknown };
    if (typeof value.name === 'string') name = value.name;
    if (value.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts)) commands = Object.keys(value.scripts).filter(key => /^[a-zA-Z0-9:_-]+$/.test(key)).sort().map(key => `npm run ${key}`);
  }
  const changes: InstructionFileChange[] = [];
  const target = registry.terminalFiles[0]!;
  const existing = await Promise.all(registry.terminalFiles.slice(0, -1).map(name => readInstructionFile(root, name, registry.maxBytes)));
  if (existing.every(bytes => bytes === null)) {
    const after = skeleton(name, commands);
    if (Buffer.byteLength(after) > registry.maxBytes) throw new Error('size');
    changes.push({ path: target, before: null, beforeDigest: 'absent', after, append: after });
  }
  return { schemaVersion: 1, digest: instructionDigest(JSON.stringify(changes)), changes, bridges: [] };
}

/** Read-only migration observation: never opens or creates a trust store. */
export async function legacyProjectInstructions(root: string): Promise<boolean> {
  for (const name of registry.terminalFiles) if (await readInstructionFile(root, name, registry.maxBytes) !== null) return name === registry.terminalFiles.at(-1);
  return false;
}
