import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// No downloads or implicit installation: release packaging supplies platform artifacts.
if (process.platform !== 'linux') {
  process.stdout.write('local-peer-credentials: unsupported platform; no Linux artifact built\n');
} else {
  const testFaults = process.argv.slice(2).includes('--test');
  const out = resolve(import.meta.dirname, `build/${testFaults ? 'Test' : 'Release'}/peer_credentials.node`);
  mkdirSync(dirname(out), { recursive: true });
  const include = process.env.DECKENT_NODE_HEADERS ?? resolve(dirname(dirname(process.execPath)), 'include/node');
  execFileSync(process.env.CXX ?? 'c++', ['-std=c++20', '-O2', '-fPIC', '-shared', '-DNAPI_VERSION=10',
    ...(testFaults ? ['-DDECKENT_LOCAL_PEER_TEST_FAULTS'] : []),
    `-I${include}`, 'local_peer_credentials.cc', '-o', out], { cwd: import.meta.dirname, stdio: 'inherit' });
}
