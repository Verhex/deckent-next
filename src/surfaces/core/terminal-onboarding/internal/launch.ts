import { ErrorRegistry } from '#platform/index.js';
type Action = 'status' | 'session' | 'workline' | 'snapshot' | 'chat-plan';
interface Parsed { action: Action; json: boolean; help: boolean; fullAccess: boolean; trustDigest?: string; language?: string; scopeId?: string }
const ACTIONS: readonly Action[] = ['status', 'session', 'workline', 'snapshot', 'chat-plan'];
export function parseTerminalLaunch(argv: readonly string[]): Parsed {
  // Bare `deckent terminal` (options only) is the interactive terminal, the same as `deckent` with no arguments on a TTY.
  const named = argv[1] !== undefined && !argv[1].startsWith('-');
  const action = (named ? argv[1] : 'workline') as Action;
  if (argv[0] !== 'terminal' || !ACTIONS.includes(action)) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed: Parsed = { action, json: false, help: false, fullAccess: false };
  for (let index = named ? 2 : 1; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (key === '--help') parsed.help = true;
    else if (key === '--full-access') parsed.fullAccess = true;
    else if (key === '--trust-instructions' && parsed.trustDigest === undefined) {
      const digest = argv[++index]; if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw ErrorRegistry.createError('CLI_USAGE'); parsed.trustDigest = digest;
    }
    else if (key === '--json') parsed.json = true;
    else if (key === '--no-color') continue;
    else if (key === '--lang' || key === '--scope') {
      const value = argv[++index];
      if (!value || value.startsWith('-') || (key === '--lang' ? parsed.language : parsed.scopeId) !== undefined) throw ErrorRegistry.createError('CLI_USAGE');
      if (key === '--lang') parsed.language = value; else parsed.scopeId = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (parsed.help && parsed.json) throw ErrorRegistry.createError('CLI_USAGE');
  if (parsed.json && (parsed.action === 'session' || parsed.action === 'workline')) throw ErrorRegistry.createError('CLI_USAGE');
  // Full access is a launch of the interactive terminal only (MODES-3); no other action runs agent tools.
  if (parsed.fullAccess && parsed.action !== 'workline') throw ErrorRegistry.createError('CLI_USAGE');
  if (parsed.trustDigest && parsed.action !== 'session') throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}

