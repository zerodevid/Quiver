// The chain the dashboard is currently showing. Filled from /api/overview (status.chain) on every
// poll, read by non-React helpers (fmt.js: explorer links) and components.
//
// One dashboard = one chain at a time: the server picks the chain from the
// lpcopy_chain cookie (see ChainSwitcher), so every /api/* already belongs to this chain.
const DEFAULT = {
  key: 'robinhood', label: 'Robinhood Chain', chainId: 4663, nativeSymbol: 'ETH',
  usdgSymbol: 'USDG', wethSymbol: 'WETH', explorer: 'https://robinhoodchain.blockscout.com',
  dexscreener: 'robinhood', geckoterminal: 'robinhood', gmgn: 'robinhood', uniswap: 'robinhood', venues: ['v4', 'v3'], verified: true,
};
let current = { ...DEFAULT };

export const setChain = (info) => { if (info?.key) current = { ...DEFAULT, ...info }; };
// Solana: base58 addresses, CASE-SENSITIVE — must not be lower-cased like EVM addresses.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isSolana = () => current.kind === 'solana';
// The canonical form of an address on this chain (EVM lower case, Solana as is).
export const canonAddr = (a) => (isSolana() ? String(a || '').trim() : String(a || '').trim().toLowerCase());
export const isAddr = (a) => (isSolana() ? BASE58.test(String(a || '')) : /^0x[0-9a-f]{40}$/.test(String(a || '')));
// Pool reference: EVM v3 address or v4 poolId (32 bytes); Solana the pool account address.
export const isPoolRef = (r) => (isSolana() ? BASE58.test(String(r || '')) : /^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(String(r || '')));
export const chainInfo = () => current;
// Symbols valued through the native price (ETH/WETH on Robinhood, BNB/WBNB on BSC).
export const isEthLike = (sym) => sym === current.nativeSymbol || sym === current.wethSymbol;
// Small icon per chain in the picker & header (public/*.png|jpg, each chain's official logo).
export const CHAIN_ICON = {
  robinhood: '/robinhood-chain.jpg',
  bsc: '/bnb-chain.png',
  solana: '/solana.svg',
  ethereum: '/ethereum-chain.png',
  base: '/base-chain.png',
  arbitrum: '/arbitrum-chain.png',
  optimism: '/optimism-chain.png',
  polygon: '/polygon-chain.png',
  avalanche: '/avalanche-chain.png',
};
// Name of this chain's block explorer — used as the wallet button label (fmt.js/ui.jsx),
// because "Blockscout" and "BscScan" are better known than the host name.
export const EXPLORER_NAME = {
  robinhood: 'Blockscout',
  bsc: 'BscScan',
  solana: 'Solscan',
  ethereum: 'Etherscan',
  base: 'BaseScan',
  arbitrum: 'Arbiscan',
  optimism: 'Optimistic Etherscan',
  polygon: 'PolygonScan',
  avalanche: 'Snowtrace',
};
// This chain's Etherscan, if any — its tx/token index differs from Blockscout, so
// the two are useful side by side. On BSC the explorer IS already BscScan (Etherscan family),
// so there is no second entry: one button for one site.
export const ETHERSCAN = {
  robinhood: 'https://robin.etherscan.io',
};
