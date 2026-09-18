// Chain yang sedang ditampilkan dasbor. Diisi dari /api/overview (status.chain) setiap
// poll, dibaca oleh pembantu non-React (fmt.js: tautan penjelajah) dan komponen.
//
// Satu dasbor = satu chain pada satu waktu: server memilih chain dari cookie
// lpcopy_chain (lihat ChainSwitcher), jadi setiap /api/* sudah otomatis milik chain ini.
const DEFAULT = {
  key: 'robinhood', label: 'Robinhood Chain', chainId: 4663, nativeSymbol: 'ETH',
  usdgSymbol: 'USDG', wethSymbol: 'WETH', explorer: 'https://robinhoodchain.blockscout.com',
  dexscreener: 'robinhood', geckoterminal: 'robinhood', venues: ['v4', 'v3'], verified: true,
};
let current = { ...DEFAULT };

export const setChain = (info) => { if (info?.key) current = { ...DEFAULT, ...info }; };
export const chainInfo = () => current;
// Simbol yang dinilai lewat harga native (ETH/WETH di Robinhood, BNB/WBNB di BSC).
export const isEthLike = (sym) => sym === current.nativeSymbol || sym === current.wethSymbol;
// Ikon kecil per chain di pemilih & header. BSC: lencana SVG polos (tanpa logo pihak ketiga).
export const CHAIN_ICON = {
  robinhood: '/robinhood-chain.jpg',
  bsc: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#F0B90B"/><path d="M10 3l3 3-3 3-3-3zM4 9l3 3-3 3-3-3zM16 9l3 3-3 3-3-3zM10 15l3 3-3 3-3-3z" fill="#1E1E1E"/></svg>'),
};
