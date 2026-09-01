
import { AsyncLocalStorage } from 'async_hooks';
import { ProxyClientOptions, ProxyMode, ProxyPayload, ProxyResponseShape, ProxyClientMiddleware, ProxyStrategy, ProxyBudgetSnapshot, ProxyClientError, MiddlewareReq, Next, NodeConnector, ProxyProfile, BatchItemResult, BatchMode, BatchOptions, BatchRequestInput} from './types'
import { runBatch, DEFAULT_BATCH_CONCURRENCY } from './batch.js';
import { connectToNode, type NodeRoute } from './node-connect.js';
import { forwardHeaders, canonicalNodeBody } from './direct-request.js';
import type { ProxyResponsePayload } from './dataplane/tunnel/data-plane.js';
import {
  PROXY_PROFILE_PROTOCOL,
  PROXY_PROFILE_VERSION,
  hashProxyProfileV1,
  normalizeProxyProfileV1,
  prepareProxyProfileRequestV1,
  type ProxyExecutionProfileV1,
} from './profile-v1.js';
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

/** Canonicalized route-filtering config, resolved once per client. */
type RoutePolicy = {
  mode: ProxyMode;
  routes: string[];
  matchSubroutes: boolean;
};

/**
 * Map a configured mode onto the canonical `'only' | 'except'` pair.
 *
 * Unrecognized values throw rather than falling back to a default: the two modes
 * are exact inverses, so a typo silently flips which routes get proxied — and
 * paid for. The pre-0.2.0 adjectives are still accepted as deprecated aliases.
 */
function normalizeProxyMode(value: unknown): ProxyMode {
  switch (value) {
    case 'only':
    case 'exclusive': // deprecated alias
      return 'only';
    case 'except':
    case 'inclusive': // deprecated alias
      return 'except';
    default:
      throw new TypeError(
        `Invalid ProxyClient mode: ${JSON.stringify(value)}. Expected 'only' (proxy only \`routes\`) or 'except' (proxy everything but \`routes\`).`
      );
  }
}

function resolveRoutePolicy(options: ProxyClientOptions): RoutePolicy {
  if (typeof options.routes !== 'undefined' && !Array.isArray(options.routes)) {
    throw new TypeError('ProxyClient routes must be an array of path strings');
  }
  const routes = (options.routes ?? []).map((route, index) => {
    if (typeof route !== 'string' || !route.trim()) {
      throw new TypeError(`ProxyClient routes[${index}] must be a non-empty path string`);
    }
    return route;
  });

  const hasMode = typeof options.mode !== 'undefined' && options.mode !== null;

  // `{ routes: ['/api'] }` reads equally well as "proxy /api" and "don't proxy
  // /api". Defaulting picks one silently and bills the user for the other, so
  // make the caller say which they meant.
  if (routes.length > 0 && !hasMode) {
    throw new TypeError(
      "ProxyClient requires an explicit mode when routes are configured: use mode: 'only' to proxy only those routes, or mode: 'except' to proxy everything but those routes."
    );
  }

  const mode = hasMode ? normalizeProxyMode(options.mode) : 'except';

  // An empty allowlist matches nothing, which silently disables proxying entirely.
  if (mode === 'only' && routes.length === 0) {
    throw new TypeError(
      "ProxyClient mode: 'only' proxies nothing unless routes are configured. Add routes, or use mode: 'except' to proxy everything."
    );
  }

  return { mode, routes, matchSubroutes: Boolean(options.matchSubroutes) };
}

function shouldProxyPath(pathname: string, policy: RoutePolicy): boolean {
  const matched = policy.routes.some((route) => pathMatches(pathname, route, policy.matchSubroutes));
  return policy.mode === 'only' ? matched : !matched;
}

type ProfileControlField = 'cache_ttl' | 'verbose' | 'node_region' | 'node_domain' | 'node_exclude' | 'direct';
type NormalizedProxyProfile = ProxyExecutionProfileV1 & {
  /** SDK-only source metadata; non-enumerable and never included in the wire plan. */
  __explicit_fields?: ReadonlySet<string>;
};

const PROFILE_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

