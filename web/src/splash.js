// Layar pembuka (#splash di index.html) ditutup di sini — sekali, setelah data
// pertama tiba atau ada galat yang harus terlihat. Tampil minimal MIN_MS sejak
// navigasi dimulai: cukup untuk satu gerakan logo sehingga merek teringat, tidak
// cukup lama untuk terasa menunda. Koneksi lambat tidak menambah waktu tunggu
// buatan — layar ditutup begitu data ada.
//
// Penutupnya transisi: logo terbang dan mengecil tepat ke logo header sementara
// latarnya memudar, lalu logo header menyambut dengan satu tembakan panah (sekali,
// lalu diam — .brand-arrive di index.css). Tanpa header yang terlihat, dengan
// prefers-reduced-motion, atau di tab latar: cukup memudar.
const MIN_MS = 1500;
const MAX_MS = 8_000;    // API tidak menjawab: jangan kurung pengguna di logo

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Logo header yang sedang tampil: sidebar di desktop, header atas di HP.
function visibleBrandLogo() {
  return [...document.querySelectorAll('[data-brand-logo]')]
    .find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
}

// Animasi panah layar pembuka berulang; hentikan dengan halus dari pose saat ini
// (bukan melompat) supaya yang terbang adalah logo yang diam.
function settle(logo) {
  for (const n of logo.querySelectorAll('svg, path')) {
    const cs = getComputedStyle(n);
    const tf = cs.transform, op = cs.opacity;
    n.style.animation = 'none';
    n.style.transform = tf === 'none' ? '' : tf;
    n.style.opacity = op;
    n.getBoundingClientRect();   // paksa gaya terpasang sebelum transisi
    n.style.transition = 'transform .25s ease, opacity .25s ease';
    n.style.transform = '';
    n.style.opacity = '1';
  }
}

const root = document.documentElement;

// Menu & isi halaman muncul berurutan (html.app-enter di index.css).
function reveal() {
  if (!root.classList.contains('has-splash')) return;
  root.classList.add('app-enter');
  root.classList.remove('has-splash');
  setTimeout(() => root.classList.remove('app-enter'), 1600);
}

function land(el, target) {
  reveal();
  root.classList.remove('brand-pending');
  if (target) {
    target.style.visibility = '';
    const brand = target.closest('[data-brand]');
    if (brand) {
      brand.classList.add('brand-arrive');
      setTimeout(() => brand.classList.remove('brand-arrive'), 1600);
    }
  }
  el.remove();
}

function fly(el) {
  const logo = el.querySelector('.sp-logo');
  const target = visibleBrandLogo();
  if (!logo || !target || reducedMotion() || document.hidden) return false;
  settle(logo);
  const a = logo.getBoundingClientRect(), b = target.getBoundingClientRect();
  const scale = b.width / a.width;
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  target.style.visibility = 'hidden';   // satu logo di layar, bukan dua
  root.classList.add('brand-pending');  // keterangan di bawah logo muncul setelah mendarat
  el.dataset.state = 'flying';
  logo.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  // Gerak cepat-lalu-melambat: logo praktis sudah di tempat pada ~60% durasi —
  // isi halaman mulai muncul di situ, bukan menunggu logo benar-benar berhenti.
  setTimeout(reveal, 360);
  let done = false;
  const finish = () => { if (!done) { done = true; land(el, target); } };
  logo.addEventListener('transitionend', (e) => { if (e.target === logo && e.propertyName === 'transform') finish(); });
  setTimeout(finish, 1000);   // transisi tidak melapor (tab berpindah di tengah jalan)
  return true;
}

let closing = false;
export function hideSplash() {
  const el = document.getElementById('splash');
  // Tanpa layar pembuka (sudah dihapus): isi halaman jangan sampai tetap tersembunyi.
  if (!el) { root.classList.remove('has-splash', 'brand-pending'); return; }
  // Juga saat ditandai gagal: data sudah tiba berarti aplikasinya jalan.
  if (closing) return;
  closing = true;
  setTimeout(() => {
    if (!el.classList.contains('sp-failed') && fly(el)) return;
    reveal();   // tanpa terbang: isi halaman muncul di bawah layar yang memudar
    el.dataset.state = 'leaving';
    let done = false;
    const finish = () => { if (!done) { done = true; land(el, null); } };
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 600);   // transisi tidak berjalan (tab di latar, reduced motion)
  }, Math.max(0, MIN_MS - performance.now()));
}

export function armSplashTimeout() {
  setTimeout(hideSplash, Math.max(0, MAX_MS - performance.now()));
}
