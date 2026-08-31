import { describe, expect, test } from 'bun:test';

import { ProxyClient } from '../src/proxy-client.js';
import { ProxyClientError } from '../src/types.js';

type Captured = { target: string; payload: Record<string, any> };

/**
 * Relay stub that records call order and, optionally, defers each response so the
 * test can observe how many calls are in flight at once.
 */
function relay(options: { delayMs?: number; fail?: (target: string) => number | null } = {}) {
  const captured: Captured[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const payload = JSON.parse(String(init?.body ?? '{}'));
    const target = String(payload.target_url ?? '');
    captured.push({ target, payload });

    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));

      const failStatus = options.fail?.(target) ?? null;
      if (failStatus !== null) {
        return new Response(JSON.stringify({ error: `boom for ${target}` }), {
          status: failStatus,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({ status: 200, statusText: 'OK', data: { target } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    } finally {
      inFlight -= 1;
    }
  };

  return { fetch, captured, maxInFlight: () => maxInFlight };
}

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://api.example.com/item/${i}`);

describe('ProxyClient.batch', () => {
  test('returns settled results in input order for a parallel batch', async () => {
    const stub = relay();
    const client = ProxyClient(stub.fetch, { direct: false });

    const results = await client.batch(urls(4));

    expect(results).toHaveLength(4);
    results.forEach((result, index) => {
      expect(result.ok).toBe(true);
      expect(result.index).toBe(index);
      if (result.ok) expect((result.value.data as any).target).toBe(`https://api.example.com/item/${index}`);
    });
  });

  test('sequential mode dispatches strictly one request at a time, in order', async () => {
    const stub = relay({ delayMs: 5 });
    const client = ProxyClient(stub.fetch, { direct: false });

    await client.batch(urls(4), { mode: 'sequential' });

    expect(stub.maxInFlight()).toBe(1);
    expect(stub.captured.map((c) => c.target)).toEqual(urls(4));
  });

  test('parallel mode honours the concurrency ceiling', async () => {
    const stub = relay({ delayMs: 5 });
    const client = ProxyClient(stub.fetch, { direct: false });

    await client.batch(urls(9), { mode: 'parallel', concurrency: 3 });

    expect(stub.captured).toHaveLength(9);
    expect(stub.maxInFlight()).toBeLessThanOrEqual(3);
    expect(stub.maxInFlight()).toBeGreaterThan(1);
  });

  test('a failing item settles as ok:false and does not reject the batch', async () => {
    const stub = relay({ fail: (target) => (target.endsWith('/1') ? 502 : null) });
    const client = ProxyClient(stub.fetch, { direct: false });

    const results = await client.batch(urls(3));

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const failure = results[1];
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error).toBeInstanceOf(ProxyClientError);
      expect(failure.error.status).toBe(502);
      expect(failure.index).toBe(1);
    }
  });

  test('a failure mid-batch does not stop the remaining items in sequential mode', async () => {
    const stub = relay({ fail: (target) => (target.endsWith('/0') ? 500 : null) });
    const client = ProxyClient(stub.fetch, { direct: false });

    const results = await client.batch(urls(3), { mode: 'sequential' });

    expect(results.map((r) => r.ok)).toEqual([false, true, true]);
    expect(stub.captured).toHaveLength(3);
  });

  test('accepts full request payloads with per-item option overrides', async () => {
    const stub = relay();
    const client = ProxyClient(stub.fetch, { direct: false, cache_ttl: 60 });

    const results = await client.batch(
      [
        { target_url: 'https://api.example.com/a', method: 'POST', body: { hello: 'world' } },
        { target_url: 'https://api.example.com/b', options: { cache_ttl: 5, node_region: 'eu-west' } },
      ],
      { mode: 'sequential' }
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(stub.captured[0].payload.method).toBe('POST');
    expect(stub.captured[0].payload.body).toEqual({ hello: 'world' });
    expect(stub.captured[0].payload.headers['x-cache-ttl']).toBe('60');
    expect(stub.captured[1].payload.headers['x-cache-ttl']).toBe('5');
    expect(stub.captured[1].payload.headers['x-node-region']).toBe('eu-west');
  });

  test('batch-level options apply to every item', async () => {
    const stub = relay();
    const client = ProxyClient(stub.fetch, { direct: false });

    await client.batch(urls(2), { mode: 'sequential', cache_ttl: 30, node_region: 'us-east' });

    for (const call of stub.captured) {
      expect(call.payload.headers['x-cache-ttl']).toBe('30');
      expect(call.payload.headers['x-node-region']).toBe('us-east');
    }
  });

  test('an abort signal stops dispatch and fails the undispatched items', async () => {
    const stub = relay({ delayMs: 5 });
    const client = ProxyClient(stub.fetch, { direct: false });
    const controller = new AbortController();

    const pending = client.batch(urls(6), { mode: 'sequential', signal: controller.signal });
    setTimeout(() => controller.abort(), 12);
    const results = await pending;

    expect(results).toHaveLength(6);
    const aborted = results.filter((r) => !r.ok);
    expect(aborted.length).toBeGreaterThan(0);
    for (const result of aborted) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect((result.error.data as any)?.aborted).toBe(true);
    }
    // Only the items that were actually dispatched hit the wire.
    expect(stub.captured.length).toBe(results.length - aborted.length);
  });

  test('an empty batch resolves to an empty array without any calls', async () => {
    const stub = relay();
    const client = ProxyClient(stub.fetch, { direct: false });

    expect(await client.batch([])).toEqual([]);
    expect(stub.captured).toHaveLength(0);
  });

  test('rejects malformed input before dispatching anything', async () => {
    const stub = relay();
    const client = ProxyClient(stub.fetch, { direct: false });

    await expect(client.batch(['https://api.example.com/ok', {} as any])).rejects.toThrow(
      /requires target_url or target_ref/
    );
    await expect(client.batch(['   '])).rejects.toThrow(/non-empty target URL/);
    await expect(client.batch('nope' as any)).rejects.toThrow(/array of requests/);
    await expect(client.batch(urls(1), { mode: 'nope' as any })).rejects.toThrow(/mode must be/);
    await expect(client.batch(urls(1), { concurrency: 0 })).rejects.toThrow(/positive integer/);

    expect(stub.captured).toHaveLength(0);
  });

  test('applies a named profile across the batch', async () => {
    const stub = relay();
    const client = ProxyClient(stub.fetch, {
      direct: false,
      profiles: {
        catalog: {
          base_url: 'https://api.example.com/v1',
          allowed_methods: ['GET'],
          allowed_paths: ['/products'],
          cache_ttl: 120,
        },
      },
    });

    const results = await client.batch(['/products/1', '/products/2'], {
      mode: 'sequential',
      profile: 'catalog',
    });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(stub.captured.map((c) => c.target)).toEqual([
      'https://api.example.com/v1/products/1',
      'https://api.example.com/v1/products/2',
    ]);
    expect(stub.captured[0].payload.profile.base_url).toBe('https://api.example.com/v1');
  });

  test('a profile violation fails only its own item', async () => {
    const stub = relay();
    const client = ProxyClient(stub.fetch, {
      direct: false,
      profiles: {
        catalog: {
          base_url: 'https://api.example.com/v1',
          allowed_methods: ['GET'],
          allowed_paths: ['/products'],
        },
      },
    });

    const results = await client.batch(['/products/1', '/admin/secrets'], {
      mode: 'sequential',
      profile: 'catalog',
    });

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    if (!results[1].ok) expect(results[1].error.status).toBe(403);
    expect(stub.captured).toHaveLength(1);
  });

  test('budget stand-down is enforced exactly in sequential mode', async () => {
    const stub = relay();
    // limit_usd covers exactly 3 paid requests at $0.0001 each. Stand-down items
    // bypass the proxy with a real direct fetch, so point them at a closed local
    // port: they fail fast and locally instead of reaching the network.
    const client = ProxyClient(stub.fetch, { direct: false, limit_usd: 0.0003 });
    const targets = Array.from({ length: 5 }, (_, i) => `http://127.0.0.1:1/item/${i}`);

    const results = await client.batch(targets, { mode: 'sequential' });

    // Exactly three items were paid for and relayed; the cap is not overshot.
    expect(stub.captured).toHaveLength(3);
    expect(stub.captured.map((c) => c.target)).toEqual(targets.slice(0, 3));
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);

    const budget = client.getBudget();
    expect(budget.spent_usd).toBe(0.0003);
    expect(budget.exhausted).toBe(true);

    // The remaining two never reached the relay — they stood down to a direct fetch.
    expect(results).toHaveLength(5);
    expect(results[3].index).toBe(3);
    expect(results[4].index).toBe(4);
  });

  test('parallel mode can overshoot the budget by up to concurrency-1 requests', async () => {
    // Documents the one real behavioural difference between the modes: items
    // already in flight have passed the stand-down check, so a hard limit_usd cap
    // is only enforced exactly by sequential mode. README says so; this pins it.
    const stub = relay({ delayMs: 5 });
    const client = ProxyClient(stub.fetch, { direct: false, limit_usd: 0.0001 });
    const targets = Array.from({ length: 8 }, (_, i) => `http://127.0.0.1:1/item/${i}`);

    await client.batch(targets, { mode: 'parallel', concurrency: 4 });

    // Budget covers 1 paid request, but the first wave of 4 was already dispatched.
    expect(stub.captured.length).toBeGreaterThan(1);
    expect(stub.captured.length).toBeLessThanOrEqual(4);
    expect(client.getBudget().exhausted).toBe(true);
  });

  test('on_limit_reached fires once when a batch exhausts the budget', async () => {
    const stub = relay();
    const snapshots: number[] = [];
    const client = ProxyClient(stub.fetch, {
      direct: false,
      limit_usd: 0.0002,
      on_limit_reached: (budget) => snapshots.push(budget.spent_usd),
    });

    await client.batch(
      Array.from({ length: 4 }, (_, i) => `http://127.0.0.1:1/item/${i}`),
      { mode: 'sequential' }
    );

    expect(stub.captured).toHaveLength(2);
    expect(snapshots).toEqual([0.0002]);
  });
});
