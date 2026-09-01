import type { NodeRoute, DirectRequest } from './node-connect';
import type { ProxyResponsePayload } from './dataplane/tunnel/data-plane';
import type { ProxyExecutionProfileV1 } from './profile-v1';

export type ConsensusSocketModel = 'hybrid' | 'time' | 'data';

export type ConsensusSocketTokenAuth = {
  token: string;
  connect_url: string;
  expires_in: number;
};

export type ConsensusSocketConnectTarget = {
  connect_url: string;
  token?: string;
  expires_in?: number;
};

export type ConsensusSocketCallbacks = {
  onOpen?: () => void;
  onMessage?: (data: unknown) => void;
  onClose?: (event?: unknown) => void;
  onError?: (error: unknown) => void;
};

export type ConsensusSocketSafeResult<T> = {
  ok: boolean;
  data?: T;
  error?: unknown;
};

export type ConsensusSocketSessionState = {
  connected: boolean;
  reconnecting: boolean;
  closedByCaller: boolean;
};

export type ConsensusSocketSession = {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'message' | 'close' | 'error', handler: (...args: unknown[]) => void): void;
  off(event: 'open' | 'message' | 'close' | 'error', handler: (...args: unknown[]) => void): void;
  getState(): ConsensusSocketSessionState;
};

export type ConsensusSocketClientOptions = {
  /** Custom WebSocket constructor; auto-detected when omitted. */
  webSocketFactory?: new (...args: unknown[]) => unknown;
  /** Max time to wait for socket open before failing. */
  openTimeoutMs?: number;
  /** Fixed delay between reconnect attempts. */
  reconnectIntervalMs?: number;
  /** Default token params merged into every requestToken call. */
  defaults?: ConsensusSocketTokenParams;
  /** Maximum websocket spend in USD (up to 6 decimals) before stand-down. */
  limit_usd?: number;
  /** Callback fired once when websocket budget is exhausted. */
  on_limit_reached?: (budget: ConsensusSocketBudgetSnapshot) => void;
};

export type ConsensusSocketClient = {
  requestToken(
    params?: ConsensusSocketTokenParams,
    options?: { safe?: false }
  ): Promise<ConsensusSocketTokenAuth>;
  requestToken(
    params: ConsensusSocketTokenParams | undefined,
    options: { safe: true }
  ): Promise<ConsensusSocketSafeResult<ConsensusSocketTokenAuth>>;
  connect(
    connectUrlOrAuth: string | ConsensusSocketConnectTarget,
    callbacks?: ConsensusSocketCallbacks,
    options?: { safe?: false }
  ): Promise<ConsensusSocketSession>;
  connect(
    connectUrlOrAuth: string | ConsensusSocketConnectTarget,
    callbacks: ConsensusSocketCallbacks | undefined,
    options: { safe: true }
  ): Promise<ConsensusSocketSafeResult<ConsensusSocketSession>>;
  getBudget(): ConsensusSocketBudgetSnapshot;
  resetBudget(): void;
  isStandDown(): boolean;
};

export type ConsensusSocketBudgetSnapshot = {
  /** Configured max spend in USD, or null when no limit is configured. */
  limit_usd: number | null;
  /** Total spent so far in USD. */
  spent_usd: number;
  /** Remaining budget in USD, or null when unlimited. */
  remaining_usd: number | null;
  /** True when token purchase is blocked by the budget guard. */
  exhausted: boolean;
  /** Last locally quoted token/session cost in USD. */
  last_quote_usd: number;
};

export type SocketEventName = 'open' | 'message' | 'close' | 'error';

