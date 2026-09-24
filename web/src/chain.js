// Chain yang sedang ditampilkan dasbor. Diisi dari /api/overview (status.chain) setiap
// poll, dibaca oleh pembantu non-React (fmt.js: tautan penjelajah) dan komponen.
//
// Satu dasbor = satu chain pada satu waktu: server memilih chain dari cookie
// lpcopy_chain (lihat ChainSwitcher), jadi setiap /api/* sudah otomatis milik chain ini.
const DEFAULT = {
  key: 'robinhood', label: 'Robinhood Chain', chainId: 4663, nativeSymbol: 'ETH',
  usdgSymbol: 'USDG', wethSymbol: 'WETH', explorer: 'https://robinhoodchain.blockscout.com',
  dexscreener: 'robinhood', geckoterminal: 'robinhood', gmgn: 'robinhood', uniswap: 'robinhood', venues: ['v4', 'v3'], verified: true,
};
let current = { ...DEFAULT };

export const setChain = (info) => { if (info?.key) current = { ...DEFAULT, ...info }; };
// Solana: alamat base58, PEKA HURUF — tidak boleh di-lowercase seperti alamat EVM.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isSolana = () => current.kind === 'solana';
// Bentuk kanonik alamat di chain ini (EVM huruf kecil, Solana apa adanya).
export const canonAddr = (a) => (isSolana() ? String(a || '').trim() : String(a || '').trim().toLowerCase());
export const isAddr = (a) => (isSolana() ? BASE58.test(String(a || '')) : /^0x[0-9a-f]{40}$/.test(String(a || '')));
// Rujukan pool: EVM alamat v3 atau poolId v4 (32 byte); Solana alamat akun pool.
export const isPoolRef = (r) => (isSolana() ? BASE58.test(String(r || '')) : /^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(String(r || '')));
export const chainInfo = () => current;
// Simbol yang dinilai lewat harga native (ETH/WETH di Robinhood, BNB/WBNB di BSC).
export const isEthLike = (sym) => sym === current.nativeSymbol || sym === current.wethSymbol;
// Ikon kecil per chain di pemilih & header (public/*.png|jpg, logo resmi masing-masing chain).
export const CHAIN_ICON = {
  robinhood: '/robinhood-chain.jpg',
  bsc: '/bnb-chain.png',
  solana: '/solana.svg',
};
