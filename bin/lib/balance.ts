/**
 * balance.ts — resolve wallet balance for a single CAIP-2 network.
 * Used by the WebSocket setup screen (and anywhere else needing a quick per-network balance).
 */

import {
  getEvmUsdcAddress,
  getIcpCanisterSymbol,
  getSvmNetwork,
} from './network-config.ts';
import {
  resolveEvmAddress,
  resolveEvmEthBalance,
  resolveEvmUsdcBalance,
  resolveIcpCanisterBalance,
  resolveSvmAddress,
  resolveSvmUsdcBalance,
} from './wallet-balances.ts';

async function icpBalance(pemPath: string, canisterId: string): Promise<string> {
  const { readFileSync }            = await import('node:fs');
  const { resolve: resolvePath }    = await import('node:path');
  const { homedir }                 = await import('node:os');
  const { Secp256k1KeyIdentity }    = await import('@dfinity/identity-secp256k1');
  const { HttpAgent, Actor }        = await import('@dfinity/agent');

  const pem      = readFileSync(resolvePath(pemPath.replace(/^~/, homedir())), 'utf8');
  const identity = Secp256k1KeyIdentity.fromPem(pem);
  const agent    = HttpAgent.createSync({ host: 'https://ic0.app', identity, fetch: globalThis.fetch.bind(globalThis) });
  const owner    = identity.getPrincipal();
  const fallback = getIcpCanisterSymbol(canisterId) ?? canisterId.slice(0, 8);

  const { formatted, symbol } = await resolveIcpCanisterBalance(Actor, agent, owner, canisterId, fallback);
  return formatted === '—' ? formatted : `${formatted} ${symbol}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the wallet balance for a single CAIP-2 network identifier.
 * Returns a formatted string like "1.23 USDC" or "0.000042 ETH".
 * Returns '—' for the auto network ('') or unknown networks.
 */
export async function resolveNetworkBalance(caip2: string): Promise<string> {
  if (!caip2) return '—';

  const evmKey  = process.env.CONSENSUS_EVM_KEY;
  const svmKey  = process.env.CONSENSUS_SVM_KEY;
  const pemPath = process.env.CONSENSUS_PEM_PATH;

  try {
    if (caip2.startsWith('eip155:')) {
      if (!evmKey) return 'no EVM key';
      const chainId = parseInt(caip2.split(':')[1]!, 10);
      const addr = await resolveEvmAddress(evmKey);
      if (addr === '(invalid key)') return 'invalid key';
      const usdcAddr = getEvmUsdcAddress(chainId);
      return usdcAddr
        ? resolveEvmUsdcBalance(addr, chainId, usdcAddr)
        : resolveEvmEthBalance(addr, chainId);
    }

    if (caip2.startsWith('solana:')) {
      if (!svmKey) return 'no SVM key';
      const net = getSvmNetwork(caip2);
      if (!net) return '—';
      const addr = await resolveSvmAddress(svmKey);
      if (addr === '(invalid key)') return 'invalid key';
      return resolveSvmUsdcBalance(addr, net.rpc, net.usdc);
    }

    if (caip2.startsWith('icp:')) {
      if (!pemPath) return 'no ICP key';
      const canisterId = caip2.split(':')[2];
      if (!canisterId) return '—';
      return icpBalance(pemPath, canisterId);
    }
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 40) : '(error)';
  }

  return '—';
}
