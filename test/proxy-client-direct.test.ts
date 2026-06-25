// 12b-ii: ProxyClient direct-routing wiring. Unit-checks the forwarding contract
// helpers, then drives ProxyClient with a stub fetch (orchestrator) + an injected
// connector (node) to verify branching, header stripping, body canonicalization,
// response mapping, and the inline / direct:false paths. The real-WebSocket path
// is covered by node-connect.test.ts.
import { describe, expect, test } from 'bun:test';

import { ProxyClient } from '../src/proxy-client.js';
import { forwardHeaders, canonicalNodeBody } from '../src/direct-request.js';
import { ProxyClientError, type NodeConnector } from '../src/types.js';
import type { ProxyResponsePayload } from '../src/dataplane/tunnel/data-plane.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const ROUTE = {
  node_id: 'n1',
  domain: 'n1.consensus.test',
  node_pubkey_pem: 'PEM',
  ticket: 'opaque-ticket',
  ticket_exp: 1_700_000_120,
  dedupe_key: 'ddk-1',
};

// Orchestrator stub: returns a route when x-direct is present, else an inline response.
function orchestrator(): { fetch: FetchLike; payloads: Array<Record<string, any>> } {
  const payloads: Array<Record<string, any>> = [];
  const fetch: FetchLike = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? '{}'));
    payloads.push(payload);
    if (payload.headers?.['x-direct'] === 'true') {
      return json({ route: ROUTE, meta: { direct: true, served_by: 'n1', dedupe_key: 'ddk-1' } });
    }
    return json({ status: 200, statusText: 'OK', data: { relayed: true }, meta: null });
  };
  return { fetch, payloads };
}

const nodeServes = (body: unknown): ProxyResponsePayload => ({
  type: 'proxy_response',
  status: 200,
  status_text: 'OK',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)).toString('base64'),
  body_encoding: 'base64',
});

describe('direct-request forwarding helpers', () => {
  test('forwardHeaders strips consensus control headers, keeps upstream ones', () => {
    const out = forwardHeaders({
      'X-Api-Key': 'secret',
      'x-cache-ttl': '60',
      'x-direct': 'true',
      'x-node-region': 'us-east',
      host: 'consensus.test',
      authorization: 'Bearer xyz',
      'content-type': 'application/json',
      'x-custom': 'keep-me',
    });
    expect(out).toEqual({
      authorization: 'Bearer xyz',
      'content-type': 'application/json',
      'x-custom': 'keep-me',
    });
  });

  test('canonicalNodeBody: strings verbatim, objects key-sorted, scalars JSON, nullish dropped', () => {
    expect(canonicalNodeBody('raw-string')).toBe('raw-string');
    expect(canonicalNodeBody({ b: 2, a: 1, c: { z: 1, y: 2 } })).toBe('{"a":1,"b":2,"c":{"y":2,"z":1}}');
    expect(canonicalNodeBody([3, 1, 2])).toBe('[3,1,2]'); // array order is significant
    expect(canonicalNodeBody(42)).toBe('42');
    expect(canonicalNodeBody(true)).toBe('true');
    expect(canonicalNodeBody(null)).toBeUndefined();
    expect(canonicalNodeBody(undefined)).toBeUndefined();
  });
});

describe('ProxyClient direct routing', () => {
  test('routes to the node: x-direct sent, control headers stripped, body canonicalized', async () => {
    const orch = orchestrator();
    let captured: { route: typeof ROUTE; request: any } | null = null;
    const connector: NodeConnector = async (route, request) => {
      captured = { route: route as typeof ROUTE, request };
      return nodeServes({ hi: 'node' });
    };

    const client = ProxyClient(orch.fetch as never, { connectToNode: connector });
    const res = await client.request({
      target_url: 'https://api.example.com/v1?b=2&a=1',
      method: 'post',
      headers: { 'x-api-key': 'secret', authorization: 'Bearer xyz', 'content-type': 'application/json' },
      body: { b: 2, a: 1 },
    });

    // Response mapped from the node payload.
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ hi: 'node' });
    expect(res.meta?.direct).toBe(true);

    // x-direct was sent to the orchestrator (in the payload headers it reads).
    expect(orch.payloads[0].headers['x-direct']).toBe('true');

    // The node got the opaque ticket, stripped headers, and a canonical body.
    expect(captured).not.toBeNull();
    expect(captured!.route.ticket).toBe('opaque-ticket');
    expect(captured!.request.method).toBe('POST');
    expect(captured!.request.headers['x-api-key']).toBeUndefined();
    expect(captured!.request.headers['x-direct']).toBeUndefined();
    expect(captured!.request.headers.authorization).toBe('Bearer xyz');
    expect(captured!.request.body).toBe('{"a":1,"b":2}');
  });

  test('node error payload becomes a thrown ProxyClientError with a status', async () => {
    const orch = orchestrator();
    const connector: NodeConnector = async () => ({
      type: 'error',
      code: 'unauthorized',
      message: 'ticket rejected',
    });
    const client = ProxyClient(orch.fetch as never, { connectToNode: connector });

    await expect(
      client.request({ target_url: 'https://api.example.com/v1', method: 'GET', headers: {} })
    ).rejects.toMatchObject({ status: 401 });
  });

  test('connector failure surfaces a ProxyClientError (no silent relay)', async () => {
    const orch = orchestrator();
    const connector: NodeConnector = async () => {
      throw new Error('socket closed before open');
    };
    const client = ProxyClient(orch.fetch as never, { connectToNode: connector });

    await expect(
      client.request({ target_url: 'https://api.example.com/v1', method: 'GET', headers: {} })
    ).rejects.toThrow(/Direct routing to node n1 failed/);
  });

  test('orchestrator mode:self fallthrough → inline, connector not called', async () => {
    // x-direct is sent, but the orchestrator returns a normal inline response.
    let connectorCalled = false;
    const selfFetch: FetchLike = async () =>
      json({ status: 200, statusText: 'OK', data: { self: true }, meta: { served_by: 'server' } });
    const connector: NodeConnector = async () => {
      connectorCalled = true;
      return nodeServes({});
    };
    const client = ProxyClient(selfFetch as never, { connectToNode: connector });

    const res = await client.request({ target_url: 'https://api.example.com/x', method: 'GET', headers: {} });
    expect(connectorCalled).toBe(false);
    expect(res.data).toEqual({ self: true });
  });

  test('direct:false forces the relayed path (no x-direct, connector not called)', async () => {
    const orch = orchestrator();
    let connectorCalled = false;
    const connector: NodeConnector = async () => {
      connectorCalled = true;
      return nodeServes({});
    };
    const client = ProxyClient(orch.fetch as never, { connectToNode: connector, direct: false });

    const res = await client.request({ target_url: 'https://api.example.com/x', method: 'GET', headers: {} });
    expect(connectorCalled).toBe(false);
    expect(orch.payloads[0].headers['x-direct']).toBeUndefined();
    expect(res.data).toEqual({ relayed: true });
  });
});

describe('ProxyClientError shape', () => {
  test('is thrown for node errors with attached data', async () => {
    const orch = orchestrator();
    const connector: NodeConnector = async () => ({ type: 'error', code: 'bad_request', message: 'nope' });
    const client = ProxyClient(orch.fetch as never, { connectToNode: connector });
    try {
      await client.request({ target_url: 'https://api.example.com/v1', method: 'GET', headers: {} });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyClientError);
      expect((err as ProxyClientError).status).toBe(400);
      expect((err as ProxyClientError).data).toMatchObject({ code: 'bad_request' });
    }
  });
});
