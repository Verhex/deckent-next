/** Parent environment for a CLI child, with FORCE_COLOR removed so NO_COLOR stays silent. */
export function cliChildEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FORCE_COLOR;
  return { ...env, ...overrides };
}
