import { describe, expect, test } from 'bun:test';
import {
  EVM_NETWORKS,
  ICP_CANISTERS,
  getEvmRpcUrls,
  getEvmUsdcAddress,
  getIcpCanisterSymbol,
} from '../bin/lib/network-config.ts';

describe('wallet network configuration', () => {
  test('every displayed EVM network has RPC fallbacks and USDC configured', () => {
    for (const network of EVM_NETWORKS) {
      expect(getEvmRpcUrls(network.chainId).length).toBeGreaterThan(0);
      expect(getEvmUsdcAddress(network.chainId)).toBe(network.usdc);
    }
  });

  test('uses canonical ICP ledger canister IDs', () => {
    expect(getIcpCanisterSymbol('ss2fx-dyaaa-aaaar-qacoq-cai')).toBe('ckETH');
    expect(getIcpCanisterSymbol('xevnm-gaaaa-aaaar-qafnq-cai')).toBe('ckUSDC');
    expect(getIcpCanisterSymbol('cngnf-vqaaa-aaaar-qag4q-cai')).toBe('ckUSDT');
    expect(ICP_CANISTERS.map(({ id }) => String(id))).not.toContain('3jkp5-oyaaa-aaaaj-azwqa-cai');
  });
});
