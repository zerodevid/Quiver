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
export const chainInfo = () => current;
// Simbol yang dinilai lewat harga native (ETH/WETH di Robinhood, BNB/WBNB di BSC).
export const isEthLike = (sym) => sym === current.nativeSymbol || sym === current.wethSymbol;
// Ikon kecil per chain di pemilih & header (public/*.png|jpg, logo resmi masing-masing chain).
export const CHAIN_ICON = {
  robinhood: '/robinhood-chain.jpg',
  bsc: '/bnb-chain.png',
};
