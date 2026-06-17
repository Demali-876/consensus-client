export type EvmNetwork = {
  key: string;
  label: string;
  chainId: number;
  usdc: `0x${string}`;
};

export type SvmNetwork = {
  key: string;
  label: string;
  caip2: string;
  rpc: string;
  usdc: string;
};

export type IcpCanister = {
  id: string;
  symbol: string;
};

export const EVM_NETWORKS = [
  {
    key: 'ethereum',
    label: 'Ethereum',
    chainId: 1,
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  {
    key: 'base',
    label: 'Base',
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  {
    key: 'baseSep',
    label: 'Base Sepolia',
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  {
    key: 'ethSep',
    label: 'Sepolia',
    chainId: 11155111,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
] as const satisfies readonly EvmNetwork[];

export const SVM_NETWORKS = [
  {
    key: 'mainnet',
    label: 'Mainnet',
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    rpc: 'https://api.mainnet-beta.solana.com',
    usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  {
    key: 'devnet',
    label: 'Devnet',
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    rpc: 'https://api.devnet.solana.com',
    usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
] as const satisfies readonly SvmNetwork[];

export const ICP_CANISTERS = [
  { id: 'ryjl3-tyaaa-aaaaa-aaaba-cai', symbol: 'ICP' },
  { id: 'ss2fx-dyaaa-aaaar-qacoq-cai', symbol: 'ckETH' },
  { id: 'xevnm-gaaaa-aaaar-qafnq-cai', symbol: 'ckUSDC' },
  { id: 'cngnf-vqaaa-aaaar-qag4q-cai', symbol: 'ckUSDT' },
  { id: 'xafvr-biaaa-aaaai-aql5q-cai', symbol: 'TESTICP' },
] as const satisfies readonly IcpCanister[];

const EVM_RPC_ENV: Record<number, string> = {
  1: 'CONSENSUS_ETHEREUM_RPC_URL',
  8453: 'CONSENSUS_BASE_RPC_URL',
  84532: 'CONSENSUS_BASE_SEPOLIA_RPC_URL',
  11155111: 'CONSENSUS_SEPOLIA_RPC_URL',
};

const EVM_RPC_DEFAULTS: Record<number, readonly string[]> = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'],
  8453: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  84532: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
  11155111: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://11155111.rpc.thirdweb.com'],
};

export function getEvmRpcUrls(chainId: number): string[] {
  const envName = EVM_RPC_ENV[chainId];
  const custom = envName ? process.env[envName] : undefined;
  const urls = [custom, ...(EVM_RPC_DEFAULTS[chainId] ?? [])]
    .filter((url): url is string => Boolean(url));
  return [...new Set(urls)];
}

export function getEvmUsdcAddress(chainId: number): `0x${string}` | undefined {
  return EVM_NETWORKS.find((network) => network.chainId === chainId)?.usdc;
}

export function getSvmNetwork(caip2: string): SvmNetwork | undefined {
  return SVM_NETWORKS.find((network) => network.caip2 === caip2);
}

export function getIcpCanisterSymbol(canisterId: string): string | undefined {
  return ICP_CANISTERS.find((canister) => canister.id === canisterId)?.symbol;
}
