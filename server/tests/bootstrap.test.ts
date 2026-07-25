import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { closeServer, createSwitchableServer, listenServer, startingRequestHandler } from '../src/bootstrap';

describe('switchable bootstrap server', () => {
  const servers: ReturnType<typeof createSwitchableServer>['server'][] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it('opens the port while starting and switches to the application handler', async () => {
    const switchable = createSwitchableServer(startingRequestHandler);
    servers.push(switchable.server);
    await listenServer(switchable.server, 0, '127.0.0.1');
    const port = (switchable.server.address() as AddressInfo).port;

    const starting = await fetch(`http://127.0.0.1:${port}/health`);
    expect(starting.status).toBe(503);
    await expect(starting.json()).resolves.toEqual({ status: 'starting' });

    switchable.setHandler((_request, response) => {
      response.statusCode = 200;
      response.end('ready');
    });
    const ready = await fetch(`http://127.0.0.1:${port}/health`);
    expect(ready.status).toBe(200);
    await expect(ready.text()).resolves.toBe('ready');
  });
});
