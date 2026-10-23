// A stand-in for $EDITOR (T4 tests): the last argument is the draft file; FIXTURE_EDITOR_MODE says what the "person" does.
import { appendFileSync, lstatSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const file = process.argv.at(-1), mode = process.env.FIXTURE_EDITOR_MODE ?? 'append', report = process.env.FIXTURE_EDITOR_REPORT;
if (report) writeFileSync(report, JSON.stringify({ args: process.argv.slice(2), file, fileMode: lstatSync(file).mode & 0o777, dirMode: statSync(dirname(file)).mode & 0o777 }));
if (mode === 'append') appendFileSync(file, ' edited\n');
else if (mode === 'fail') { appendFileSync(file, ' discarded'); process.exit(3); }
else if (mode === 'link') { unlinkSync(file); symlinkSync('/etc/hostname', file); }
else if (mode === 'huge') writeFileSync(file, 'x'.repeat(Number(process.env.FIXTURE_EDITOR_BYTES)));
else if (mode === 'backup') { appendFileSync(file, '!'); writeFileSync(`${file}~`, 'backup copy'); }