function normalizeProxyProfiles(input: ProxyClientOptions['profiles']): Map<string, NormalizedProxyProfile> {
  const profiles = new Map<string, NormalizedProxyProfile>();
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!PROFILE_NAME.test(name)) {
      throw new TypeError(`Invalid proxy profile name: ${name}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`Proxy profile ${name} must be an object`);
    }

    try {
      const normalized = normalizeProxyProfileV1({
        protocol: PROXY_PROFILE_PROTOCOL,
        version: PROXY_PROFILE_VERSION,
        ...value,
        allowed_methods: value.allowed_methods ?? ['GET', 'HEAD'],
        allowed_paths: value.allowed_paths ?? ['/'],
      }) as NormalizedProxyProfile;
      Object.defineProperty(normalized, '__explicit_fields', {
        value: new Set(Object.keys(value)),
        enumerable: false,
      });
      profiles.set(name, normalized);
    } catch (error) {
      throw new TypeError(`Proxy profile ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return profiles;
}

function resolveProfileTarget(profile: NormalizedProxyProfile, rawTarget: string): string {
  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    const base = new URL(profile.base_url);
    const relative = new URL(rawTarget.startsWith('/') ? rawTarget : `/${rawTarget}`, 'http://profile.local');
    if (relative.hash) {
      throw Object.assign(new ProxyClientError('Proxy profile targets cannot contain fragments'), { status: 403 });
    }
    const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
    base.pathname = `${basePath}${relative.pathname}` || '/';
    base.search = relative.search;
    target = base;
  }
  return target.toString();
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

type NormalizedBatchItem = {
  payload: Partial<ProxyPayload>;
  options: Partial<ProxyClientOptions>;
};

function isBatchTargetShorthand(item: BatchRequestInput): item is string | URL {
  return typeof item === 'string' || (typeof URL !== 'undefined' && item instanceof URL);
}

function normalizeBatchItem(item: BatchRequestInput, index: number): NormalizedBatchItem {
  if (isBatchTargetShorthand(item)) {
    const target = String(item);
    if (!target.trim()) {
      throw new TypeError(`batch requests[${index}] must be a non-empty target URL`);
    }
    return { payload: { target_url: target, method: 'GET' }, options: {} };
  }

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError(`batch requests[${index}] must be a URL string, URL, or request payload object`);
  }

  const { options, ...payload } = item;
  if (!payload.target_url && !payload.target_ref) {
    throw new TypeError(`batch requests[${index}] requires target_url or target_ref`);
  }
  if (typeof options !== 'undefined' && (!options || typeof options !== 'object' || Array.isArray(options))) {
    throw new TypeError(`batch requests[${index}].options must be an object`);
  }

  return { payload, options: options ?? {} };
}

/**
 * Split BatchOptions into batch-execution controls and the per-request option
 * overrides that apply to every item. Keeping the split here means a caller can
 * pass `{ mode, concurrency, profile, cache_ttl }` in one object and each half
 * reaches the layer that understands it.
 */