export type SocketLike = {
  readyState: number;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
export type SessionPricing = {
  model: ConsensusSocketModel;
  pricePerMinute: number;
  pricePerMB: number;
};

export type ConsensusSocketTokenParams = {
  /** Billing model used to calculate token/session price. */
  model?: ConsensusSocketModel;
  /** Session duration to purchase (integer minutes, >= 0). */
  minutes?: number;
  /** Session data allowance to purchase (integer MB, >= 0). */
  megabytes?: number;
  /** Optional preferred node region during token request (for example "us-east"). */
  nodeRegion?: string;
  /** Optional hard route to a specific node domain during token request. */
  nodeDomain?: string;
  /** Optional node/domain to exclude from routing during token request. */
  nodeExclude?: string;
};

export class SocketClientError extends Error {
  /** HTTP status from token endpoint when available. */
  status?: number;
  /** Parsed server error payload when available. */
  data?: unknown;
}

/** Thrown when requested token cost exceeds remaining websocket budget. */
export class SocketBudgetLimitError extends SocketClientError {}

export const PRICING_PRESETS: Record<'TIME' | 'DATA' | 'HYBRID', SessionPricing> = {
  TIME: {
    model: 'time',
    pricePerMinute: 0.001,
    pricePerMB: 0,
  },
  DATA: {
    model: 'data',
    pricePerMinute: 0,
    pricePerMB: 0.00012,
  },
  HYBRID: {
    model: 'hybrid',
    pricePerMinute: 0.0005,
    pricePerMB: 0.0001,
  },
};


/*------proxy types----*/

/**
 * How `routes` is interpreted.
 * - "only": proxy ONLY the listed routes (an allowlist).
 * - "except": proxy everything EXCEPT the listed routes (a denylist). Default.
 */
export type ProxyMode = 'only' | 'except';

/**
 * Pre-0.2.0 names for {@link ProxyMode}, still accepted everywhere `ProxyMode` is.
 *
 * @deprecated Use `'only'` (was `'exclusive'`) or `'except'` (was `'inclusive'`).
 * The old adjectives described the proxy's breadth while sitting next to `routes`,
 * so they read as the inverse of what they did: under `'inclusive'`, listing a
 * route *excluded* it from proxying.
 */
export type LegacyProxyMode = 'inclusive' | 'exclusive';
export type ProxyStrategy = 'auto' | 'manual';

/** A reusable anonymous forward-proxy policy compiled into a profile-v1 execution plan. */
export type ProxyProfile = {
  /** Base URL used to resolve relative fetch/request targets and constrain absolute targets. */
  base_url: string;
  /** HTTP methods allowed through this profile (default: GET and HEAD). */
  allowed_methods?: string[];
  /** Origin-relative path prefixes allowed through this profile (default: /). */
  allowed_paths?: string[];
  cache_ttl?: number;
  verbose?: boolean;
  node_region?: string;
  node_domain?: string;
  node_exclude?: string;
  direct?: boolean;
};

export type ProxyBudgetSnapshot = {
  /** Configured max spend in USD, or null when no limit is configured. */
  limit_usd: number | null;
  /** Fixed proxy charge applied per paid /proxy request. */
  request_cost_usd: number;
  /** Total spent so far in USD. */
  spent_usd: number;
  /** Remaining budget in USD, or null when unlimited. */
  remaining_usd: number | null;
  /** True when proxying is in stand-down mode due to budget limits. */
  exhausted: boolean;
};

export type ProxyClientOptions = {
  /** Local named profiles compiled into anonymous versioned execution plans. */
  profiles?: Record<string, ProxyProfile>;
  /** Default local profile name, overridable per request. */
  profile?: string;
  /**
   * How `routes` is interpreted for inbound server paths.
   * - `"only"` — proxy ONLY the listed routes (allowlist).
   * - `"except"` — proxy everything EXCEPT the listed routes (denylist). Default
   *   when `routes` is empty or omitted.
   *
   * Required whenever `routes` is non-empty: `{ routes: ['/api'] }` is genuinely
   * ambiguous, and guessing wrong silently inverts which routes you pay to proxy.
   *
   * The pre-0.2.0 names still work — `'exclusive'` means `'only'`, `'inclusive'`
   * means `'except'` — but are deprecated.
   */
  mode?: ProxyMode | LegacyProxyMode;
  /**
   * Path rules selected by `mode`, for example `["/health", "/metrics"]`.
   * Query params are ignored; matching is based on path only.
   */
  routes?: string[];
  /**
   * Path matcher behavior for `routes`.
   * - false (default): exact path only (`/route` does not match `/route/subroute`)
   * - true: include subroutes (`/route` matches `/route/*`)
   */
  matchSubroutes?: boolean;
  /**
   * Interception strategy.
   * - "auto": globally intercepts `fetch` for route-matched request scope
   * - "manual": does not intercept global `fetch`; use `req.consensus.fetch` / `request`
   */
  strategy?: ProxyStrategy;
  /**
   * Cache time-to-live in seconds for proxy responses.
   * Sent as `x-cache-ttl`; controls how long deduped responses can be reused.
   */
  cache_ttl?: number;
  /**
   * Enables verbose proxy response payload.
   * When true, proxy responses include `meta` with fields like:
   * `cached`, `dedupe_key`, `processing_ms`, and `timestamp`.
   */
  verbose?: boolean;
  /** Preferred proxy region, for example "us-east". Sent as `x-node-region`. */
  node_region?: string;
  /**
   * Force routing through a specific node domain, for example:
   * `nodexyz.consensus.canister.software`.
   * Sent as `x-node-domain`.
   */
  node_domain?: string;
  /** Exclude a specific node/domain from routing. Sent as `x-node-exclude`. */
  node_exclude?: string;
  /**
   * Max proxy spend in USD (up to 6 decimals).
   * Once exhausted, ProxyClient stands down and uses direct fetch.
   */
  limit_usd?: number;
  /** Callback fired once when budget is exhausted and stand-down is activated. */
  on_limit_reached?: (budget: ProxyBudgetSnapshot) => void;
  /**
   * Direct node routing (control/data-plane split). When enabled (default), proxy
   * requests send `x-direct`; if the orchestrator selects a node it returns a signed
   * routing ticket and the client connects directly to that node, otherwise the
   * orchestrator serves the request inline (server-as-node fallback). Set `false`
   * to force the relayed path. Can be overridden per request.
   */
  direct?: boolean;
  /**
   * Advanced/testing: override the connector used to reach a node on the direct
   * path. Defaults to the built-in WebSocket connector (`connectToNode`).
   */
  connectToNode?: NodeConnector;
};

/** Reaches the selected node on the direct path and returns its response. */
export type NodeConnector = (route: NodeRoute, request: DirectRequest) => Promise<ProxyResponsePayload>;

export type ProxyPayload = {
  target_url?: string;
  target_ref?: {
    kind: 'tunnel';
    tunnel_id: string;
    capability: string;
    path: string;
  };
  method: string;
  headers: Record<string, string>;
  profile?: ProxyExecutionProfileV1;
  body?: unknown;
};

export type ProxyResponseShape = {
  /** HTTP status code returned by proxy response. */
  status: number;
  /** HTTP reason phrase from proxy response. */
  statusText: string;
  /** Response headers returned by proxy. */
  headers: Record<string, string>;
  /** Parsed response payload from proxy target response. */
  data: unknown;
  /**
   * Optional verbose proxy metadata. Common keys:
   * cached, dedupe_key, processing_ms, timestamp.
   */
  meta: {
    cached?: boolean;
    dedupe_key?: string;
    processing_ms?: number;
    timestamp?: string;
    [key: string]: unknown;
  } | null;
};
/**
 * The subset of `ProxyClientOptions` that is meaningful on a single request.
 * The excluded keys configure the middleware itself (route filtering, the
 * interception strategy, the profile registry, the client-wide budget) and are
 * fixed for the life of the client, so overriding them per request is a no-op.
 */
export type ProxyRequestOptions = Omit<
  Partial<ProxyClientOptions>,
  | 'mode'
  | 'routes'
  | 'matchSubroutes'
  | 'strategy'
  | 'profiles'
  | 'connectToNode'
  | 'limit_usd'
  | 'on_limit_reached'
>;

/*------batch types----*/

/**
 * How a batch is executed.
 * - "parallel" (default): items run concurrently, bounded by `concurrency`.
 * - "sequential": items run strictly one at a time, in input order. Slower, but
 *   the budget guard sees every response before the next request is dispatched,
 *   so a `limit_usd` cap is enforced exactly rather than approximately.
 */
export type BatchMode = 'parallel' | 'sequential';

/**
 * One item of a batch. A bare string/URL is shorthand for a GET of that target;
 * the object form is the same payload `.request()` takes, plus optional
 * per-item option overrides (profile, cache_ttl, region, direct, ...).
 */
export type BatchRequestInput =
  | string
  | URL
  | (Partial<ProxyPayload> & { options?: ProxyRequestOptions });

export type BatchOptions = ProxyRequestOptions & {
  /** Execution mode. Defaults to "parallel". */
  mode?: BatchMode;
  /**
   * Max requests in flight at once in "parallel" mode (default 8).
   * Ignored in "sequential" mode, which is always one at a time.
   */
  concurrency?: number;
  /**
   * Stops dispatching further items when aborted. Requests already in flight are
   * not cancelled — they may already have been paid for — so they still settle;
   * every item not yet dispatched fails with `error.data.aborted === true`.
   */
  signal?: AbortSignal;
};

export type BatchItemSuccess = {
  ok: true;
  /** Position of this item in the input array. */
  index: number;
  value: ProxyResponseShape;
};

export type BatchItemFailure = {
  ok: false;
  /** Position of this item in the input array. */
  index: number;
  error: ProxyClientError;
};

/** Result of one batch item. `batch()` settles every item and never rejects on one. */
export type BatchItemResult = BatchItemSuccess | BatchItemFailure;

type FetchWithPayment = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type ConsensusContext = {
  strategy: ProxyStrategy;
  shouldProxy: boolean;
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    perRequestOptions?: Partial<ProxyClientOptions>
  ) => Promise<Response>;
  request: (
    payload: Partial<ProxyPayload>,
    perRequestOptions?: Partial<ProxyClientOptions>
  ) => Promise<ProxyResponseShape>;
  batch: (requests: readonly BatchRequestInput[], options?: BatchOptions) => Promise<BatchItemResult[]>;
  passthroughFetch: FetchWithPayment | null;
  createFetch: (pathname?: string) => FetchWithPayment;
  getBudget: () => ProxyBudgetSnapshot;
  isStandDown: () => boolean;
};

