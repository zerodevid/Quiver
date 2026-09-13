// Shared presentation copy for historical engine messages. Never changes stored logs.
import errors from './locales/errors.en.json' with { type: 'json' };
import fragments from './locales/engine.en.json' with { type: 'json' };

const exact = {
  'tidak ada cermin posisi yang cocok': ['No matching bot position', 'Tidak ada posisi bot yang terkait'],
  'Tidak bisa dihubungi': ['Endpoint unreachable', 'Tidak dapat dihubungi'],
  'target membuka posisi baru': ['The target opened a new position', 'Target membuka posisi baru'],
  'rute tidak ada': ['No route available', 'Rute tidak tersedia'],
  'persen harus antara 0 dan 100': ['Enter a percentage greater than 0 and up to 100.', 'Masukkan persentase lebih dari 0 hingga 100.'],
  'jumlah harus angka, \"semua\", atau persen (mis. 50%)': ['Enter a number, all, or a percentage (for example, 50%).', 'Masukkan angka, semua, atau persentase (misalnya 50%).'],
  'target menutup posisi': ['The target closed its position', 'Target menutup posisi'],
  'target memindahkan posisinya': ['The target transferred its position', 'Target memindahkan posisi'],
  'sinyal keluar terlewat — posisi target sudah kosong': ['The target position is empty; closing the matching bot position', 'Posisi target sudah kosong; menutup posisi bot yang terkait'],
  'ikut-keluar dimatikan': ['Following target exits is disabled', 'Opsi mengikuti penutupan target dinonaktifkan'],
  'target sedang dimatikan': ['The target is disabled', 'Target sedang dinonaktifkan'],
  'bot sedang dijeda': ['The bot is paused', 'Bot sedang dijeda'],
  'kita tidak punya cermin posisi ini': ['No matching bot position', 'Tidak ada posisi bot yang terkait'],
  'porsi keluar nol': ['No liquidity to withdraw', 'Tidak ada likuiditas yang dapat ditarik'],
  'likuiditas sudah nol di chain': ['On-chain liquidity is zero', 'Likuiditas di chain sudah nol'],
  'jumlah posisi terbuka sudah mentok': ['The open position limit has been reached', 'Batas posisi terbuka telah tercapai'],
  'nilai referensi nol, tidak bisa menskala ke nominal tetap': ['Cannot size the position because its reference value is zero', 'Ukuran posisi tidak dapat dihitung karena nilai referensi nol'],
  'ukuran hasil hitung nol': ['Calculated position size is zero', 'Hasil perhitungan ukuran posisi adalah nol'],
  'tidak bisa menilai posisi': ['Position valuation is unavailable', 'Nilai posisi belum tersedia'],
  'belum ada wallet': ['No wallet connected', 'Wallet belum terhubung'],
  'batas per posisi': ['per-position limit', 'batas per posisi'],
  'sisa jatah eksposur total': ['remaining exposure allowance', 'sisa batas eksposur'],
  'sisa anggaran harian': ['remaining daily budget', 'sisa anggaran harian'],
  'kas tersedia': ['available cash', 'kas tersedia'],
};
// Captures retain amounts, symbols and identifiers. Nested reasons are translated recursively.
const rules = [
  [/^sinyal masuk basi — target masuk (.+) lalu \(batas (.+)\); harga & pool sudah berubah, tidak disalin$/s,
    'Stale entry signal — the target entered {1} ago (limit {2}); price and pool have moved, not copied',
    'Sinyal masuk basi — target masuk {1} lalu (batas {2}); harga & pool sudah berubah, tidak disalin'],
  [/^(\d+) jam (\d+) mnt$/, '{1} h {2} min', '{1} jam {2} mnt'],
  [/^(\d+) jam$/, '{1} h', '{1} jam'],
  [/^(\d+) mnt$/, '{1} min', '{1} mnt'],
  [/^(\d+) dtk$/, '{1} s', '{1} dtk'],
  [/^(.+) \(rentang dikecilkan ke (\d+) blok\)$/s, '{1} (scan range reduced to {2} blocks)', '{1} (rentang pindai dikurangi menjadi {2} blok)'],
  [/^semua endpoint RPC \(yang mendukung getLogs\) tumbang: (.+)$/s, 'All RPC endpoints supporting getLogs failed: {1}', 'Semua endpoint RPC yang mendukung getLogs gagal: {1}'],
  [/^semua endpoint RPC tumbang: (.+)$/s, 'All RPC endpoints failed: {1}', 'Semua endpoint RPC gagal: {1}'],
  [/^saldo cuma (.+)$/s, 'Available balance: {1}', 'Saldo tersedia: {1}'],
  [/^(.+) harus di antara (.+) dan (.+)$/, '{1} must be between {2} and {3}', '{1} harus di antara {2} dan {3}'],
  [/^target menarik (.+)% likuiditas$/, 'The target withdrew {1}% of its liquidity', 'Target menarik {1}% likuiditas'],
  [/^LP ditutup: (.+)$/s, 'Position closed: {1}', 'Posisi ditutup: {1}'],
  [/^LP disalin: (.+)$/s, 'Position copied: {1}', 'Posisi disalin: {1}'],
  [/^tutup penuh posisi #(\d+)(.*)$/s, 'Fully closed position #{1}{2}', 'Menutup seluruh posisi #{1}{2}'],
  [/^kurangi posisi #(\d+)(.*)$/s, 'Reduced liquidity in position #{1}{2}', 'Mengurangi likuiditas posisi #{1}{2}'],
  [/^jual sisa #(\d+): (.+)$/s, 'Leftover sale for position #{1}: {2}', 'Penjualan sisa posisi #{1}: {2}'],
  [/^(.+?) belum terjual: (.+)$/s, '{1} remains unsold: {2}', '{1} belum terjual: {2}'],
  [/^rute Kyber rugi ([\d.,]+)% \(batas ([\d.,]+)%\)(.*)$/s, 'Kyber route loss is {1}% (limit {2}%){3}', 'Kerugian rute Kyber {1}% (batas {2}%){3}'],
  [/^dipotong oleh (.+?) \((\$[\d.,]+)\)(.*)$/s, 'Position size capped by the {1} ({2}){3}', 'Ukuran posisi dibatasi oleh {1} ({2}){3}'],
  [/^target menutup posisi — (.+)$/s, 'The target closed its position — {1}', 'Target menutup posisi — {1}'],
  [/^target menarik ([\d.,]+)%$/, 'The target withdrew {1}%', 'Target menarik {1}%'],
  [/^posisi #(\d+): sisa terjual, hasil (.+?) menggantikan taksiran tutup (.+)$/s, 'Position #{1}: leftover sale proceeds of {2} replace the closing estimate of {3}', 'Posisi #{1}: hasil penjualan sisa {2} menggantikan taksiran penutupan {3}'],
  [/^posisi #(\d+): (.+)$/s, 'Position #{1}: {2}', 'Posisi #{1}: {2}'],
  [/^jual (.+?) → (.+)$/s, 'Sold {1} → {2}', 'Menjual {1} → {2}'],
  [/^keluar mandiri #(\d+): (.+)$/s, 'Exit rule triggered for position #{1}: {2}', 'Aturan keluar terpicu untuk posisi #{1}: {2}'],
  [/^stop loss (.+)$/, 'Stop loss reached: {1}', 'Batas kerugian tercapai: {1}'],
  [/^take profit (.+)$/, 'Take profit reached: {1}', 'Target keuntungan tercapai: {1}'],
  [/^umur (.+) jam$/, 'Holding time: {1} hours', 'Durasi posisi: {1} jam'],
  [/^di luar rentang (.+) menit$/, 'Out of range for {1} minutes', 'Di luar rentang selama {1} menit'],
  [/^kuotasi (.+) tidak diizinkan$/, 'Quote asset {1} is not allowed', 'Aset kuotasi {1} tidak diizinkan'],
  [/^(.+) habis$/, '{1} exhausted', '{1} telah habis'],
  [/^hasil keluar #(\d+) tidak terukur: (.+)$/s, 'Closing proceeds for position #{1} could not be measured: {2}', 'Hasil penutupan posisi #{1} tidak dapat diukur: {2}'],
  [/^sisa #(\d+) tidak terukur: (.+)$/s, 'Leftover tokens for position #{1} could not be measured: {2}', 'Token sisa posisi #{1} tidak dapat diukur: {2}'],
  [/^sebelum tutup #(\d+): (.+)$/s, 'Before closing position #{1}: {2}', 'Sebelum menutup posisi #{1}: {2}'],
  [/^eksekusi masuk: (.+)$/s, 'Opening transaction failed: {1}', 'Transaksi pembukaan gagal: {1}'],
  [/^catat hasil jual sisa(?: #(\d+))?: (.+)$/s, 'Could not record leftover sale proceeds {1}: {2}', 'Hasil penjualan sisa {1} tidak dapat dicatat: {2}'],
  [/^coba ulang jual sisa #(\d+): (.+)$/s, 'Retrying the leftover sale for position #{1}: {2}', 'Mencoba kembali penjualan sisa posisi #{1}: {2}'],
];
const orderedFragments = Object.entries(fragments).sort((a,b)=>b[0].length-a[0].length);
export function sentenceCase(text) {
  return String(text ?? '').replace(/^(\s*)([a-z])/, (_, space, ch) => space + ch.toUpperCase());
}
export function formatNote(text, language = 'id', depth = 0) {
  if (text == null || text === '') return text;
  const raw = String(text);
  if (depth > 8) return raw;
  const en = language === 'en';
  if (en && errors[raw]) return errors[raw];
  const pair = exact[raw];
  if (pair) return pair[en ? 0 : 1];
  for (const [re, english, indonesian] of rules) {
    const m = re.exec(raw);
    if (m) return (en ? english : indonesian).replace(/\{(\d+)\}/g, (_, i) => formatNote(m[Number(i)] || '', language, depth + 1));
  }
  if (!en) return raw;
  // Split structured reason chains before the legacy fragment fallback.
  if (raw.includes(' — ')) return raw.split(' — ').map(s => formatNote(s, language, depth + 1)).join(' — ');
  let out = raw;
  for (const [from,to] of orderedFragments) out = out.split(from).join(to);
  return out !== raw && !depth ? sentenceCase(out) : out;
}
