import json, sys
from playwright.sync_api import sync_playwright

B='http://127.0.0.1:8799'
PLAN = {"plan":{"liquidity":"1"},"warnings":["rentangnya sempit — fee besar tapi cepat keluar"],
 "preview":{"pair":"HOOKR/USDG","venue":"v4","feePct":3.04,"symbol0":"HOOKR","symbol1":"USDG",
  "dec0":18,"dec1":6,"quoteSide":1,"tickLower":-322900,"tickUpper":-317900,"curTick":-319936,
  "valueUsd":50,"amount0":"1500000000000000000000","amount1":"25000000","side":"both","hasHooks":False,"kasUsd":400}}
QUOTE = {"symbolIn":"USDG","symbolOut":"ETH","amountIn":50,"amountOut":0.0201,
  "usdIn":50,"usdOut":49.6,"lossBps":80,"dex":"kyber-v4+orvex","maxLossBps":1500,"tooLossy":False}
QUOTE_BAD = dict(QUOTE, lossBps=3200, tooLossy=True, usdOut=34)
SCAN = {"status":"selesai","progress":100,"total":287,"hidden":283,"pools":[
 {"poolRef":"0x"+"11"*32,"pair":"FATCOIN/USDG","venue":"v4","fee":3011,"feePct":0.3011,"dynamicFee":False,
  "hasHooks":False,"kosong":False,"quoteSide":1,"symbol0":"FATCOIN","symbol1":"USDG","lastTs":None},
 {"poolRef":"0x"+"22"*32,"pair":"ETH/FATCOIN","venue":"v4","fee":10000,"feePct":1.0,"dynamicFee":False,
  "hasHooks":True,"kosong":False,"quoteSide":0,"symbol0":"ETH","symbol1":"FATCOIN","lastTs":None}]}
ALAMAT = '0x12d5ee7917ca430073c3a638ee1e6f0648a98a01'
TOKENS = {"tokens":[
  {"address":"0x5fc5360d0400a0fd4f2af552add042d716f1d168","symbol":"USDG","decimals":6,"raw":"150000000","amount":150,"isQuote":True,"native":False},
  {"address":"0x0000000000000000000000000000000000000000","symbol":"ETH","decimals":18,"raw":"100000000000000000","amount":0.1,"isQuote":True,"native":True},
  {"address":"0x7a492b0a2d630b94791af846c1842db9e623420c","symbol":"MEME","decimals":18,"raw":"0","amount":0,"isQuote":False,"native":False}]}
# overview dipalsukan LIVE hanya untuk satu kasus, supaya konfirmasi dua langkah ikut teruji
LIVE = {"mode":{"dry_run":False,"paused":False,"wallet":"0x"+"11"*20},
 "chain":{"head":1,"cursor":1,"lag":0,"ethUsd":2500,"headSpread":0},
 "stats":{"startedAt":0,"uptimeSec":10},"totals":{"actions":0,"copied":0,"would":0,"skipped":0,"errors":0},
 "summary":{"openCount":0,"exposureUsd":0,"costUsd":0,"feeUsd":0,"unrealizedUsd":0,"realizedUsd":0,"inRange":0},
 "equity":[],"decisionsTotal":0,"skipReasons":[],"rpc":[],"unsupportedSenders":[],"lastSync":0}

KATA = {
 'id': {'pool':'Pilih pool','nominal':'Nominal','rentang':'Rentang harga','ganti':'Ganti',
        'dari':'Dari','ke':'Ke','biaya':'Biaya rute','buka':'Buka posisi','konfirm':'sungguhan','tukar':'Tukar','live':'Nyalakan LIVE','cari':'Cari pool untuk token ini'},
 'en': {'pool':'Pick a pool','nominal':'Amount','rentang':'Price range','ganti':'Change',
        'dari':'From','ke':'To','biaya':'Route cost','buka':'Open ','konfirm':'real transaction','tukar':'Swap','live':'Switch to LIVE','cari':'Find pools for this token'},
}
errs=[]

