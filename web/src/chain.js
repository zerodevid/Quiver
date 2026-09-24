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
// Nama penjelajah blok chain ini — dipakai sebagai label tombol wallet (fmt.js/ui.jsx),
// karena "Blockscout" dan "BscScan" lebih dikenal daripada nama host-nya.
export const EXPLORER_NAME = {
  robinhood: 'Blockscout',
  bsc: 'BscScan',
};
// Etherscan chain ini, kalau ada — indeks tx/token yang berbeda dari Blockscout, jadi
// keduanya berguna berdampingan. Di BSC penjelajahnya SUDAH BscScan (keluarga Etherscan),
// jadi tidak ada entri kedua: satu tombol untuk satu situs.
export const ETHERSCAN = {
  robinhood: 'https://robin.etherscan.io',
};
