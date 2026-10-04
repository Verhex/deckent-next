import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

// Preparation envelope only. Graph/workInput syntax and DAG invariants belong to
// the existing domain validator; active models/templates are admitted by run create.
export const CARD_SET_SCHEMA_VERSION = 1;
export const HOST_CARD_INPUT_MAX_BYTES = 1_048_576;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = () => { throw new Error('N1_CARD_INPUT_INVALID'); };

/** No I/O, catalog lookup, alias resolution, profile construction or dispatch. */
export function prepareCardGraph(input, validateTaskGraph) {
  if (!object(input) || input.schemaVersion !== CARD_SET_SCHEMA_VERSION || !Array.isArray(input.cards)
    || input.cards.length === 0 || Object.hasOwn(input, 'tasks') || typeof validateTaskGraph !== 'function') refuse();
  const cards = input.cards; const graphFields = { ...input };
  delete graphFields.schemaVersion; delete graphFields.cards;
  const tasks = cards.map(card => {
    if (!object(card) || typeof card.templateKind !== 'string' || card.workInput === undefined
      || Object.hasOwn(card, 'kind')) refuse();
    const { templateKind, ...taskFields } = card;
    return { ...taskFields, kind: templateKind };
  });
  // Existing v4 is required only by explicit structured dependency edges. Plain
  // string edges retain v3 fixed-base semantics; never upgrade their meaning.
  const schemaVersion = tasks.some(task => Array.isArray(task.dependencies)
    && task.dependencies.some(edge => typeof edge !== 'string')) ? 4 : 3;
  return validateTaskGraph({ ...graphFields, schemaVersion, tasks });
}

/** One bounded regular-file read; no output/config/registry files are written. */
export async function readCardSet(path) {
  // Nonblocking open lets fstat reject a FIFO/device without waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > HOST_CARD_INPUT_MAX_BYTES) throw new Error('N1_CARD_INPUT_LIMIT');
    const buffer = Buffer.alloc(HOST_CARD_INPUT_MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes > HOST_CARD_INPUT_MAX_BYTES) throw new Error('N1_CARD_INPUT_LIMIT');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
  } finally { await file.close(); }
}

// Requires this checkout's previously built domain artifact. No runtime bootstrap,
// auto-build, provider query or alternate validator is attempted if it is absent.
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('N1_CARD_USAGE');
    const { validateTaskGraph } = await import('../../dist/domain/core/task-graph/index.js');
    const graph = prepareCardGraph(await readCardSet(process.argv[2]), validateTaskGraph);
    process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^TASK_[A-Z_]+$/.test(error.code) ? error.code
      : /^N1_CARD_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'N1_CARD_PREPARATION_FAILED';
    process.stderr.write(JSON.stringify({ error: code, preparationOnly: true }) + '\n');
    process.exitCode = 1;
  }
}
