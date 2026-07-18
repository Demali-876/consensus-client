import { describe, expect, test } from 'bun:test';

import { ProxyClient } from '../src/proxy-client.js';
import { ProxyClientError } from '../src/types.js';

type Captured = { input: string; payload: Record<string, any> };

function relay() {
  const captured: Captured[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({
      input: String(input),
      payload: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(JSON.stringify({ status: 200, statusText: 'OK', data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, captured };
}

const profiles = {
  catalog: {
    base_url: 'https://api.example.com/v1',
    allowed_methods: ['GET'],
    allowed_paths: ['/products', '/search'],
    cache_ttl: 120,
    node_region: 'us-east',
    direct: false,
  },
};

describe('ProxyClient local profiles', () => {
  test('resolves a relative target and applies profile controls without sending profile identity', async () => {
    const relayStub = relay();
    const client = ProxyClient(relayStub.fetch, { profiles, profile: 'catalog' });

    await client.fetch('/products/42?currency=usd');

    expect(relayStub.captured).toHaveLength(1);
    expect(relayStub.captured[0].payload.target_url).toBe('https://api.example.com/v1/products/42?currency=usd');
    expect(relayStub.captured[0].payload.headers['x-cache-ttl']).toBe('120');
    expect(relayStub.captured[0].payload.headers['x-node-region']).toBe('us-east');
    expect(relayStub.captured[0].payload.headers['x-direct']).toBeUndefined();
    expect(relayStub.captured[0].payload.profile).toBeUndefined();
  });

  test('supports selecting a profile per request and allows explicit per-request control overrides', async () => {
    const relayStub = relay();
    const client = ProxyClient(relayStub.fetch, { profiles });

    await client.fetch('/search?q=node', {}, { profile: 'catalog', cache_ttl: 30 });

    expect(relayStub.captured[0].payload.target_url).toBe('https://api.example.com/v1/search?q=node');
    expect(relayStub.captured[0].payload.headers['x-cache-ttl']).toBe('30');
  });

  test('accepts an absolute target only when it remains inside the profile base path', async () => {
    const relayStub = relay();
    const client = ProxyClient(relayStub.fetch, { profiles, profile: 'catalog' });

    await client.request({
      target_url: 'https://api.example.com/v1/products/7',
      method: 'GET',
      headers: {},
    });

    expect(relayStub.captured[0].payload.target_url).toBe('https://api.example.com/v1/products/7');
  });

  test('rejects a different origin before contacting Consensus', async () => {
    const relayStub = relay();
    const client = ProxyClient(relayStub.fetch, { profiles, profile: 'catalog' });

    await expect(client.fetch('https://evil.example/products')).rejects.toBeInstanceOf(ProxyClientError);
    expect(relayStub.captured).toHaveLength(0);
  });

  test('rejects disallowed paths and methods before contacting Consensus', async () => {
    const relayStub = relay();
    const client = ProxyClient(relayStub.fetch, { profiles, profile: 'catalog' });

    await expect(client.fetch('/admin')).rejects.toMatchObject({ status: 403 });
    await expect(client.fetch('/products', { method: 'POST' })).rejects.toMatchObject({ status: 403 });
    expect(relayStub.captured).toHaveLength(0);
  });

  test('rejects unknown profile names and invalid profile configuration', async () => {
    const relayStub = relay();
    const client = ProxyClient(relayStub.fetch, { profiles });
    await expect(client.fetch('/products', {}, { profile: 'missing' })).rejects.toThrow(/Unknown proxy profile/);

    expect(() => ProxyClient(relayStub.fetch, {
      profiles: { bad: { base_url: 'file:///tmp/data' } },
      profile: 'bad',
    })).toThrow(/base_url/);
  });
});
