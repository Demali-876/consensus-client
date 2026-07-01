// Direct data-plane connector: open a WebSocket to the node the orchestrator
// selected, run the end-to-end-encrypted, node-authenticated request, and return
// the node's response. This is the client glue around the mirrored protocol in
// src/dataplane/ — it owns the WebSocket transport and URL construction and is NOT
// mirrored from consensus-node. See src/dataplane/README.md.
//
// Flow (one request per connection, matching the node's serveDataConnection):
//   open wss://<domain>/connect -> runDataRequest (handshake + sealed request) ->
//   node's ProxyResponsePayload -> close.
import {
  DATA_PLANE_PATH,
  runDataRequest,
  type MessageTransport,
  type ProxyResponsePayload,
} from './dataplane/tunnel/data-plane.js';

/** The routing ticket + node connection info the orchestrator returns from
 *  POST /proxy when `x-direct` selects a node. The ticket is opaque to the client. */
export interface NodeRoute {
  node_id: string;
  domain: string;
  /** The node's advertised data-plane URL (`wss://<node>/connect`). Preferred over
   *  reconstructing from `domain` — it carries whatever the orchestrator gateway
   *  actually routes. Optional so a client still works against an older server that
   *  does not return it. */
  connect_url?: string;
  node_pubkey_pem: string;
  ticket: string;
  ticket_exp?: number;
  dedupe_key?: string;
}

/** The request to serve at the node. Headers/body must match what the orchestrator
 *  saw so the node recomputes the same dedupe key the ticket is bound to. */
export interface DirectRequest {
  target_url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
}

export interface ConnectToNodeOptions {
  /** Override the wss URL (tests point this at a local ws:// fake node). */
  connectUrl?: string;
  /** Inject a WebSocket constructor; defaults to the `ws` package. */
  WebSocketImpl?: WebSocketCtor;
  /** Milliseconds to wait for the socket to open (default 12000). */
  openTimeoutMs?: number;
}

/** Minimal structural type covering both the `ws` package (EventEmitter) and the
 *  global WebSocket (EventTarget). */
interface WebSocketLike {
  send(data: Uint8Array): void;
  close(code?: number): void;
  readyState: number;
  binaryType?: string;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  addEventListener?(event: string, cb: (event: unknown) => void): void;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;
const DEFAULT_OPEN_TIMEOUT_MS = 12_000;

/** wss://<domain>/connect — the node's data-plane endpoint. */
export function nodeConnectUrl(domain: string): string {
  return `wss://${domain}${DATA_PLANE_PATH}`;
}

export async function connectToNode(
  route: NodeRoute,
  request: DirectRequest,
  options: ConnectToNodeOptions = {}
): Promise<ProxyResponsePayload> {
  // Prefer an explicit test override, then the orchestrator-advertised connect_url,
  // then reconstruct from the domain (older servers that don't return connect_url).
  const url = options.connectUrl ?? route.connect_url ?? nodeConnectUrl(route.domain);
  const WebSocketImpl = options.WebSocketImpl ?? (await resolveWebSocket());
  const socket = new WebSocketImpl(url);
  // Prefer ArrayBuffer over Blob for binary frames on EventTarget-style sockets;
  // the `ws` package ignores this and delivers Buffers.
  try {
    socket.binaryType = 'arraybuffer';
  } catch {
    /* read-only on some implementations */
  }

  const transport = wsTransport(socket);
  try {
    await waitForOpen(socket, options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
    return await runDataRequest(transport, {
      nodeId: route.node_id,
      expectedNodePublicKeyPem: route.node_pubkey_pem,
      token: route.ticket,
      request,
    });
  } finally {
    try {
      socket.close(1000);
    } catch {
      /* already closing/closed */
    }
  }
}

/** Adapt a WebSocket to the ordered MessageTransport the data-plane protocol uses.
 *  Buffers incoming messages so a recv() that arrives before its message resolves. */
export function wsTransport(socket: WebSocketLike): MessageTransport {
  const queue: Buffer[] = [];
  const waiters: Array<{ resolve: (buf: Buffer) => void; reject: (err: unknown) => void }> = [];
  let failure: unknown = null;

  const onMessage = (...args: unknown[]) => {
    const buf = toBuffer(extractMessageData(args));
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(buf);
    else queue.push(buf);
  };
  const onClose = () => failAll(new Error('node-connect: socket closed before the response arrived'));
  const onError = (...args: unknown[]) => {
    const err = args[0];
    failAll(err instanceof Error ? err : new Error('node-connect: socket error'));
  };
  function failAll(err: unknown): void {
    failure = failure ?? err;
    while (waiters.length) waiters.shift()!.reject(failure);
  }

  addListener(socket, 'message', onMessage);
  addListener(socket, 'close', onClose);
  addListener(socket, 'error', onError);

  return {
    recv(): Promise<Buffer> {
      const item = queue.shift();
      if (item) return Promise.resolve(item);
      if (failure) return Promise.reject(failure);
      return new Promise<Buffer>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    send(data: Buffer): void {
      socket.send(data);
    },
    close(code?: number): void {
      try {
        socket.close(code);
      } catch {
        /* already closing/closed */
      }
    },
  };
}

function waitForOpen(socket: WebSocketLike, timeoutMs: number): Promise<void> {
  if (socket.readyState === WS_OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    addListener(socket, 'open', () => settle(resolve));
    addListener(socket, 'error', (...args: unknown[]) =>
      settle(() => reject(args[0] instanceof Error ? args[0] : new Error('node-connect: socket error before open')))
    );
    addListener(socket, 'close', () =>
      settle(() => reject(new Error('node-connect: socket closed before open')))
    );
    const timer = setTimeout(
      () => settle(() => reject(new Error('node-connect: open timeout'))),
      timeoutMs
    );
  });
}

async function resolveWebSocket(): Promise<WebSocketCtor> {
  const mod = (await import('ws')) as { default?: unknown; WebSocket?: unknown };
  const ctor = mod.default ?? mod.WebSocket;
  if (typeof ctor !== 'function') {
    throw new Error('node-connect: unable to load a WebSocket constructor from `ws`');
  }
  return ctor as WebSocketCtor;
}

function addListener(socket: WebSocketLike, event: string, cb: (...args: unknown[]) => void): void {
  if (typeof socket.on === 'function') socket.on(event, cb);
  else if (typeof socket.addEventListener === 'function') socket.addEventListener(event, cb);
}

/** `ws` delivers (data, isBinary); the global WebSocket delivers a MessageEvent. */
function extractMessageData(args: unknown[]): unknown {
  const first = args[0];
  if (
    first &&
    typeof first === 'object' &&
    !Buffer.isBuffer(first) &&
    !(first instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(first) &&
    'data' in (first as Record<string, unknown>)
  ) {
    return (first as { data: unknown }).data;
  }
  return first;
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => toBuffer(part)));
  throw new Error('node-connect: unsupported WebSocket message payload');
}
