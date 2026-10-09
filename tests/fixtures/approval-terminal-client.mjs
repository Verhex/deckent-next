import { createReadStream, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createConfiguredRuntimeClient } from '../../dist/composition/core/runtime-service/index.js';

// SDK calls and their approval callbacks share this real terminal process.
const client = createConfiguredRuntimeClient(process.argv[2], JSON.parse(process.argv[3]));
const controllers = new Map();
const write = value => writeSync(4, JSON.stringify(value) + '\n');
write({ ready: { pid: process.pid, uid: process.getuid(), gid: process.getgid() } });
createInterface({ input: createReadStream('', { fd: 3 }), terminal: false }).on('line', async line => {
  const { id, method, args, abort } = JSON.parse(line);
  if (abort) { controllers.get(id)?.abort(); return; }
  const controller = new AbortController(); controllers.set(id, controller);
  const decoded = args.map((value, index) => value?.fixture === 'callback' ? event => write({ id, event, index })
    : value?.fixture === 'signal' ? controller.signal : value?.fixture === 'undefined' ? undefined : value);
  try { write({ id, result: await client[method](...decoded) }); }
  catch (error) { write({ id, error: { code: error.code, params: error.params, message: error.message } }); }
  finally { controllers.delete(id); }
});
