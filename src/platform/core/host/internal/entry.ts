import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** npm bin links and Node's preserve-symlinks-main mode may spell the same entry differently.
 * This detects executable startup only; importing an entry must not start a CLI or stdio server.
 */
export function isMainModule(meta: Readonly<{ url: string; main?: boolean }>): boolean {
  if (typeof meta.main === 'boolean') return meta.main;
  // import.meta.main arrived after the supported Node 24.0 floor. Eval/stdin arguments are not entry files.
  const scriptPath = process.argv[1];
  if (!scriptPath || scriptPath === '-' || process.execArgv.some(arg => /^(?:--(?:eval|print)(?:=|$)|-[ep])/.test(arg))) return false;
  try { return realpathSync(fileURLToPath(meta.url)) === realpathSync(scriptPath); }
  catch { return false; }
}
