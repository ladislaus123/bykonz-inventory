export type FetchCall = { url: string; init: RequestInit | undefined };

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Replace global fetch for the duration of a test. Always call the returned restore. */
export function useFetch(handler: FetchHandler): { restore: () => void; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.href;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