function splitBatchOptions(options: BatchOptions): {
  mode: BatchMode;
  concurrency: number;
  signal?: AbortSignal;
  perRequestOptions: Partial<ProxyClientOptions>;
} {
  const { mode: rawMode, concurrency: rawConcurrency, signal, ...perRequestOptions } = options;

  if (typeof rawMode !== 'undefined' && rawMode !== 'parallel' && rawMode !== 'sequential') {
    throw new TypeError("batch mode must be 'parallel' or 'sequential'");
  }
  if (
    typeof rawConcurrency !== 'undefined' &&
    (typeof rawConcurrency !== 'number' || !Number.isInteger(rawConcurrency) || rawConcurrency < 1)
  ) {
    throw new TypeError('batch concurrency must be a positive integer');
  }

  return {
    mode: rawMode ?? 'parallel',
    concurrency: rawConcurrency ?? DEFAULT_BATCH_CONCURRENCY,
    signal,
    perRequestOptions,
  };
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
  controlHeaders: Record<string, string>,
  profile: NormalizedProxyProfile | null = null,
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
  if (profile) {
    targetUrl = resolveProfileTarget(profile, targetUrl);
  }
  headers = {
    ...controlHeaders,
    ...headers,
    ...normalizeHeaders(init.headers),
  };

  if ('body' in init) {
    body = init.body as BodyInit | null | undefined;
  }

  const normalizedBody = normalizeBody(body, headers);
  let preparedProfile: ReturnType<typeof prepareProxyProfileRequestV1> | null = null;
  if (profile) {
    try {
      preparedProfile = prepareProxyProfileRequestV1(profile, targetUrl, method, headers);
    } catch (error) {
      throw Object.assign(new ProxyClientError(error instanceof Error ? error.message : String(error)), { status: 403 });
    }
  }

  return {
    target_url: targetUrl,
    method,
    headers: preparedProfile?.headers ?? headers,
    ...(preparedProfile ? { profile: preparedProfile.profile } : {}),
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
    meta: {
      ...(serverMeta && typeof serverMeta === 'object' ? serverMeta as Record<string, unknown> : { direct: true }),
      ...(typeof payload.cached === 'boolean' ? { cached: payload.cached } : {}),
      ...(payload.profile_hash ? { profile_hash: payload.profile_hash } : {}),
    },
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
  const routePolicy = resolveRoutePolicy(options);
  const serverUrl = trimTrailingSlash(DEFAULT_SERVER_URL);
  const proxyEndpoint = `${serverUrl}/proxy`;
  // Direct node routing is on by default; `direct: false` (per client or per
  // request) forces the relayed path. The connector is injectable for testing.
  const directEnabled = options.direct !== false;
  const connector: NodeConnector = options.connectToNode ?? connectToNode;
  const profiles = normalizeProxyProfiles(options.profiles);
  if (options.profile && !profiles.has(options.profile)) {
    throw new TypeError(`Unknown default proxy profile: ${options.profile}`);
  }
  const selectProfile = (opts: Partial<ProxyClientOptions>): NormalizedProxyProfile | null => {
    const name = opts.profile ?? options.profile;
    if (!name) return null;
    const profile = profiles.get(name);
    if (!profile) throw new ProxyClientError(`Unknown proxy profile: ${name}`);
    return profile;
  };
  const executionProfile = (
    profile: NormalizedProxyProfile | null,
    opts: Partial<ProxyClientOptions>,
  ): NormalizedProxyProfile | null => {
    if (!profile) return null;
    const effective = <K extends ProfileControlField>(field: K): ProxyClientOptions[K] => {
      const requestValue = opts[field];
      if (requestValue !== undefined) return requestValue;
      if (profile.__explicit_fields?.has(field)) return profile[field];
      return options[field] ?? profile[field];
    };
    return normalizeProxyProfileV1({
      ...profile,
      cache_ttl: effective('cache_ttl'),
      verbose: effective('verbose'),
      node_region: effective('node_region'),
      node_domain: effective('node_domain'),
      node_exclude: effective('node_exclude'),
      direct: effective('direct'),
    });
  };
  const resolveDirect = (opts: Partial<ProxyClientOptions>, profile: NormalizedProxyProfile | null): boolean =>
    typeof opts.direct === 'boolean'
      ? opts.direct
      : typeof profile?.direct === 'boolean'
        ? profile.direct
        : directEnabled;
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
    // Deliberately NOT clamped to limitMicros. In parallel mode every worker can
    // clear the stand-down check before any response comes back, so a batch can
    // genuinely pay for more requests than the limit allows (up to concurrency-1
    // over). Clamping reported a bill smaller than the one actually incurred.
    // remaining_usd still floors at zero, so only spent_usd exceeds the limit.
    spentMicros += requestCostMicros;
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
      if (payload.profile) {
        const expectedProfileHash = hashProxyProfileV1(payload.profile);
        if (route.profile_hash !== expectedProfileHash) {
          throw new Error('selected node route is not bound to the requested proxy profile');
        }
      }
      nodeResponse = await connector(route, {
        target_url: payload.target_url!,
        method: String(payload.method || 'GET').toUpperCase(),
        // Strip Consensus control and deprecated identity headers so they don't leak to
        // the upstream, and canonicalize the body so the node recomputes the same
        // dedupe key the ticket is bound to.
        headers: forwardHeaders(payload.headers),
        body: canonicalNodeBody(payload.body),
        profile: payload.profile,
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
    const profile = executionProfile(selectProfile(perRequestOptions), perRequestOptions);
    const controlHeaders = {
      ...baseControlHeaders,
      ...controlHeadersFromOptions(perRequestOptions),
    };
    const payload = await buildProxyPayload(input, init, controlHeaders, profile);
    if (isStandDown()) {
      const directResult = await requestDirectFromPayload(payload, 'limit_reached');
      const requestUrl = payload.target_url ?? String(input);
      return toFetchResponse(directResult, requestUrl);
    }
    const proxyResult = await requestProxy(payload, resolveDirect(perRequestOptions, profile));
    incrementSpend(proxyResult);

    const requestUrl =
      typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
    return toFetchResponse(proxyResult, requestUrl);
  }

  async function proxiedRequest(
    payload: Partial<ProxyPayload> = {},
    perRequestOptions: Partial<ProxyClientOptions> = {}
  ): Promise<ProxyResponseShape> {
    const profile = executionProfile(selectProfile(perRequestOptions), perRequestOptions);
    const controlHeaders = {
      ...baseControlHeaders,
      ...controlHeadersFromOptions(perRequestOptions),
      ...normalizeHeaders(payload.headers),
    };

    const method = String(payload.method || 'GET').toUpperCase();
    let targetUrl = payload.target_url ? String(payload.target_url) : '';
    if (profile) {
      if (payload.target_ref) throw new ProxyClientError('Proxy profiles cannot target private tunnels');
      targetUrl = resolveProfileTarget(profile, targetUrl);
    }

    let preparedProfile: ReturnType<typeof prepareProxyProfileRequestV1> | null = null;
    if (profile) {
      try {
        preparedProfile = prepareProxyProfileRequestV1(profile, targetUrl, method, controlHeaders);
      } catch (error) {
        throw Object.assign(new ProxyClientError(error instanceof Error ? error.message : String(error)), { status: 403 });
      }
    }

    const requestPayload: ProxyPayload = {
      ...(payload.target_ref ? { target_ref: payload.target_ref } : { target_url: targetUrl }),
      method,
      headers: preparedProfile?.headers ?? controlHeaders,
      ...(preparedProfile ? { profile: preparedProfile.profile } : {}),
      ...(typeof payload.body !== 'undefined' ? { body: payload.body } : {}),
    };

    if (isStandDown()) {
      return requestDirectFromPayload(requestPayload, 'limit_reached');
    }

    const proxyResult = await requestProxy(
      requestPayload,
      resolveDirect(perRequestOptions, profile)
    );

    incrementSpend(proxyResult);
    return proxyResult;
  }

  /**
   * Run many proxy requests as one group, sequentially or in parallel.
   *
   * Each item goes through the same path as `.request()`, so caching/dedupe,
   * anonymous profiles, direct node routing, and the budget guard all behave
   * exactly as they do for a single request. Every item settles — an individual
   * failure comes back as `{ ok: false, error }` rather than rejecting the batch.
   */
  async function proxiedBatch(
    requests: readonly BatchRequestInput[],
    batchOptions: BatchOptions = {}
  ): Promise<BatchItemResult[]> {
    if (!Array.isArray(requests)) {
      throw new TypeError('batch requires an array of requests');
    }

    // Validate the whole input up front: a malformed item is a programming error,
    // not a per-item failure, and finding it after half the batch has been paid
    // for would be a needlessly expensive way to learn about a typo.
    const items = requests.map(normalizeBatchItem);
    const { mode, concurrency, signal, perRequestOptions } = splitBatchOptions(batchOptions);

    return runBatch(items, { mode, concurrency, signal }, (item) =>
      proxiedRequest(item.payload, { ...perRequestOptions, ...item.options })
    );
  }

  function createFetch(pathname = '/'): FetchWithPayment {
    return (input: RequestInfo | URL, init?: RequestInit) => {
      if (!shouldProxyPath(pathname, routePolicy)) {
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
    const shouldProxy = shouldProxyPath(pathname, routePolicy);

    return new Promise<T>((resolve, reject) => {
      proxyFetchContext.run({ proxyFetch: shouldProxy ? proxiedFetch : null }, () => {
        Promise.resolve().then(run).then(resolve, reject);
      });
    });
  }

  const middleware = ((req: MiddlewareReq, _res: unknown, next: Next) => {
    const routePath = req?.path || req?.url || '/';
    const shouldProxy = shouldProxyPath(routePath, routePolicy) && !isStandDown();

    req.consensus = {
      strategy,
      shouldProxy,
      fetch: proxiedFetch,
      request: proxiedRequest,
      batch: proxiedBatch,
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
  middleware.batch = proxiedBatch;
  middleware.runWithPath = runWithPath;
  middleware.createFetch = createFetch;
  middleware.getBudget = getBudget;
  middleware.resetBudget = resetBudget;
  middleware.isStandDown = isStandDown;

  return middleware;
}
