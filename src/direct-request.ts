// Prepare a proxied request for DIRECT forwarding to a node, matching the
// orchestrator's contract so that (a) the node recomputes the same dedupe key the
// routing ticket is bound to, and (b) consensus control headers never leak to the
// upstream target.
//
// On the relayed path the orchestrator strips/canonicalizes before the upstream
// fetch; on the direct path the orchestrator only signs a ticket, so the client
// must do it before handing the request to the node. Both helpers MIRROR server
// logic and must stay in sync:
//   - headers: consensus `server/features/proxy/proxy.ts` STRIP_REQUEST_HEADERS
//   - body:    consensus `server/features/proxy/dedupe.ts` computeBodyHash

// Mirror of the orchestrator's STRIP_REQUEST_HEADERS. The hop-by-hop entries are
// also dropped by the node; the rest are consensus-internal (x-api-key, x-cache-ttl,
// x-direct, x-node-*, x-payment, …) and would otherwise leak to the upstream, since
// the node only strips hop-by-hop headers.
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'x-idempotency-key',
  'idempotency-key',
  'x-payment',
  'x-verbose',
  'x-api-key',
  'x-cache-ttl',
  'x-direct',
  'x-node-region',
  'x-node-domain',
  'x-node-exclude',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
]);

/** Drop consensus control + hop-by-hop headers before handing a request to a node,
 *  exactly as the orchestrator does before an upstream fetch on the relayed path.
 *  Preserves header-name case for the survivors. */
export function forwardHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]): [string, unknown] => [k, deepSort(v)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(deepSort(value));
}

/** Serialize the body to the exact bytes the orchestrator hashed for the dedupe
 *  key, so the node — which hashes the raw bytes it receives — computes the same
 *  key. Mirrors dedupe.ts computeBodyHash: strings pass through verbatim;
 *  everything else becomes canonical (key-sorted) JSON. The orchestrator hashes
 *  the JSON value it parsed from the POST body, so non-strings are round-tripped
 *  through JSON first to reproduce those exact bytes. */
export function canonicalNodeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  return stableStringify(JSON.parse(JSON.stringify(body)));
}
