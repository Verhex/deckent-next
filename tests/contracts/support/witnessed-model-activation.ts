import { fileURLToPath } from 'node:url';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { ModelActivationResult, ModelCatalogResult } from '../../../src/index.js';
import { personEnv } from './person-env.js';
import { lastJson, runInTerminal } from './terminal-cli.js';

type Command = Readonly<Record<string, unknown>>;
type Result = {
  applyModelCatalog: ModelCatalogResult;
  admitModelActivation: ModelActivationResult;
  carryConfiguredModelActivation: ModelActivationResult;
};

const program = `
  const [entry, owner, root, ...commands] = process.argv.slice(1);
  const sdk = await import(entry);
  const results = [];
  for (const command of commands) results.push(await sdk[owner](root, JSON.parse(command)));
  console.log(JSON.stringify({ results }));
`;

export function witnessedModelActivation<K extends keyof Result>(owner: K, root: string, options: ConfigLoadOptions, command: Command): Promise<Result[K]>;
export function witnessedModelActivation<K extends keyof Result>(owner: K, root: string, options: ConfigLoadOptions, commands: readonly Command[]): Promise<Result[K][]>;
/** Run only fixture activation setup on the person's controlling terminal. */
export async function witnessedModelActivation<K extends keyof Result>(owner: K, root: string, options: ConfigLoadOptions,
  input: Command | readonly Command[]): Promise<Result[K] | Result[K][]> {
  const entry = owner === 'carryConfiguredModelActivation' ? '../../../dist/composition/core/model-activation/index.js' : '../../../dist/index.js';
  const commands = Array.isArray(input) ? input : [input];
  const result = await runInTerminal([process.execPath, '--input-type=module', '-e', program, fileURLToPath(new URL(entry, import.meta.url)),
    owner, root, ...commands.map(command => JSON.stringify(command))], root, personEnv({ HOME: process.env.HOME, ...options.env }));
  const output = lastJson(result.output) as { results?: Result[K][] } | null;
  if (result.code !== 0 || output?.results?.length !== commands.length) throw new Error(`Witnessed model activation fixture failed (${result.code}): ${result.output}`);
  return Array.isArray(input) ? output.results : output.results[0]!;
}
