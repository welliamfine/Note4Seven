import { createServer, type RequestListener, type Server } from 'node:http';

export function startingRequestHandler(_request: Parameters<RequestListener>[0], response: Parameters<RequestListener>[1]): void {
  response.statusCode = 503;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ status: 'starting' }));
}

export function createSwitchableServer(initialHandler: RequestListener): {
  server: Server;
  setHandler: (handler: RequestListener) => void;
} {
  let activeHandler = initialHandler;
  const server = createServer((request, response) => activeHandler(request, response));
  return {
    server,
    setHandler(handler) {
      activeHandler = handler;
    },
  };
}

export async function listenServer(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
