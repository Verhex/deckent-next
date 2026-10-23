// A stand-in for a terminal editor on a real PTY (T4): shows the draft, reads one typed line from the TTY and appends it.
// FIXTURE_TTY_EDITOR=raw takes the keys raw (vim, nano); `cooked` leaves the line discipline on, so Ctrl+C raises SIGINT for the whole group.
import { appendFileSync, readFileSync } from 'node:fs';
const file = process.argv.at(-1);
process.stdout.write(`EDITOR-OPEN[${readFileSync(file, 'utf8')}]\n`);
if ((process.env.FIXTURE_TTY_EDITOR ?? 'raw') === 'raw') process.stdin.setRawMode(true);
let typed = '';
process.stdin.on('data', chunk => {
  typed += chunk.toString('utf8');
  if (!/[\r\n]/u.test(typed)) return;
  const line = typed.replace(/[\r\n]+$/u, '');
  appendFileSync(file, ` ${line}`);
  process.stdout.write(`EDITOR-GOT[${line}]\n`);
  process.exit(0);
});
