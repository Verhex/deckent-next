import { Socket } from 'node:net';

// Real OS process with a controlling terminal, using the installed local wire contract.
const [endpoint, encoded, automatic] = process.argv.slice(2);
const request = JSON.parse(encoded);
const events = [], decisions = [];
async function send(value, onEvent = () => undefined) {
  const socket = new Socket({ allowHalfOpen: true });
  let bytes = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('fixture timeout')); }, 20_000);
    socket.on('error', reject);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4 && bytes.length >= bytes.readUInt32BE(0) + 4) {
        const length = bytes.readUInt32BE(0), frame = JSON.parse(bytes.subarray(4, length + 4));
        bytes = bytes.subarray(length + 4);
        if (frame.kind === 'event') for (const event of frame.events) onEvent(event);
        else { clearTimeout(timer); socket.destroy(); resolve(frame); }
      }
    });
    socket.connect(endpoint, () => {
      const payload = Buffer.from(JSON.stringify(value)), prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(payload.length); socket.end(Buffer.concat([prefix, payload]));
    });
  });
}
const response = await send(request, event => {
  events.push(event);
  if (event.kind === 'approval.requested' && automatic) decisions.push(send({ schemaVersion: request.schemaVersion,
    requestId: `decision-${event.approvalId}`, operation: 'decideApproval', delivery: { maxResultBytes: 65536 },
    input: { schemaVersion: 1, commandId: `answer-${event.approvalId}`, scopeId: request.input.scopeId, approvalId: event.approvalId,
      expectedRevision: event.revision, decision: automatic, reason: 'Reviewed in terminal', channel: 'local-terminal-card', decisionCapability: event.decisionCapability } }));
});
process.stderr.write(JSON.stringify({ response, events, decisions: await Promise.all(decisions) }) + '\n');
