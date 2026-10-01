import { connect } from 'node:net';
import { expect, it } from 'vitest';
import { listenTcpFixture } from './tcp-fixture-server.js';
it('a client that resets the connection after the server wrote does not raise an uncaught exception', async () => {
  const { server, port } = await listenTcpFixture(socket => socket.write('hello'));
  const client = connect(port, '127.0.0.1'); await new Promise(resolve => client.once('data', resolve));
  client.resetAndDestroy();
  await new Promise(resolve => setTimeout(resolve, 100));
  await new Promise<void>(resolve => server.close(() => resolve()));
  expect(server.listening).toBe(false);
});
