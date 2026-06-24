# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is **`consensus-client`** — `@canister-software/consensus-cli`, the TypeScript SDK + TUI/CLI for the [Consensus Protocol](https://github.com/Demali-876/consensus). It talks to the orchestrator (`consensus`) and, going forward, directly to worker nodes (`consensus-node`).

**Canonical cross-repo reference:** the architecture + cross-repo contracts live in `consensus-docs` → https://docs.consensus.canister.software/protocol/architecture/ ([source](https://github.com/canister-software/consensus-docs/blob/main/src/content/docs/protocol/architecture.md)). Read it before changing anything that touches the `/proxy` request/response shapes, the routing/caching headers, or the routing-ticket flow. Related repos: [`consensus`](https://github.com/Demali-876/consensus) (orchestrator), [`consensus-node`](https://github.com/Demali-876/consensus-node) (worker-node runtime), [`consensus-docs`](https://github.com/canister-software/consensus-docs) (docs), [`consensus-facilitator`](https://github.com/Demali-876/consensus-facilitator) (x402 facilitator).

## Commands

Requires **Bun ≥ 1.3** (`bin/consensus` shebang is `#!/usr/bin/env bun`). The published library form (`dist/index.js`, `dist/index.cjs`) targets Node ≥ 20.19 (the floor for `@noble/ciphers` 2.x, used by the data-plane `secure-channel`).

```bash
bun install
bun run consensus     # one-shot CLI (bin/consensus.ts); no args → TUI
bun run dev           # bun --watch CLI
bun run setup         # `consensus setup` — generates wallet + config
bun run build         # clean + esm + cjs + .d.ts to dist/
bun run start-server  # test/proxy/server.ts (local dev proxy)
```

Required env: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` (Coinbase Developer Platform). Optional: `CONSENSUS_SERVER_URL` (defaults to `https://consensus.canister.software`). For local dev, raw keys `CONSENSUS_EVM_KEY` / `CONSENSUS_SVM_KEY` instead of CDP.

## Architecture

`src/index.ts` is the public SDK surface. Two consumption modes:

- **As a library** (Express middleware): `ProxyClient` (`src/proxy-client.ts`) intercepts `fetch()` inside an `AsyncLocalStorage` context. `mode: 'inclusive'` (default) proxies everything except listed routes; `'exclusive'` proxies only the listed routes. Tracks USD spend against an optional `limit_usd` and stands down to direct fetch when reached.
- **As a CLI**: `bin/consensus.ts` dispatches to `bin/commands/*.ts` — `setup`, `tunnel`, `proxy` (aliased `reverse-proxy`), `ws`, `ip`, `help`. With no command it boots the TUI (`bin/tui/navigator.ts`; each route is a screen module under `bin/tui/screens/`).

Other SDK pieces:

- `createPaymentFetch` (`src/payment-fetch.ts`) — wraps `globalThis.fetch` with x402 retry logic, signing payments via the resolved wallet.
- `resolveSigners` (`src/wallet.ts`) — boots EVM (viem) + Solana signers from CDP credentials, or from raw private keys for local dev.
- `dispatchProxy` (`src/proxy-worker.ts`) — spawns a local forward/reverse proxy server that forwards through the Consensus network; used by `consensus proxy start`.
- `SocketClient` (`src/socket-client.ts`) — paid WebSocket session client matching the server's `/ws` flow.

Setup state lives in `~/.consensus-config.json` (`bin/lib/store.ts`). `consensus setup` writes `CONSENSUS_*` exports into the user's shell profiles inside an idempotent marker block (`bin/lib/setup.ts`) — do not append a second block.

## Conventions

- ESM; import paths to compiled output use `.js` extensions even from `.ts` sources (Bun + Node resolution).
- Under Bun the SDK is read straight from `src/` (the `exports` map routes Bun → `src/`, Node → `dist/`), so no rebuild is needed between edits; `bun run build` produces the published ESM + CJS + `.d.ts`.

## Direction (in progress)

The client is being updated for the control-plane / data-plane split: instead of the orchestrator relaying every request, the client asks the server to select a node, then connects **directly to that node** with a short-lived signed ticket (see the canonical reference). Public SDK APIs are intended to stay stable across the migration.
