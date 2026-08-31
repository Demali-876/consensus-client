import { ProxyClientError } from './types.js';
import type { BatchItemResult, BatchMode, ProxyResponseShape } from './types.js';

/**
 * Concurrency used by `mode: 'parallel'` when the caller does not pick one.
 * Deliberately modest: every in-flight item is a separate paid `/proxy` call, so
 * a runaway fan-out is a runaway bill as well as a load spike on the orchestrator.
 */
export const DEFAULT_BATCH_CONCURRENCY = 8;

export type BatchRunOptions = {
  mode: BatchMode;
  concurrency: number;
  signal?: AbortSignal;
};

function abortError(): ProxyClientError {
  const error = new ProxyClientError('Batch aborted before this request was dispatched');
  error.data = { aborted: true };
  return error;
}

/**
 * Normalize whatever a rejected item threw into a ProxyClientError, preserving the
 * `status`/`data` the proxy paths already attach so a batch failure carries exactly
 * as much information as the same failure from `.request()` would.
 */
function toProxyClientError(cause: unknown): ProxyClientError {
  if (cause instanceof ProxyClientError) return cause;

  const error = new ProxyClientError(cause instanceof Error ? cause.message : String(cause));
  if (cause && typeof cause === 'object') {
    const source = cause as { status?: unknown; data?: unknown };
    if (typeof source.status === 'number') error.status = source.status;
    if (typeof source.data !== 'undefined') error.data = source.data;
  }
  return error;
}

/**
 * Run a group of proxy requests and settle every one of them.
 *
 * This is the single seam between the batch API and the wire: today `run` is one
 * `/proxy` call per item, and `mode`/`concurrency` are honoured client-side. When
 * the orchestrator grows a `POST /proxy/batch` endpoint the whole function is
 * swapped for one that forwards `mode` to the server — the public `batch()`
 * signature and result shape are already the batch-endpoint contract.
 *
 * Never rejects on an item failure: results come back in input order as
 * `{ ok: true, value }` / `{ ok: false, error }`, `Promise.allSettled`-style.
 */
export async function runBatch<T>(
  items: readonly T[],
  options: BatchRunOptions,
  run: (item: T, index: number) => Promise<ProxyResponseShape>
): Promise<BatchItemResult[]> {
  const results = new Array<BatchItemResult>(items.length);
  if (items.length === 0) return results;

  // Sequential is just a one-worker pool, so both modes share a single code path
  // and the ordering/abort semantics can't drift apart between them.
  const workerCount =
    options.mode === 'sequential' ? 1 : Math.max(1, Math.min(options.concurrency, items.length));

  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;

      // Abort stops *dispatch* only — requests already in flight are not
      // cancellable (they may already have been paid for), so they settle normally.
      if (options.signal?.aborted) {
        results[index] = { ok: false, index, error: abortError() };
        continue;
      }

      try {
        results[index] = { ok: true, index, value: await run(items[index]!, index) };
      } catch (error) {
        results[index] = { ok: false, index, error: toProxyClientError(error) };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
