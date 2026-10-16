import { workerEventSchema, summarizeWorkerEvents } from '#domain/index.js';
/** Pure bounded sidecar projection; input loss and file identity are supplied by the guarded reader. */
export function projectLiveWorkerMetadata(text: string, maxEvents: number, watermark: string, truncated: boolean) {
  const events = []; let sourceLoss = truncated;
  let previous = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (events.length >= maxEvents) { sourceLoss = true; break; }
    try {
      const raw = JSON.parse(line) as { event?: unknown }; const event = workerEventSchema.parse(raw.event);
      if ((!previous && event.sequence !== 1) || event.sequence <= previous || (previous && event.sequence > previous + 1)) sourceLoss = true;
      previous = event.sequence;
      if (event.kind === 'dropped') sourceLoss = true;
      events.push(event);
    } catch { sourceLoss = true; }
  }
  const summary = summarizeWorkerEvents(events);
  return { watermark: `${watermark}:${previous}`, sourceLoss,
    eventCount: summary.events, inputTokens: summary.tokens.input, outputTokens: summary.tokens.output };
}
