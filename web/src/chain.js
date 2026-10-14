// The chain the dashboard is currently showing. Filled from /api/overview (status.chain) on every
// poll, read by non-React helpers (fmt.js: explorer links) and components.
//
// Normally one dashboard = one chain: the server picks the chain from the lpcopy_chain cookie
// (see ChainSwitcher), so every /api/* already belongs to this chain.
//
// "All chains" view (cookie = all): the aggregate pages (Summary, Positions, Activity) list rows
// from every chain, each row tagged with `chain`. A row's links read that chain's identity from
// the registry (chainInfo(key) / useChainInfo() under <OnChain>), and requests made for that
// row carry ?chain=<key> (api.js), which the server's front door honours.
import { createContext, createElement, useContext } from 'react';

const DEFAULT = {
  key: 'robinhood', label: 'Robinhood Chain', chainId: 4663, nativeSymbol: 'ETH',
  usdgSymbol: 'USDG', wethSymbol: 'WETH', explorer: 'https://robinhoodchain.blockscout.com',
  dexscreener: 'robinhood', geckoterminal: 'robinhood', gmgn: 'robinhood', uniswap: 'robinhood', venues: ['v4', 'v3'], verified: true,
};
let current = { ...DEFAULT };
// Every chain's identity by key, from /api/chains (ChainSwitcher keeps it filled).
const registry = new Map();

export const setChain = (info) => { if (info?.key) current = { ...DEFAULT, ...info }; };
export const registerChains = (list) => { for (const c of list || []) if (c?.key) registry.set(c.key, { ...DEFAULT, ...registry.get(c.key), ...c }); };
// A chain's identity: by key when given and known, otherwise the chain being shown.
export const chainInfo = (key) => (key && registry.has(key) ? registry.get(key) : current);
export const knownChains = () => [...registry.values()];
// Set by App from the status poll; separate from `current`, which a single-chain page inside the
// combined view points at the chain it is scoped to.
// Starts from the lpcopy_chain cookie (not HttpOnly) so the very first requests already go out
// in the combined shape, before the first status arrives.
let allMode = typeof document !== 'undefined' && /(?:^|;\s*)lpcopy_chain=all(?:;|$)/.test(document.cookie || '');
export const setAllMode = (on) => { allMode = !!on; };
export const isAllChains = () => allMode;

// Which chain a row belongs to, for components rendered inside it (links, icons).
const RowChain = createContext(null);
export const OnChain = ({ chain, children }) => (chain
  // display:contents: no box of its own; data-chain lets a click inside the row set the
  // request scope (see setScope) before the row's dialog or page asks the server anything
  ? createElement(RowChain.Provider, { value: chain }, createElement('span', { 'data-chain': chain, className: 'contents' }, children))
  : children);
export const useRowChain = () => useContext(RowChain);
export const useChainInfo = () => chainInfo(useContext(RowChain));

// Request scope in the all-chains view: the chain the last clicked row belongs to, or the one
// picked on a single-chain page. api.js adds ?chain=<scope> to requests while it is set.
const SCOPE_KEY = 'lpcopy.scope';
let scope = null;
try { scope = sessionStorage.getItem(SCOPE_KEY) || null; } catch { /* storage blocked */ }
export const getScope = () => scope;
export const setScope = (key) => {
  scope = key || null;
  try { if (scope) sessionStorage.setItem(SCOPE_KEY, scope); else sessionStorage.removeItem(SCOPE_KEY); } catch { /* storage blocked */ }
};
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-chain]');
    if (el && isAllChains()) setScope(el.getAttribute('data-chain'));
  }, true);
}

// Chain filter of the combined view: which chains are summed. Empty = the server's default
// (every live chain). Kept per browser.
const FILTER_KEY = 'lpcopy.chainFilter';
let filter = [];
try { filter = JSON.parse(localStorage.getItem(FILTER_KEY) || '[]').filter((k) => typeof k === 'string'); } catch { filter = []; }
export const getChainFilter = () => filter;
export const setChainFilter = (keys) => {
  filter = [...new Set(keys || [])];
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filter)); } catch { /* storage blocked */ }
};

// Solana: base58 addresses, CASE-SENSITIVE — must not be lower-cased like EVM addresses.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isSolana = () => current.kind === 'solana';
// The canonical form of an address (EVM lower case, Solana as is). Decided by the address, not
// the chain being shown: the all-chains view lists EVM and Solana rows together, and base58 has
// no '0' character, so a 0x prefix is always EVM.
export const canonAddr = (a) => { const s = String(a || '').trim(); return /^0x/i.test(s) ? s.toLowerCase() : s; };
// A market lookup reference for a row of the all-chains view: `<ref>@<chain>` (see allchains.js).
export const chainRef = (ref, row) => (ref && row?.chain ? `${ref}@${row.chain}` : ref);
export const isAddr = (a) => (isSolana() ? BASE58.test(String(a || '')) : /^0x[0-9a-f]{40}$/.test(String(a || '')));
// Pool reference: EVM v3 address or v4 poolId (32 bytes); Solana the pool account address.
export const isPoolRef = (r) => (isSolana() ? BASE58.test(String(r || '')) : /^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(String(r || '')));
// Symbols valued through the native price (ETH/WETH on Robinhood, BNB/WBNB on BSC).
export const isEthLike = (sym, key) => { const c = chainInfo(key); return sym === c.nativeSymbol || sym === c.wethSymbol; };
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
