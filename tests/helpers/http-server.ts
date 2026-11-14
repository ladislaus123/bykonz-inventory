import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';

export interface TestResponse {
  status: number;
  body: unknown;
  text: string;
}

/** Listen on an ephemeral port, run `fn`, then close the server. */
export async function withServer(app: Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export async function request(
  base: string,
  method: string,
  path: string,
  opts?: { json?: unknown; headers?: Record<string, string> },
): Promise<TestResponse> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts?.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts?.headers,
    },
    body: opts?.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  } else {
    body = null;
  }
  return { status: res.status, body, text };
}
