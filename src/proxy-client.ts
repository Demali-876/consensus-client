
import { AsyncLocalStorage } from 'async_hooks';
import { ProxyClientOptions, ProxyMode, ProxyPayload, ProxyResponseShape, ProxyClientMiddleware, ProxyStrategy, ProxyBudgetSnapshot, ProxyClientError, MiddlewareReq, Next, NodeConnector} from './types'
import { connectToNode, type NodeRoute } from './node-connect.js';
import { forwardHeaders, canonicalNodeBody } from './direct-request.js';
import type { ProxyResponsePayload } from './dataplane/tunnel/data-plane.js';
const DEFAULT_SERVER_URL =
  process.env.CONSENSUS_SERVER_URL || 'https://consensus.canister.software';
const USD_SCALE = 1_000_000;
const PROXY_PAID_REQUEST_COST_USD = 0.0001;

type FetchWithPayment = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const proxyFetchContext = new AsyncLocalStorage<{ proxyFetch: FetchWithPayment | null }>();
let interceptorInstalled = false;
let passthroughFetch: FetchWithPayment | null =
  typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function normalizePath(value: string): string {
  const path = String(value || '/').split('?')[0] || '/';
  if (path === '/') return '/';
  const normalized = path.replace(/\/+$/, '');
  return normalized || '/';
}

function normalizeHeaders(headers?: HeadersInit | null): Record<string, string> {
  if (!headers) return {};

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [String(key), String(value)]));
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined' || value === null) continue;
    result[key] = String(value);
  }
  return result;
}

function pathMatches(pathname: string, route: string, matchSubroutes = false): boolean {
  const requestPath = normalizePath(pathname);
  const configuredRoute = normalizePath(route);

  if (requestPath === configuredRoute) return true;
  if (!matchSubroutes) return false;
  if (configuredRoute === '/') return true;

  return requestPath.startsWith(`${configuredRoute}/`);
}

function shouldProxyPath(pathname: string, options: ProxyClientOptions): boolean {
  const mode: ProxyMode = options.mode === 'exclusive' ? 'exclusive' : 'inclusive';
  const routes = Array.isArray(options.routes) ? options.routes : [];
  const matchSubroutes = Boolean(options.matchSubroutes);
  const matched = routes.some((route) => pathMatches(pathname, route, matchSubroutes));

  return mode === 'exclusive' ? matched : !matched;
}

