// Byte-for-byte parity with consensus-node's data-plane protocol. The modules
// under src/dataplane/ are mirrored from the node; this proves the client accepts
// and reproduces exactly what the node signs/derives — against committed vectors
// — and that the mirrored pieces interoperate end-to-end over an in-memory channel.
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyProof,
  type ResponderChallenge,
  type ResponderProof,
} from '../src/dataplane/tunnel/responder-auth';
import {
  acceptDataInit,
  channelBinding,
  createDataInit,
  deriveClientDataSession,
  type DataAcceptMessage,
} from '../src/dataplane/tunnel/data-handshake';
import { openFrame, sealFrame } from '../src/dataplane/crypto/secure-channel';
import { FRAME_TYPE } from '../src/dataplane/tunnel/frames';
import {
  runDataRequest,
  type MessageTransport,
  type ProxyRequestPayload,
  type ProxyResponsePayload,
} from '../src/dataplane/tunnel/data-plane';
import type { NodeIdentity } from '../src/dataplane/crypto/identity';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsDir = path.join(here, '../src/dataplane/tunnel/test-vectors');
const readVectors = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(vectorsDir, file), 'utf8'));

function newIdentity(): NodeIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

describe('data-plane protocol parity with consensus-node', () => {
  // 1) responder-auth vectors: the client must accept/reject exactly what the
  //    node signs — byte-for-byte against the committed fixtures.
  const responder = readVectors('responder-auth.vectors.json') as {
    node_id: string;
    node_public_key_pem: string;
    vectors: Array<{
      name: string;
      challenge: ResponderChallenge;
      proof: ResponderProof;
      verify: { expectedNodeId?: string; now: number };
      expect: { ok: boolean; error?: string };
    }>;
  };

  for (const v of responder.vectors) {
    test(`responder-auth vector: ${v.name}`, () => {
      const opts = {
        proof: v.proof,
        challenge: v.challenge,
        expectedNodeId: v.verify.expectedNodeId ?? responder.node_id,
        expectedNodePublicKeyPem: responder.node_public_key_pem,
        now: v.verify.now,
      };
      if (v.expect.ok) {
        expect(() => verifyProof(opts)).not.toThrow();
      } else {
        expect(() => verifyProof(opts)).toThrow(new RegExp(v.expect.error ?? '.'));
      }
    });
  }

  // 2) data-handshake channel-binding vectors: the client computes the exact
  //    transcript bytes the node binds the session to and signs.
  const handshake = readVectors('data-handshake.vectors.json') as {
    vectors: Array<{ name: string; input: Record<string, string>; channel_binding: string }>;
  };

  test('channel-binding vectors reproduce the committed bytes', () => {
    const seen = new Set<string>();
    for (const v of handshake.vectors) {
      const binding = channelBinding({
        nodeId: v.input.node_id,
        clientPublicKey: v.input.client_public_key,
        clientNonce: v.input.client_nonce,
        nodePublicKey: v.input.node_public_key,
        nodeNonce: v.input.node_nonce,
      }).toString('base64');
      expect(binding).toBe(v.channel_binding);
      seen.add(binding);
    }
    // Distinct inputs → distinct bindings (every field feeds the hash).
    expect(seen.size).toBe(handshake.vectors.length);
  });

  // 3) Live interop: the mirrored modules complete a real handshake and the
  //    client verifies the node's proof against the pinned key.
  test('client and node derive the same session', async () => {
    const NODE_ID = 'node-live';
    const identity = newIdentity();
    const client = await createDataInit({ nodeId: NODE_ID });
    const node = await acceptDataInit({ init: client.message, identity, nodeId: NODE_ID });
    const session = await deriveClientDataSession({
      client,
      accept: node.message,
      expectedNodeId: NODE_ID,
      expectedNodePublicKeyPem: identity.publicKeyPem,
    });
    expect(session.sessionId).toBe(node.session.sessionId);
  });

  // 4) A swapped node ephemeral key breaks the channel binding (MITM defence).
  test('rejects a spliced node ephemeral key', async () => {
    const NODE_ID = 'node-live';
    const identity = newIdentity();
    const client = await createDataInit({ nodeId: NODE_ID });
    const node = await acceptDataInit({ init: client.message, identity, nodeId: NODE_ID });
    const node2 = await acceptDataInit({ init: client.message, identity, nodeId: NODE_ID });
    const spliced: DataAcceptMessage = {
      ...node.message,
      node_public_key: node2.message.node_public_key,
    };
    await expect(
      deriveClientDataSession({
        client,
        accept: spliced,
        expectedNodeId: NODE_ID,
        expectedNodePublicKeyPem: identity.publicKeyPem,
      })
    ).rejects.toThrow(/channel_binding/);
  });

  // 5) End-to-end runDataRequest against an in-memory node responder. Proves the
  //    full client path: handshake -> sealed ticketed request -> opened response.
  //    The "node" here is a minimal compliant peer (the real node additionally
  //    verifies the ticket + serves through the SSRF guard; the client treats the
  //    ticket as opaque, so a stub token is sufficient for the wire round-trip).
  test('runDataRequest completes a sealed request/response round-trip', async () => {
    const NODE_ID = 'node-live';
    const identity = newIdentity();
    const [clientTransport, nodeTransport] = linkedTransports();

    const served: ProxyResponsePayload = {
      type: 'proxy_response',
      status: 200,
      status_text: 'OK',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('hello from node').toString('base64'),
      body_encoding: 'base64',
    };

    const nodeSide = (async () => {
      const init = JSON.parse((await nodeTransport.recv()).toString('utf8'));
      const { message: accept, session } = await acceptDataInit({ init, identity, nodeId: NODE_ID });
      await nodeTransport.send(Buffer.from(JSON.stringify(accept), 'utf8'));

      const { frame, plaintext } = openFrame(session.receiveKey, await nodeTransport.recv());
      expect(frame.type).toBe(FRAME_TYPE.DATA);
      const request = JSON.parse(plaintext.toString('utf8')) as ProxyRequestPayload;
      expect(request.type).toBe('proxy_request');
      expect(request.token).toBe('opaque-ticket');
      expect(request.target_url).toBe('https://api.example.com/v1');

      await nodeTransport.send(
        sealFrame(session.sendKey, FRAME_TYPE.DATA, 0n, Buffer.from(JSON.stringify(served), 'utf8'))
      );
      nodeTransport.close(1000);
    })();

    const response = await runDataRequest(clientTransport, {
      nodeId: NODE_ID,
      expectedNodePublicKeyPem: identity.publicKeyPem,
      token: 'opaque-ticket',
      request: { target_url: 'https://api.example.com/v1', method: 'GET' },
    });
    await nodeSide;

    expect(response.type).toBe('proxy_response');
    if (response.type === 'proxy_response') {
      expect(response.status).toBe(200);
      expect(Buffer.from(response.body, 'base64').toString('utf8')).toBe('hello from node');
    }
  });
});

// Minimal in-memory ordered message channel: a send on one end resolves the next
// recv on the other. Stands in for a WebSocket so the mirrored protocol can be
// exercised without a network.
function linkedTransports(): [MessageTransport, MessageTransport] {
  const c2n = new MessageQueue();
  const n2c = new MessageQueue();
  const client: MessageTransport = { recv: () => n2c.pull(), send: (d) => c2n.push(d), close: () => {} };
  const node: MessageTransport = { recv: () => c2n.pull(), send: (d) => n2c.push(d), close: () => {} };
  return [client, node];
}

class MessageQueue {
  private items: Buffer[] = [];
  private waiters: Array<(buf: Buffer) => void> = [];
  push(buf: Buffer): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(buf);
    else this.items.push(buf);
  }
  pull(): Promise<Buffer> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
