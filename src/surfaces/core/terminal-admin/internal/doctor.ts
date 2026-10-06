import type { OutputSink } from '#platform/index.js';

/** `/doctor`: the very report `deckent doctor` prints, captured as lines (`run` is the CLI's own doctor command writing to this sink). */
export async function doctorLines(run: (sink: OutputSink) => Promise<void>): Promise<readonly string[]> {
  let text = '';
  const sink: OutputSink = { write: chunk => { text += chunk; return true; } };
  await run(sink);
  return text.replace(/\n+$/u, '').split('\n');
}
