import { createServer, type Server, type Socket } from 'node:net';
/** A loopback TCP fixture whose connections cannot raise an uncaught exception: the peer of a probe (a shell `/dev/tcp` client, a
 * sandbox that exits mid-exchange) may reset the connection at any time, and an unhandled 'error' on a server-side socket would
 * abort the whole test run (vitest "Uncaught Exception: read ECONNRESET") instead of failing or passing the test that owns it. */
export async function listenTcpFixture(onConnection: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => { socket.on('error', () => undefined); onConnection(socket); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}
