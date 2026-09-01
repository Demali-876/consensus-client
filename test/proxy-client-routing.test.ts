import { describe, expect, test } from 'bun:test';

import { ProxyClient } from '../src/proxy-client.js';

/**
 * Reports whether a given inbound route path actually went through the paid
 * proxy. createFetch() is the honest oracle: it consults the route policy and
 * either proxies or falls through to a direct fetch.
 */
function router(options: Record<string, unknown>) {
  let relayed = false;
  const client = ProxyClient(async () => {
    relayed = true;
    return new Response(JSON.stringify({ status: 200, statusText: 'OK', data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, { ...options, direct: false } as never);

  return async (routePath: string): Promise<boolean> => {
    relayed = false;
    try {
      // Closed local port: the passthrough branch fails fast without touching the network.
      await client.createFetch(routePath)('http://127.0.0.1:1/probe');
    } catch {
      /* expected for the direct branch */
    }
    return relayed;
  };
}

describe('ProxyClient route policy', () => {
  test("mode 'only' proxies just the listed routes", async () => {
    const proxies = router({ mode: 'only', routes: ['/api'] });

    expect(await proxies('/api')).toBe(true);
    expect(await proxies('/health')).toBe(false);
    expect(await proxies('/')).toBe(false);
  });

  test("mode 'except' proxies everything but the listed routes", async () => {
    const proxies = router({ mode: 'except', routes: ['/health'] });

    expect(await proxies('/health')).toBe(false);
    expect(await proxies('/api')).toBe(true);
    expect(await proxies('/')).toBe(true);
  });

  test("defaults to 'except' with no routes, proxying everything", async () => {
    const proxies = router({});

    expect(await proxies('/api')).toBe(true);
    expect(await proxies('/anything/at/all')).toBe(true);
  });

  test("the deprecated 'exclusive' alias behaves exactly like 'only'", async () => {
    const legacy = router({ mode: 'exclusive', routes: ['/api'] });
    const current = router({ mode: 'only', routes: ['/api'] });

    for (const path of ['/api', '/health', '/']) {
      expect(await legacy(path)).toBe(await current(path));
    }
    expect(await legacy('/api')).toBe(true);
    expect(await legacy('/health')).toBe(false);
  });

  test("the deprecated 'inclusive' alias behaves exactly like 'except'", async () => {
    const legacy = router({ mode: 'inclusive', routes: ['/health'] });
    const current = router({ mode: 'except', routes: ['/health'] });

    for (const path of ['/api', '/health', '/']) {
      expect(await legacy(path)).toBe(await current(path));
    }
    expect(await legacy('/health')).toBe(false);
    expect(await legacy('/api')).toBe(true);
  });

  test('the two modes are exact inverses for the same routes', async () => {
    const only = router({ mode: 'only', routes: ['/api', '/v2'] });
    const except = router({ mode: 'except', routes: ['/api', '/v2'] });

    for (const path of ['/api', '/v2', '/health', '/', '/api/nested']) {
      expect(await only(path)).toBe(!(await except(path)));
    }
  });

  describe('matchSubroutes', () => {
    test('off by default: a route does not cover its sub-paths', async () => {
      const proxies = router({ mode: 'only', routes: ['/api'] });

      expect(await proxies('/api')).toBe(true);
      expect(await proxies('/api/v1')).toBe(false);
    });

    test('on: a route also covers its sub-paths', async () => {
      const proxies = router({ mode: 'only', routes: ['/api'], matchSubroutes: true });

      expect(await proxies('/api')).toBe(true);
      expect(await proxies('/api/v1')).toBe(true);
      expect(await proxies('/apiary')).toBe(false); // prefix, not a sub-path
      expect(await proxies('/other')).toBe(false);
    });

    test("root '/' with subroutes on matches every path", async () => {
      const proxies = router({ mode: 'only', routes: ['/'], matchSubroutes: true });

      expect(await proxies('/')).toBe(true);
      expect(await proxies('/api/v1')).toBe(true);
    });

    test('trailing slashes and query strings are normalized away', async () => {
      const proxies = router({ mode: 'only', routes: ['/api/'] });

      expect(await proxies('/api')).toBe(true);
      expect(await proxies('/api/')).toBe(true);
      expect(await proxies('/api?page=2')).toBe(true);
    });
  });

  describe('configuration guards', () => {
    const build = (options: Record<string, unknown>) => () =>
      ProxyClient(async () => new Response('{}'), options as never);

    test('routes without an explicit mode is rejected, not silently inverted', () => {
      // The historical footgun: this used to default to a denylist, so `/api`
      // went direct and every *other* route was proxied and billed.
      expect(build({ routes: ['/api'] })).toThrow(/explicit mode when routes are configured/);
    });

    test('an unrecognized mode is rejected, not silently defaulted', () => {
      expect(build({ mode: 'exclusve', routes: ['/api'] })).toThrow(/Invalid ProxyClient mode/);
      expect(build({ mode: 'allowlist', routes: ['/api'] })).toThrow(/Invalid ProxyClient mode/);
      expect(build({ mode: 42, routes: ['/api'] })).toThrow(/Invalid ProxyClient mode/);
    });

    test("mode 'only' with no routes is rejected instead of silently disabling the proxy", () => {
      expect(build({ mode: 'only' })).toThrow(/proxies nothing unless routes are configured/);
      expect(build({ mode: 'only', routes: [] })).toThrow(/proxies nothing unless routes are configured/);
      expect(build({ mode: 'exclusive', routes: [] })).toThrow(/proxies nothing unless routes are configured/);
    });

    test('malformed routes are rejected', () => {
      expect(build({ mode: 'only', routes: '/api' })).toThrow(/routes must be an array/);
      expect(build({ mode: 'only', routes: ['/api', ''] })).toThrow(/routes\[1\] must be a non-empty path string/);
      expect(build({ mode: 'only', routes: ['/api', '  '] })).toThrow(/routes\[1\] must be a non-empty path string/);
      expect(build({ mode: 'only', routes: [123] })).toThrow(/routes\[0\] must be a non-empty path string/);
    });

    test("mode 'except' with no routes is valid and proxies everything", () => {
      expect(build({ mode: 'except' })).not.toThrow();
      expect(build({ mode: 'inclusive' })).not.toThrow();
      expect(build({})).not.toThrow();
    });
  });
});
