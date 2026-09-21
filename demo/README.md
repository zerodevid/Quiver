# Video demo Quiver

Pipeline rekaman video presentasi dasbor — jalan sepenuhnya lokal (Chromium headless,
ffmpeg, Kokoro TTS). Hasil: `out/quiver-demo-<lang>.mp4` (1080p60) + `.srt`.

**Privasi.** Alamat wallet (target, riset, wallet bot), label target, dan nomor NFT posisi
diganti nilai palsu *sebelum* respons API sampai ke browser (`privacy.mjs`); alamat & label
lalu diblur dan diaudit tiap 0,6 detik selama rekaman — kalau ada yang lolos, video tidak
dirakit. Semua nilai uang & jumlah token dikalikan faktor rahasia (`QSCALE`, default
diturunkan dari token akses) sehingga saldo, PnL, fee, dan grafik tetap konsisten tapi bukan
angka asli; harga, tick, dan harga ETH tidak diubah. Semua request non-GET ke `/api`
diblokir, jadi rekaman tidak bisa menyentuh bot produksi. (`QMONEY_BLUR=1` mengaktifkan
blur angka modal sebagai lapisan tambahan — tidak dipakai secara default karena jelek.)

## Prasyarat

- Node 22+, `ffmpeg` (Homebrew), Chromium Playwright (`npx playwright install chromium`)
- Dasbor yang datanya mau direkam terjangkau di `http://127.0.0.1:20150` (atau set `QBASE`)
- Token akses dasbor di `QTOKEN`

## Jalankan

```sh
cd demo && npm install
./tunnel.sh 20180 &                             # terowongan SSH ke dasbor VPS (port instance; lpcopy3 = 20180)
export QBASE=http://127.0.0.1:20180
export QTOKEN="$(ssh singapore 'grep ^LPCOPY_AUTH_TOKEN= ~/lpcopy/.env | cut -d= -f2-')"

QLANG=en npm run voice                          # narasi -> out/vo/en/*.wav
QLANG=en QINTRO=13000 QOUTRO=11500 npm run studio   # kartu intro/outro + latar/bingkai (durasi ms)
QLANG=en npm run record                         # adegan aplikasi -> out/app-en.mp4 + timeline (dipacu narasi)
QLANG=en npm run compose                        # final -> out/quiver-demo-en.mp4 + .srt
```

## Berkas

| Berkas | Peran |
| --- | --- |
| `copy.mjs` | Naskah: kicker, subtitle, narasi per adegan, teks intro/outro (en/id) |
| `privacy.mjs` | Sensor data, blokir tulis, cache respons (`out/cache`), audit kebocoran |
| `record.mjs` | Sutradara: kamera zoom, kursor, spotlight, subtitle, kartu bab; menulis timeline |
| `studio.mjs` | Kartu intro/outro dan aset bingkai, gaya mengikuti dasbor |
| `voice.mjs` | Narasi: Kokoro (en) atau suara sistem macOS (id) |
| `compose.mjs` | Bingkai, transisi, campuran VO + efek suara, SRT |
| `capture.mjs` | Screencast CDP → MP4 kecepatan tetap |
| `shots.mjs` | Cuplikan halaman dengan sensor aktif, untuk memeriksa hasil sensor (`node shots.mjs summary,drawer,detail`) |

## Catatan

- Respons dasbor di-cache di `out/cache` setelah rekaman pertama; rekaman berikutnya
  offline dan deterministik. `rm -rf out/cache` untuk data segar.
- Ubah naskah di `copy.mjs`, lalu ulangi voice → studio → record → compose.
- `QLANG=id` memakai suara macOS "Damayanti" (Kokoro belum punya bahasa Indonesia);
  `QVOICE` mengganti suara (`af_heart`, `am_michael`, `bf_emma`, …).
- `QAUTHOR="Nama · github.com/…"` menambah baris kredit di outro.
- `out/` tidak masuk git (render, cache, model TTS ±300 MB, frame mentah).
