// Mirrored from consensus-node src/crypto/identity.ts — TYPE ONLY.
//
// The node's identity module also creates/loads on-disk Ed25519 keys and exposes
// sign/verify helpers; all of that is node-only (filesystem state) and the client
// never holds a node identity. The client only verifies the node's proof against
// the orchestrator-pinned public key, so it needs just this shape. responder-auth
// and data-handshake reference the type; keeping the name/path identical lets the
// rest of those files stay byte-for-byte in sync with the node.
export interface NodeIdentity {
  privateKeyPem: string;
  publicKeyPem: string;
}