function controlHeadersFromOptions(options: Partial<ProxyClientOptions>): Record<string, string> {
  const headers: Record<string, string> = {};

  if (typeof options.cache_ttl !== 'undefined' && options.cache_ttl !== null) {
    headers['x-cache-ttl'] = String(options.cache_ttl);
  }
  if (options.verbose === true) {
    headers['x-verbose'] = 'true';
  }
  if (typeof options.node_region === 'string' && options.node_region.trim()) {
    headers['x-node-region'] = options.node_region.trim();
  }
  if (typeof options.node_domain === 'string' && options.node_domain.trim()) {
    headers['x-node-domain'] = options.node_domain.trim();
  }
  if (typeof options.node_exclude === 'string' && options.node_exclude.trim()) {
    headers['x-node-exclude'] = options.node_exclude.trim();
  }

  return headers;
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseUsdToMicros(value: number | undefined, fieldName: string): number | null {
  if (typeof value === 'undefined' || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative number`);
  }

  const micros = Math.round(value * USD_SCALE);
  const normalized = micros / USD_SCALE;
  if (Math.abs(normalized - value) > 1e-9) {
    throw new TypeError(`${fieldName} supports at most 6 decimal places`);
  }

  return micros;
}

function microsToUsd(micros: number): number {
  return Number((micros / USD_SCALE).toFixed(6));
}

function normalizeBody(
  body: BodyInit | object | null | undefined,
  headers: Record<string, string>
): unknown {
  if (typeof body === 'undefined' || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (typeof body === 'number' || typeof body === 'boolean') return body;

  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return body.toString();
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes =
      body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('utf8');
    return new TextDecoder().decode(bytes);
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new Error('FormData request bodies are not supported by ProxyClient');
  }

  if (typeof body === 'object') {
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }
    return body;
  }

  throw new Error(`Unsupported request body type: ${typeof body}`);
}

function bodyToInit(body: unknown, headers: Record<string, string>): BodyInit | undefined {
  const normalized = normalizeBody(body as BodyInit | object | null | undefined, headers);

  if (typeof normalized === 'undefined') return undefined;
  if (typeof normalized === 'string') return normalized;
  if (
    typeof normalized === 'object' &&
    normalized !== null &&
    !(normalized instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(normalized)
  ) {
    return JSON.stringify(normalized);
  }

  return normalized as BodyInit;
}

async function buildProxyPayload(
  input: RequestInfo | URL,
  init: RequestInit = {},
  controlHeaders: Record<string, string>
): Promise<ProxyPayload> {
  let targetUrl: string;
  let method = 'GET';
  let headers: Record<string, string> = {};
  let body: BodyInit | object | null | undefined;

  if (typeof Request !== 'undefined' && input instanceof Request) {
    targetUrl = input.url;
    method = input.method || method;
    headers = normalizeHeaders(input.headers);

    if (!('body' in init) && method !== 'GET' && method !== 'HEAD') {
      const raw = await input.clone().text();
      if (raw.length > 0) body = raw;
    }
  } else if (typeof input === 'string' || input instanceof URL) {
    targetUrl = String(input);
  } else {
    throw new Error('ProxyClient fetch input must be URL string, URL, or Request');
  }

  method = String(init.method || method || 'GET').toUpperCase();
  headers = {
    ...controlHeaders,
    ...headers,
    ...normalizeHeaders(init.headers),
  };

  if ('body' in init) {
    body = init.body as BodyInit | null | undefined;
  }

  const normalizedBody = normalizeBody(body, headers);

  return {
    target_url: targetUrl,
    method,
    headers,
    ...(typeof normalizedBody !== 'undefined' ? { body: normalizedBody } : {}),
  };
}

function toProxyResult(response: Response, data: unknown): ProxyResponseShape {
  if (data && typeof data === 'object' && 'status' in data && 'data' in data) {
    const maybe = data as Partial<ProxyResponseShape> & { status: number; data: unknown };
    return {
      status: Number(maybe.status) || response.status || 200,
      statusText: maybe.statusText || response.statusText || '',
      headers: (maybe.headers as Record<string, string>) || {},
      data: maybe.data,
      meta: maybe.meta ?? null,
    };
  }

  return {
    status: response.status || 500,
    statusText: response.statusText || '',
    headers: {},
    data,
    meta: null,
  };
}

function isBytes(value: unknown): value is Uint8Array | ArrayBuffer | DataView {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function toFetchResponse(proxyResult: ProxyResponseShape, requestUrl: string): Response {
  const headers = new Headers(proxyResult.headers || {});
  const payload = proxyResult.data;
  let body: BodyInit | null;
  if (payload === null || typeof payload === 'undefined') {
    body = null;
  } else if (typeof payload === 'string') {
    body = payload;
  } else if (isBytes(payload)) {
    // Raw bytes (a binary direct-node response) pass through unchanged — never via
    // a string, which would corrupt non-UTF-8 bodies (images, PDFs, gzip, …).
    body = payload as unknown as BodyInit;
  } else {
    body = JSON.stringify(payload);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }

  const response = new Response(body, {
    status: proxyResult.status,
    statusText: proxyResult.statusText || '',
    headers,
  });

  Object.defineProperty(response as Response & { consensus?: unknown }, 'consensus', {
    value: {
      request_url: requestUrl,
      meta: proxyResult.meta || null,
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return response;
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function isLikelyPaidProxyResponse(proxyResult: ProxyResponseShape): boolean {
  const meta = proxyResult.meta;
  if (meta && typeof meta === 'object' && 'cached' in (meta as Record<string, unknown>)) {
    return (meta as { cached?: unknown }).cached !== true;
  }
  return true;
}

function isDirectRoute(parsed: unknown): parsed is { route: NodeRoute; meta?: unknown } {
  if (!parsed || typeof parsed !== 'object' || !('route' in parsed)) return false;
  const route = (parsed as { route: unknown }).route;
  return (
    !!route &&
    typeof route === 'object' &&
    typeof (route as NodeRoute).node_id === 'string' &&
    typeof (route as NodeRoute).domain === 'string' &&
    typeof (route as NodeRoute).node_pubkey_pem === 'string' &&
    typeof (route as NodeRoute).ticket === 'string'
  );
}

function nodeErrorStatus(code: string): number {
  switch (code) {
    case 'bad_request':
      return 400;
    case 'unauthorized':
      return 401;
    case 'upstream_error':
      return 502;
    default:
      return 502;
  }
}

// Content-types we can safely round-trip through a string. Anything else — or an
// absent/unknown content-type — is treated as binary and kept as raw bytes, so a
// lossy UTF-8 decode never corrupts it.
function isTextualResponse(headers: Record<string, string>): boolean {
  let contentType = '';
  for (const key in headers) {
    if (key.toLowerCase() === 'content-type') {
      contentType = String(headers[key]).toLowerCase();
      break;
    }
  }
  if (!contentType) return false;
  return (
    contentType.startsWith('text/') ||
    contentType.includes('application/json') ||
    contentType.includes('+json') ||
    contentType.includes('application/xml') ||
    contentType.includes('+xml') ||
    contentType.includes('application/javascript') ||
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('application/graphql')
  );
}

function mapNodeResponse(payload: ProxyResponsePayload, serverMeta: unknown): ProxyResponseShape {
  if (payload.type === 'error') {
    const error = new ProxyClientError(`Node returned ${payload.code}: ${payload.message}`);
    error.status = nodeErrorStatus(payload.code);
    error.data = { code: payload.code, message: payload.message };
    throw error;
  }
  // ProxyResponsePayload.body is base64. Decode to bytes once; only stringify-parse
  // when the content-type is textual, otherwise keep the raw Buffer so binary
  // responses survive intact through toFetchResponse (a string round-trip would
  // irreversibly corrupt them).
  const bytes = Buffer.from(payload.body, 'base64');
  const headers = payload.headers ?? {};
  return {
    status: payload.status,
    statusText: payload.status_text,
    headers,
    data: isTextualResponse(headers) ? parseMaybeJson(bytes.toString('utf8')) : bytes,
    meta:
      serverMeta && typeof serverMeta === 'object'
        ? (serverMeta as ProxyResponseShape['meta'])
        : { direct: true },
  };
}

function ensureInterceptorInstalled(): void {
  if (interceptorInstalled) return;

  if (typeof globalThis.fetch === 'function') {
    passthroughFetch = globalThis.fetch.bind(globalThis);
  }
  if (!passthroughFetch) {
    throw new Error("Global fetch is unavailable; use strategy: 'manual' or polyfill fetch.");
  }

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const state = proxyFetchContext.getStore();
    if (state?.proxyFetch) return state.proxyFetch(input, init);
    return passthroughFetch!(input, init);
  }) as typeof fetch;

  interceptorInstalled = true;
}

function currentPassthroughFetch(): FetchWithPayment | null {
  if (passthroughFetch) return passthroughFetch;
  if (typeof globalThis.fetch === 'function') {
    passthroughFetch = globalThis.fetch.bind(globalThis);
  }
  return passthroughFetch;
}

export function ProxyClient(
  fetchWithPayment: FetchWithPayment,
  options: ProxyClientOptions = {}
): ProxyClientMiddleware {
  if (typeof fetchWithPayment !== 'function') {
    throw new TypeError('ProxyClient requires fetchWithPayment as the first argument');
  }

  const strategy: ProxyStrategy = options.strategy === 'manual' ? 'manual' : 'auto';
  const serverUrl = trimTrailingSlash(DEFAULT_SERVER_URL);
  const proxyEndpoint = `${serverUrl}/proxy`;
  // Direct node routing is on by default; `direct: false` (per client or per
  // request) forces the relayed path. The connector is injectable for testing.
  const directEnabled = options.direct !== false;
  const connector: NodeConnector = options.connectToNode ?? connectToNode;
  const resolveDirect = (opts: Partial<ProxyClientOptions>): boolean =>
    typeof opts.direct === 'boolean' ? opts.direct : directEnabled;
  const baseControlHeaders = controlHeadersFromOptions(options);
  const limitMicros = parseUsdToMicros(options.limit_usd, 'limit_usd');
  const requestCostMicros =
    parseUsdToMicros(PROXY_PAID_REQUEST_COST_USD, 'proxy_request_cost_usd') ?? 0;

  let spentMicros = 0;
  let limitCallbackFired = false;

  function computeStandDownState(): boolean {
    if (limitMicros === null) return false;
    if (spentMicros >= limitMicros) return true;
    if (requestCostMicros <= 0) return false;
    return spentMicros + requestCostMicros > limitMicros;
  }

  function getBudget(): ProxyBudgetSnapshot {
    const remainingMicros = limitMicros === null ? null : Math.max(0, limitMicros - spentMicros);
    return {
      limit_usd: limitMicros === null ? null : microsToUsd(limitMicros),
      request_cost_usd: microsToUsd(requestCostMicros),
      spent_usd: microsToUsd(spentMicros),
      remaining_usd: remainingMicros === null ? null : microsToUsd(remainingMicros),
      exhausted: computeStandDownState(),
    };
  }

  function isStandDown(): boolean {
    const exhausted = computeStandDownState();
    if (exhausted && !limitCallbackFired && typeof options.on_limit_reached === 'function') {
      limitCallbackFired = true;
      options.on_limit_reached(getBudget());
    }
    return exhausted;
  }

  function incrementSpend(proxyResult: ProxyResponseShape): void {
    if (requestCostMicros <= 0) return;
    if (!isLikelyPaidProxyResponse(proxyResult)) return;
    spentMicros += requestCostMicros;
    if (limitMicros !== null && spentMicros > limitMicros) spentMicros = limitMicros;
    isStandDown();
  }

  function resetBudget(): void {
    spentMicros = 0;
    limitCallbackFired = false;
  }

  async function passthroughFetchOrThrow(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const directFetch = currentPassthroughFetch();
    if (!directFetch) {
      throw new ProxyClientError(
        'Global fetch is unavailable; cannot bypass proxy while in stand-down mode.'
      );
    }
    return directFetch(input, init);
  }

  async function requestProxy(payload: ProxyPayload, direct: boolean): Promise<ProxyResponseShape> {
    // x-direct travels in the proxy payload headers (the server reads req.body.headers).
    // Tunnel targets cannot go direct, so never request it for them.
    const canDirect = direct && !!payload.target_url && payload.target_ref?.kind !== 'tunnel';
    const outboundHeaders = canDirect ? { ...payload.headers, 'x-direct': 'true' } : payload.headers;

    const response = await fetchWithPayment(proxyEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, headers: outboundHeaders }),
    });

    const raw = await response.text();
    const parsed = parseMaybeJson(raw);

    // Direct path: the orchestrator selected a node and returned a signed ticket;
    // connect to the node and serve there. A mode:'self' fallthrough returns a
    // normal inline response (no `route`) and is handled below as before.
    if (canDirect && isDirectRoute(parsed)) {
      return runDirect(parsed.route, parsed.meta, payload);
    }

    if (!response.ok && !(parsed && typeof parsed === 'object' && 'status' in parsed)) {
      const message =
        (parsed as { message?: string; error?: string } | null)?.message ||
        (parsed as { message?: string; error?: string } | null)?.error ||
        `Proxy request failed (${response.status})`;
      const error = new ProxyClientError(message);
      error.status = response.status;
      error.data = parsed;
      throw error;
    }

    return toProxyResult(response, parsed);
  }

  async function runDirect(
    route: NodeRoute,
    serverMeta: unknown,
    payload: ProxyPayload
  ): Promise<ProxyResponseShape> {
    let nodeResponse: ProxyResponsePayload;
    try {
      nodeResponse = await connector(route, {
        target_url: payload.target_url!,
        method: String(payload.method || 'GET').toUpperCase(),
        // Strip consensus control headers (incl. x-api-key) so they don't leak to
        // the upstream, and canonicalize the body so the node recomputes the same
        // dedupe key the ticket is bound to.
        headers: forwardHeaders(payload.headers),
        body: canonicalNodeBody(payload.body),
      });
    } catch (err) {
      const error = new ProxyClientError(
        `Direct routing to node ${route.node_id} failed: ${err instanceof Error ? err.message : String(err)}`
      );
      error.data = { node_id: route.node_id, direct: true };
      throw error;
    }
    return mapNodeResponse(nodeResponse, serverMeta);
  }

  async function requestDirectFromPayload(
    payload: Partial<ProxyPayload>,
    reason: string
  ): Promise<ProxyResponseShape> {
    const targetUrl = String(payload.target_url || '').trim();
    if (!targetUrl) {
      throw new ProxyClientError('Private tunnel requests cannot bypass the proxy in stand-down mode');
    }

    const method = String(payload.method || 'GET').toUpperCase();
    const headers = normalizeHeaders(payload.headers);
    const init: RequestInit = {
      method,
      headers,
    };

    if (!['GET', 'HEAD'].includes(method) && typeof payload.body !== 'undefined') {
      const convertedBody = bodyToInit(payload.body, headers);
      if (typeof convertedBody !== 'undefined') init.body = convertedBody;
    }

    const response = await passthroughFetchOrThrow(targetUrl, init);
    const raw = await response.text();
    const parsed = parseMaybeJson(raw);

    return {
      status: response.status,
      statusText: response.statusText || '',
      headers: responseHeadersToRecord(response.headers),
      data: parsed,
      meta: { bypassed: true, reason },
    };
  }

  async function proxiedFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    perRequestOptions: Partial<ProxyClientOptions> = {}
  ): Promise<Response> {
    if (isStandDown()) {
      return passthroughFetchOrThrow(input, init);
    }

    const controlHeaders = {
      ...baseControlHeaders,
      ...controlHeadersFromOptions(perRequestOptions),
    };
    const payload = await buildProxyPayload(input, init, controlHeaders);
    const proxyResult = await requestProxy(payload, resolveDirect(perRequestOptions));
    incrementSpend(proxyResult);

    const requestUrl =
      typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
    return toFetchResponse(proxyResult, requestUrl);
  }

  async function proxiedRequest(
    payload: Partial<ProxyPayload> = {},
    perRequestOptions: Partial<ProxyClientOptions> = {}
  ): Promise<ProxyResponseShape> {
    if (isStandDown()) {
      return requestDirectFromPayload(payload, 'limit_reached');
    }

    const controlHeaders = {
      ...baseControlHeaders,
      ...controlHeadersFromOptions(perRequestOptions),
      ...normalizeHeaders(payload.headers),
    };

    const proxyResult = await requestProxy(
      {
        ...(payload.target_ref ? { target_ref: payload.target_ref } : { target_url: String(payload.target_url || '') }),
        method: String(payload.method || 'GET').toUpperCase(),
        headers: controlHeaders,
        ...(typeof payload.body !== 'undefined' ? { body: payload.body } : {}),
      },
      resolveDirect(perRequestOptions)
    );

    incrementSpend(proxyResult);
    return proxyResult;
  }

  function createFetch(pathname = '/'): FetchWithPayment {
    return (input: RequestInfo | URL, init?: RequestInit) => {
      if (!shouldProxyPath(pathname, options)) {
        return passthroughFetchOrThrow(input, init);
      }
      return proxiedFetch(input, init);
    };
  }

  async function runWithPath<T>(pathname: string, run: () => T | Promise<T>): Promise<T> {
    if (typeof run !== 'function') {
      throw new TypeError('runWithPath requires a callback function');
    }

    ensureInterceptorInstalled();
    const shouldProxy = shouldProxyPath(pathname, options);

    return new Promise<T>((resolve, reject) => {
      proxyFetchContext.run({ proxyFetch: shouldProxy ? proxiedFetch : null }, () => {
        Promise.resolve().then(run).then(resolve, reject);
      });
    });
  }

  const middleware = ((req: MiddlewareReq, _res: unknown, next: Next) => {
    const routePath = req?.path || req?.url || '/';
    const shouldProxy = shouldProxyPath(routePath, options) && !isStandDown();

    req.consensus = {
      strategy,
      shouldProxy,
      fetch: proxiedFetch,
      request: proxiedRequest,
      passthroughFetch: currentPassthroughFetch(),
      createFetch,
      getBudget,
      isStandDown,
    };

    if (strategy !== 'auto') {
      next();
      return;
    }

    ensureInterceptorInstalled();
    proxyFetchContext.run({ proxyFetch: shouldProxy ? proxiedFetch : null }, () => next());
  }) as ProxyClientMiddleware;

  middleware.fetch = proxiedFetch;
  middleware.request = proxiedRequest;
  middleware.runWithPath = runWithPath;
  middleware.createFetch = createFetch;
  middleware.getBudget = getBudget;
  middleware.resetBudget = resetBudget;
  middleware.isStandDown = isStandDown;

  return middleware;
}
