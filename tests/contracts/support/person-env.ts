import { AGENT_ENVIRONMENT } from '#surfaces/core/cli-human/index.js';

/** C-ADMIN: a person's terminal for a PTY-driven CLI child — the caller's environment without the AI-agent and CI markers the CLI reads
 * (an agent or CI caller is never treated as a person, so a test run by one would otherwise be refused before its prompt). */
export function personEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const markers = new Set<string>([...AGENT_ENVIRONMENT, 'CI']) // 'CI': the kit's CI marker (cli-human human.json `ciEnvironment`);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !markers.has(name)));
}