export type MiddlewareReq = {
  path?: string;
  url?: string;
  consensus?: ConsensusContext;
  [key: string]: unknown;
};

export type Next = (err?: unknown) => void;

export class ProxyClientError extends Error {
  /** HTTP status from proxy response when available. */
  status?: number;
  /** Parsed proxy error payload when available. */
  data?: unknown;
}

export type ProxyClientRuntime = {
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    perRequestOptions?: Partial<ProxyClientOptions>
  ) => Promise<Response>;
  request: (
    payload: Partial<ProxyPayload>,
    perRequestOptions?: Partial<ProxyClientOptions>
  ) => Promise<ProxyResponseShape>;
  /**
   * Run many proxy requests as one group. Settles every item and never rejects
   * on an individual failure — results come back in input order.
   */
  batch: (requests: readonly BatchRequestInput[], options?: BatchOptions) => Promise<BatchItemResult[]>;
  runWithPath: <T>(pathname: string, run: () => T | Promise<T>) => Promise<T>;
  createFetch: (pathname?: string) => FetchWithPayment;
  getBudget: () => ProxyBudgetSnapshot;
  resetBudget: () => void;
  isStandDown: () => boolean;
};

export type ProxyClientMiddleware = ((req: MiddlewareReq, res: unknown, next: Next) => void) &
  ProxyClientRuntime;
