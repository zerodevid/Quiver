// Layar pembuka (#splash di index.html) ditutup di sini — sekali, setelah data
// pertama tiba atau ada galat yang harus terlihat. Tampil minimal MIN_MS sejak
// navigasi dimulai: cukup untuk satu gerakan logo sehingga merek teringat, tidak
// cukup lama untuk terasa menunda. Koneksi lambat tidak menambah waktu tunggu
// buatan — layar ditutup begitu data ada.
const MIN_MS = 1500;
const MAX_MS = 8_000;    // API tidak menjawab: jangan kurung pengguna di logo

let closing = false;
export function hideSplash() {
  const el = document.getElementById('splash');
  // Juga saat ditandai gagal: data sudah tiba berarti aplikasinya jalan.
  if (!el || closing) return;
  closing = true;
  setTimeout(() => {
    el.dataset.state = 'leaving';
    const done = () => el.remove();
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 600);   // transisi tidak berjalan (tab di latar, reduced motion)
  }, Math.max(0, MIN_MS - performance.now()));
}

export function armSplashTimeout() {
  setTimeout(hideSplash, Math.max(0, MAX_MS - performance.now()));
}
