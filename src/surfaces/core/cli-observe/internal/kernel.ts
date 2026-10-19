import { ErrorRegistry, emit, getConfigFieldDefault, resolveLocale, type ConfigLoadOptions, type Locale, type OutputMode } from '#platform/index.js';
import type { KernelCommandContext } from './context.js';
import { doctorCommand } from './doctor.js';
import { pathsCommand } from './paths.js';
import { policyVocabularyCommand } from './policy-vocabulary.js';

export interface KernelArgs { positionals: string[]; json: boolean; global: boolean; dryRun: boolean; toolchains: boolean; language?: string }
/** The shared state of one kernel command call: parsed arguments, the locale and output mode (doctor narrows both from config), one output writer. */
export interface KernelCall {
  readonly args: KernelArgs; readonly root: string; readonly env: NodeJS.ProcessEnv; readonly options: ConfigLoadOptions;
  locale: Locale; mode: OutputMode;
  output<T>(data: T, render: (data: T) => string, level?: 'info' | 'warning'): void;
}
function parse(argv: readonly string[]): KernelArgs {
  const result: KernelArgs = { positionals: [], json: false, global: false, dryRun: false, toolchains: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') result.json = true;
    else if (arg === '--global') result.global = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--toolchains') result.toolchains = true;
    else if (arg === '--no-color') continue;
    else if (arg === '--lang') {
      const language = argv[++i];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      result.language = language;
    } else if (arg.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
    else result.positionals.push(arg);
  }
  return result;
}
export async function runKernelCommand(argv: readonly string[], context: KernelCommandContext = {}): Promise<void> {
  const args = parse(argv), root = context.root ?? process.cwd(), env = context.env ?? process.env;
  const [command] = args.positionals;
  if (args.toolchains && command !== 'doctor') throw ErrorRegistry.createError('CLI_USAGE');
  const call: KernelCall = {
    args, root, env, locale: resolveLocale(args.language, env), mode: getConfigFieldDefault('output_mode'),
    output<T>(data: T, render: (data: T) => string, level: 'info' | 'warning' = 'info') {
      emit(data, { json: args.json, mode: call.mode, level, render, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
    },
    options: { env, globalOnly: args.global, onWarning: warning => call.output(warning, value => value.message, 'warning') },
  };
  context.onLocale?.(call.locale);
  if (command === 'policy') return policyVocabularyCommand(call);
  if (command === 'paths') return pathsCommand(call);
  return doctorCommand(call, context);
}