def cek(pg, lbl, lang, mode, live):
    K = KATA[lang]
    pg.route('**/api/manual/lp/plan', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(PLAN)))
    pg.route('**/api/manual/swap/quote', lambda r: r.fulfill(status=200, content_type='application/json',
             body=json.dumps(QUOTE_BAD if mode=='bad' else QUOTE)))
    def scan(r):
        if r.request.method == 'POST':
            r.fulfill(status=200, content_type='application/json', body=json.dumps({"ok":True,"status":"jalan"}))
        else:
            r.fulfill(status=200, content_type='application/json', body=json.dumps(SCAN))
    pg.route('**/api/manual/pools/scan*', scan)
    pg.route('**/api/manual/tokens', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(TOKENS)))
    if live:
        pg.route('**/api/overview', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(LIVE)))

    # ---- LP manual ----
    pg.goto(B+'/#lp-manual', wait_until='domcontentloaded'); pg.wait_for_timeout(2300)
    body = pg.inner_text('body')
    for k in ('pool','nominal','rentang'):
        if K[k] not in body: errs.append(f'{lbl} LP: tidak ada "{K[k]}"')
    # ---- cari pool dari alamat token (dilakukan lebih dulu: belum ada yang dipilih,
    # jadi pemilihnya masih terbuka dan halaman tidak perlu dimuat ulang) ----
    pg.locator('input[placeholder]').first.fill(ALAMAT); pg.wait_for_timeout(300)
    tombol = pg.locator('button').filter(has_text=K['cari'])
    if tombol.count()==0:
        errs.append(f'{lbl} LP: tombol cari pool tidak muncul untuk alamat token')
    else:
        tombol.first.click(); pg.wait_for_timeout(2200)
        b3 = pg.inner_text('body')
        if 'FATCOIN/USDG' not in b3: errs.append(f'{lbl} LP: hasil pindai tidak tampil')
        if '287' not in b3: errs.append(f'{lbl} LP: jumlah pool yang ada tidak disebut')
        hasilp = pg.locator('div.max-h-80 button')
        if hasilp.count() != 2: errs.append(f'{lbl} LP: hasil pindai harusnya 2 baris, ada {hasilp.count()}')
    # kotak cari dikosongkan -> kembali ke daftar pool yang dikenal
    pg.locator('input[placeholder]').first.fill(''); pg.wait_for_timeout(400)
    if 'FATCOIN/USDG' in pg.inner_text('body') and pg.locator('div.max-h-80 button').count() == 2:
        errs.append(f'{lbl} LP: hasil pindai tidak hilang saat kotak cari dikosongkan')

    pools = pg.locator('div.max-h-80 button')
    if pools.count() == 0:
        errs.append(f'{lbl} LP: daftar pool kosong'); return
    pools.first.click(); pg.wait_for_timeout(300)
    if K['ganti'] not in pg.inner_text('body'):
        errs.append(f'{lbl} LP: tombol ganti pool tidak muncul setelah dipilih')
    pg.get_by_label(KATA[lang]['nominal'] if lang=='id' else 'Position amount').fill('50')
    pg.wait_for_timeout(1000)
    b2 = pg.inner_text('body')
    for must in [('50,00' if lang=='id' else '50.00'), 'HOOKR', 'USDG']:
        if must not in b2: errs.append(f'{lbl} LP: pratinjau tidak memuat "{must}"')
    if 'rentangnya sempit' not in b2: errs.append(f'{lbl} LP: peringatan dari server tidak ditampilkan')
    if live:
        tombol = pg.locator('button').filter(has_text=K['buka'])
        if tombol.count()==0: errs.append(f'{lbl} LP: tombol buka tidak ada')
        elif tombol.first.is_disabled(): errs.append(f'{lbl} LP: mode LIVE tapi tombol buka mati')
        else:
            tombol.first.click(); pg.wait_for_timeout(300)
            if K['konfirm'] not in pg.inner_text('body'):
                errs.append(f'{lbl} LP: konfirmasi dua langkah tidak muncul')
    else:
        # mode simulasi: bukan tombol mati, tapi jalan keluar ke Pengaturan
        jalan = pg.locator('button').filter(has_text=K['live'])
        if jalan.count()==0 or jalan.first.is_disabled():
            errs.append(f'{lbl} LP: mode simulasi tidak menawarkan jalan ke Pengaturan')
        else:
            jalan.first.click(); pg.wait_for_timeout(400)
            if 'settings' not in pg.url: errs.append(f'{lbl} LP: tombol simulasi tidak membawa ke Pengaturan')

    # ---- Swap ----
    pg.goto(B+'/#swap', wait_until='domcontentloaded'); pg.wait_for_timeout(1900)
    sb = pg.inner_text('body')
    for k in ('dari','ke'):
        if K[k] not in sb: errs.append(f'{lbl} Swap: tidak ada "{K[k]}"')
    pg.get_by_label('Jumlah yang ditukar' if lang=='id' else 'Amount to swap').fill('50')
    pg.wait_for_timeout(1200)
    sb = pg.inner_text('body')
    if '0,0201' not in sb and '0.0201' not in sb: errs.append(f'{lbl} Swap: hasil kutipan tidak tampil')
    if K['biaya'] not in sb: errs.append(f'{lbl} Swap: rincian kutipan tidak tampil')
    tukar = pg.locator('button').filter(has_text=K['tukar'])
    hidup = [i for i in range(tukar.count()) if not tukar.nth(i).is_disabled()]
    if mode=='bad':
        if hidup: errs.append(f'{lbl} Swap: rute rugi 32% tapi tombol tukar masih bisa ditekan')
        if '32' not in sb: errs.append(f'{lbl} Swap: peringatan rugi tidak menyebut angkanya')
    elif live and not hidup:
        errs.append(f'{lbl} Swap: mode LIVE, kutipan bagus, tapi tombol tukar mati')
    if pg.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth+1'):
        errs.append(f'{lbl} Swap: halaman melebar ke samping')

