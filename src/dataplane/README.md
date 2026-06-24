# `src/dataplane/` — data-plane protocol (mirrored from `consensus-node`)

These modules are a **mirror** of the worker-node protocol in
[`consensus-node`](https://github.com/Demali-876/consensus-node), so the client can
connect **directly to a node** and run a request over an end-to-end-encrypted,
node-authenticated channel (the control-plane / data-plane split). The directory
mirrors the node's `src/crypto/` + `src/tunnel/` layout 1:1 so the shared files
stay byte-for-byte in sync.

| File | Node source | Sync |
|---|---|---|
| `crypto/canonical-json.ts` | `src/crypto/canonical-json.ts` | **byte-identical** |
| `crypto/secure-channel.ts` | `src/crypto/secure-channel.ts` | **byte-identical** |
| `crypto/identity.ts` | `src/crypto/identity.ts` | **type only** — the node module manages on-disk keys; the client never holds a node identity |
| `tunnel/frames.ts` | `src/tunnel/frames.ts` | **byte-identical** |
| `tunnel/responder-auth.ts` | `src/tunnel/responder-auth.ts` | **byte-identical** |
| `tunnel/data-handshake.ts` | `src/tunnel/data-handshake.ts` | **byte-identical** |
| `tunnel/data-plane.ts` | `src/tunnel/data-plane.ts` | **client subset** — `runDataRequest` + wire types only (drops `serveDataConnection` and its ticket / replay / SSRF imports) |
| `tunnel/test-vectors/*.json` | `src/tunnel/test-vectors/*.json` | copied fixtures |

The client is the **verifier**: it proves the node's identity against the
orchestrator-pinned key, and it treats the orchestrator routing **ticket as an
opaque string** — it never mints or verifies tickets (that's the node's job), so
no PASETO/key code is mirrored here.

`test/dataplane-vectors.test.ts` proves byte-for-byte parity against the committed
vectors and exercises a live handshake + `runDataRequest` round-trip. When the node
protocol changes: re-copy the byte-identical files, re-trim `data-plane.ts`, refresh
the vectors, and re-run the test.

> Nothing here is wired into the public SDK yet — the connector that calls
> `runDataRequest` after `POST /proxy` lands in the next step.
