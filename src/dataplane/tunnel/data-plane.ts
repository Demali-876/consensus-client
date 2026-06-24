// Data-plane connection protocol — CLIENT SUBSET, mirrored from
// consensus-node src/tunnel/data-plane.ts.
//
// The node file additionally contains serveDataConnection() (the node half) plus
// its ticket-verify / replay-cache / SSRF proxy-serve imports. The client must
// never carry those, so this copy keeps ONLY runDataRequest() and the shared wire
// types. The retained pieces are byte-for-byte identical to the node's — keep them
// that way when syncing.
//
//   1. client -> node : DataInit          (data-handshake)
//   2. node -> client : DataAccept        (encrypted session + signed identity)
//   3. client -> node : ProxyRequest      (encrypted: routing ticket + request)
//   4. node -> client : ProxyResponse     (encrypted: served response, or error)
//
// Steps 1–2 are the handshake JSON (ephemeral keys + a signed proof — safe in the
// clear, like a TLS handshake). Steps 3–4 are sealed frames under the derived
// session key. The client treats the routing ticket as an opaque string.

import { openFrame, sealFrame } from "../crypto/secure-channel";
import { FRAME_TYPE } from "./frames";
import { createDataInit, deriveClientDataSession, type DataAcceptMessage } from "./data-handshake";

export const DATA_PLANE_PATH = "/connect";

/** Ordered, message-framed bidirectional channel. One recv() returns one message. */
export interface MessageTransport {
  recv(): Promise<Buffer>;
  send(data: Buffer): void | Promise<void>;
  close(code?: number): void;
}

export interface ProxyRequestPayload {
  type: "proxy_request";
  token: string; // routing ticket (PASETO)
  target_url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string; // base64 when present
  body_encoding?: "base64";
}

export type ProxyResponsePayload =
  | {
      type: "proxy_response";
      status: number;
      status_text: string;
      headers: Record<string, string>;
      body: string; // base64
      body_encoding: "base64";
    }
  | { type: "error"; code: string; message: string };

/** Client reference: handshake (verifying the node against its pinned key), send
 *  the ticketed request, return the node's response. */
export async function runDataRequest(
  transport: MessageTransport,
  params: {
    nodeId: string;
    expectedNodePublicKeyPem: string;
    token: string;
    request: { target_url: string; method?: string; headers?: Record<string, string>; body?: string | Buffer | null };
  },
): Promise<ProxyResponsePayload> {
  const client = await createDataInit({ nodeId: params.nodeId });
  await transport.send(encodeJson(client.message));

  const accept = decodeJson<DataAcceptMessage>(await transport.recv());
  const session = await deriveClientDataSession({
    client,
    accept,
    expectedNodeId: params.nodeId,
    expectedNodePublicKeyPem: params.expectedNodePublicKeyPem,
  });

  const body = normalizeBody(params.request.body);
  const payload: ProxyRequestPayload = {
    type: "proxy_request",
    token: params.token,
    target_url: params.request.target_url,
    method: params.request.method,
    headers: params.request.headers,
    body: body ? body.toString("base64") : undefined,
    body_encoding: body ? "base64" : undefined,
  };
  await transport.send(sealFrame(session.sendKey, FRAME_TYPE.DATA, 0n, encodeJson(payload)));

  const { frame, plaintext } = openFrame(session.receiveKey, await transport.recv());
  if (frame.type !== FRAME_TYPE.DATA) throw new Error("data-plane: unexpected response frame type");
  return decodeJson<ProxyResponsePayload>(plaintext);
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function decodeJson<T>(buf: Buffer): T {
  return JSON.parse(buf.toString("utf8")) as T;
}

function normalizeBody(body: string | Buffer | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}