KASUS = [(1440,900,'desktop','id','ok',False), (1440,900,'desktop','en','ok',False),
         (1440,900,'desktop','id','bad',False), (1440,900,'desktop','id','ok',True),
         (390,844,'hp','id','ok',False), (390,844,'hp','id','ok',True)]
with sync_playwright() as p:
    for nama, br in [('chromium', p.chromium), ('webkit', p.webkit)]:
        b = br.launch()
        for w,h,dv,lang,mode,live in KASUS:
            pg = b.new_page(viewport={'width':w,'height':h})
            pg.add_init_script(f"try{{localStorage.setItem('lpcopy-lang','{lang}')}}catch(e){{}}")
            lbl=f'{nama}/{dv}/{lang}/{mode}{"/LIVE" if live else ""}'
            pg.on('pageerror', lambda e, l=lbl: errs.append(f'{l} pageerror: {e}'))
            # Logo token yang memang tidak ada menjawab 404 — itu jalur normal
            # (lambang cadangan dibangkitkan dari alamat), bukan galat halaman.
            pg.on('console', lambda mm, l=lbl: errs.append(f'{l} console: {mm.text[:160]}')
                  if mm.type=='error' and '/api/icon' not in mm.location.get('url','') and 'api/icon' not in mm.text else None)
            try: cek(pg, lbl, lang, mode, live)
            except Exception as e: errs.append(f'{lbl} GAGAL: {str(e)[:160]}')
            pg.close()
        b.close()
print('\n'.join(dict.fromkeys(errs)) if errs else 'semua pemeriksaan tampilan lolos')
sys.exit(1 if errs else 0)
