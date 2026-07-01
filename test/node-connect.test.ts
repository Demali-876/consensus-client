// 12b-i: the direct-data-plane connector over a REAL WebSocket. A fake node runs
// the mirrored handshake (acceptDataInit) on an actual `ws` server and serves one
// canned response; connectToNode must complete the full client path end-to-end and
// surface the node's ProxyResponsePayload — including node errors and a pinned-key
// mismatch. Proves the ws<->MessageTransport adapter, not just the in-memory pipe.
import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { acceptDataInit } from '../src/dataplane/tunnel/data-handshake.js';
import { openFrame, sealFrame } from '../src/dataplane/crypto/secure-channel.js';
import { FRAME_TYPE } from '../src/dataplane/tunnel/frames.js';
import type { ProxyRequestPayload, ProxyResponsePayload } from '../src/dataplane/tunnel/data-plane.js';
import type { NodeIdentity } from '../src/dataplane/crypto/identity.js';
import { connectToNode, wsTransport, nodeConnectUrl, type NodeRoute } from '../src/node-connect.js';

function newIdentity(): NodeIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

interface FakeNode {
  url: string;
  identity: NodeIdentity;
  seenRequest: () => ProxyRequestPayload | null;
  close: () => Promise<void>;
}

// A minimal compliant node: handshake, read the sealed request, seal `served`.
// (The real node additionally verifies the ticket + serves through the SSRF guard;
// the client treats the ticket as opaque, so a stub token exercises the wire path.)
async function startFakeNode(
  nodeId: string,
  served: ProxyResponsePayload,
  identity: NodeIdentity = newIdentity()
): Promise<FakeNode> {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  let seen: ProxyRequestPayload | null = null;

  wss.on('connection', async (socket) => {
    const transport = wsTransport(socket as never);
    try {
      const init = JSON.parse((await transport.recv()).toString('utf8'));
      const { message: accept, session } = await acceptDataInit({ init, identity, nodeId });
      await transport.send(Buffer.from(JSON.stringify(accept), 'utf8'));

      const { frame, plaintext } = openFrame(session.receiveKey, await transport.recv());
      if (frame.type !== FRAME_TYPE.DATA) throw new Error('unexpected request frame type');
      seen = JSON.parse(plaintext.toString('utf8')) as ProxyRequestPayload;

      await transport.send(
        sealFrame(session.sendKey, FRAME_TYPE.DATA, 0n, Buffer.from(JSON.stringify(served), 'utf8'))
      );
      transport.close(1000);
    } catch {
      socket.close();
    }
  });

  return {
    url: `ws://127.0.0.1:${port}/connect`,
    identity,
    seenRequest: () => seen,
    close: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        // ws's server.close() waits on lingering sockets; terminate them first.
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            /* already gone */
          }
        }
        wss.close(finish);
        // Under Bun the close callback may not fire; don't let teardown hang.
        setTimeout(finish, 200).unref?.();
      }),
  };
}

function routeFor(node: FakeNode, nodeId: string): NodeRoute {
  return {
    node_id: nodeId,
    domain: '127.0.0.1',
    node_pubkey_pem: node.identity.publicKeyPem,
    ticket: 'opaque-ticket',
    dedupe_key: 'ddk-1',
  };
}

let open: FakeNode | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe('node-connect — direct data-plane over a real WebSocket', () => {
  test('nodeConnectUrl builds wss://<domain>/connect', () => {
    expect(nodeConnectUrl('n1.consensus.software')).toBe('wss://n1.consensus.software/connect');
  });

  test('completes a request and returns the node response', async () => {
    const NODE_ID = 'node-1';
    const served: ProxyResponsePayload = {
      type: 'proxy_response',
      status: 201,
      status_text: 'Created',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
      body_encoding: 'base64',
    };
    open = await startFakeNode(NODE_ID, served);

    const response = await connectToNode(
      routeFor(open, NODE_ID),
      { target_url: 'https://api.example.com/v1', method: 'POST', headers: { 'x-test': '1' } },
      { connectUrl: open.url }
    );

    expect(response.type).toBe('proxy_response');
    if (response.type === 'proxy_response') {
      expect(response.status).toBe(201);
      expect(JSON.parse(Buffer.from(response.body, 'base64').toString('utf8'))).toEqual({ ok: true });
    }
    // The node received the opaque ticket + the exact request to recompute dedupe.
    const seen = open.seenRequest();
    expect(seen?.token).toBe('opaque-ticket');
    expect(seen?.target_url).toBe('https://api.example.com/v1');
    expect(seen?.method).toBe('POST');
  });

  test('surfaces a node error payload (e.g. unauthorized ticket)', async () => {
    const NODE_ID = 'node-err';
    const served: ProxyResponsePayload = { type: 'error', code: 'unauthorized', message: 'ticket rejected' };
    open = await startFakeNode(NODE_ID, served);

    const response = await connectToNode(
      routeFor(open, NODE_ID),
      { target_url: 'https://api.example.com/v1' },
      { connectUrl: open.url }
    );

    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.code).toBe('unauthorized');
      expect(response.message).toBe('ticket rejected');
    }
  });

  test('rejects when the pinned node key does not match the node identity', async () => {
    const NODE_ID = 'node-mitm';
    const served: ProxyResponsePayload = {
      type: 'proxy_response',
      status: 200,
      status_text: 'OK',
      headers: {},
      body: '',
      body_encoding: 'base64',
    };
    open = await startFakeNode(NODE_ID, served);

    // Pin a different identity than the node actually holds → handshake proof fails.
    const wrong = routeFor(open, NODE_ID);
    wrong.node_pubkey_pem = newIdentity().publicKeyPem;

    await expect(
      connectToNode(wrong, { target_url: 'https://api.example.com/v1' }, { connectUrl: open.url })
    ).rejects.toThrow(/signature|channel_binding/);
  });

  test('dials the orchestrator-advertised connect_url, not the reconstructed domain', async () => {
    const NODE_ID = 'node-connect-url';
    const served: ProxyResponsePayload = {
      type: 'proxy_response',
      status: 200,
      status_text: 'OK',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
      body_encoding: 'base64',
    };
    open = await startFakeNode(NODE_ID, served);

    // `domain` would reconstruct to an unreachable wss URL; `connect_url` points at
    // the (local ws) fake node. No connectUrl override — so completing the request
    // proves connect_url is preferred over reconstructing from domain.
    const route = routeFor(open, NODE_ID);
    route.domain = 'unreachable.invalid';
    route.connect_url = open.url;

    const response = await connectToNode(route, { target_url: 'https://api.example.com/v1' });
    expect(response.type).toBe('proxy_response');
  });

  test('options.connectUrl still overrides route.connect_url', async () => {
    const NODE_ID = 'node-override';
    const served: ProxyResponsePayload = {
      type: 'proxy_response',
      status: 200,
      status_text: 'OK',
      headers: {},
      body: '',
      body_encoding: 'base64',
    };
    open = await startFakeNode(NODE_ID, served);

    const route = routeFor(open, NODE_ID);
    route.connect_url = 'wss://unreachable.invalid/connect'; // must be ignored in favor of the override
    const response = await connectToNode(
      route,
      { target_url: 'https://api.example.com/v1' },
      { connectUrl: open.url }
    );
    expect(response.type).toBe('proxy_response');
  });
});
