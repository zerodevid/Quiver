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
SWAPS = {"swaps":[
  {"hash":"0x"+"ab"*32,"ts":1760000000000,"status":"sukses","error":None,"detail":{"tokenIn":"0x5fc5360d0400a0fd4f2af552add042d716f1d168",
   "tokenOut":"0x0000000000000000000000000000000000000000","symbolIn":"USDG","symbolOut":"ETH","amountIn":50,"amountOut":0.02}},
  {"hash":"0x"+"cd"*32,"ts":1759990000000,"status":"gagal","error":"revert","detail":{"usdIn":20,"usdOut":19.8}}]}
# overview is faked as LIVE for one case only, so the two-step confirmation gets tested too
LIVE = {"mode":{"dry_run":False,"paused":False,"wallet":"0x"+"11"*20},
 "chain":{"head":1,"cursor":1,"lag":0,"ethUsd":2500,"headSpread":0},
 "stats":{"startedAt":0,"uptimeSec":10},"totals":{"actions":0,"copied":0,"would":0,"skipped":0,"errors":0},
 "summary":{"openCount":0,"exposureUsd":0,"costUsd":0,"feeUsd":0,"unrealizedUsd":0,"realizedUsd":0,"inRange":0},
 "equity":[],"decisionsTotal":0,"skipReasons":[],"rpc":[],"unsupportedSenders":[],"lastSync":0}

WORDS = {
 'id': {'pool':'Pilih pool','amount':'Nominal','range':'Rentang harga','change':'Ganti',
        'from_':'Dari','to':'Ke','cost':'Biaya rute','open':'Buka posisi','confirm':'sungguhan','swap':'Tukar','live':'Nyalakan LIVE','find':'Cari pool untuk token ini'},
 'en': {'pool':'Pick a pool','amount':'Amount','range':'Price range','change':'Change',
        'from_':'From','to':'To','cost':'Route cost','open':'Open ','confirm':'real transaction','swap':'Swap','live':'Switch to LIVE','find':'Find pools for this token'},
}
errs=[]

def cek(pg, lbl, lang, mode, live):
    K = WORDS[lang]
    pg.route('**/api/manual/lp/plan', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(PLAN)))
    pg.route('**/api/manual/swap/quote', lambda r: r.fulfill(status=200, content_type='application/json',
             body=json.dumps(QUOTE_BAD if mode=='bad' else QUOTE)))
    def scan(r):
        if r.request.method == 'POST':
            r.fulfill(status=200, content_type='application/json', body=json.dumps({"ok":True,"status":"jalan"}))
        else:
            r.fulfill(status=200, content_type='application/json', body=json.dumps(SCAN))
    pg.route('**/api/manual/pools/scan*', scan)
    pg.route('**/api/manual/tokens*', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(TOKENS)))
    pg.route('**/api/manual/swaps', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(SWAPS)))
    if live:
        pg.route('**/api/overview', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(LIVE)))

    # ---- LP manual ----
    pg.goto(B+'/#lp-manual', wait_until='domcontentloaded'); pg.wait_for_timeout(2300)
    body = pg.inner_text('body')
    for k in ('pool','amount','range'):
        if K[k] not in body: errs.append(f'{lbl} LP: missing "{K[k]}"')
    # ---- find pools from a token address (done first: nothing is chosen yet,
    # so the picker is still open and the page need not be reloaded) ----
    pg.locator('input[placeholder]').first.fill(ALAMAT); pg.wait_for_timeout(300)
    button = pg.locator('button').filter(has_text=K['find'])
    if button.count()==0:
        errs.append(f'{lbl} LP: find-pool button not shown for a token address')
    else:
        button.first.click(); pg.wait_for_timeout(2200)
        b3 = pg.inner_text('body')
        if 'FATCOIN/USDG' not in b3: errs.append(f'{lbl} LP: scan result not shown')
        if '287' not in b3: errs.append(f'{lbl} LP: pool count not mentioned')
        scanRows = pg.locator('div.max-h-80 button')
        if scanRows.count() != 2: errs.append(f'{lbl} LP: scan result should have 2 rows, got {scanRows.count()}')
    # search box emptied -> back to the list of known pools
    pg.locator('input[placeholder]').first.fill(''); pg.wait_for_timeout(400)
    if 'FATCOIN/USDG' in pg.inner_text('body') and pg.locator('div.max-h-80 button').count() == 2:
        errs.append(f'{lbl} LP: scan result did not go away when the search box was emptied')

    pools = pg.locator('div.max-h-80 button')
    if pools.count() == 0:
        errs.append(f'{lbl} LP: pool list empty'); return
    pools.first.click(); pg.wait_for_timeout(300)
    if K['change'] not in pg.inner_text('body'):
        errs.append(f'{lbl} LP: change-pool button not shown after selecting')
    pg.get_by_label(WORDS[lang]['amount'] if lang=='id' else 'Position amount').fill('50')
    pg.wait_for_timeout(1000)
    b2 = pg.inner_text('body')
    for must in [('50,00' if lang=='id' else '50.00'), 'HOOKR', 'USDG']:
        if must not in b2: errs.append(f'{lbl} LP: preview does not contain "{must}"')
    if 'rentangnya sempit' not in b2: errs.append(f'{lbl} LP: server warning not shown')
    if live:
        button = pg.locator('button').filter(has_text=K['open'])
        if button.count()==0: errs.append(f'{lbl} LP: open button missing')
        elif button.first.is_disabled(): errs.append(f'{lbl} LP: LIVE mode but open button disabled')
        else:
            button.first.click(); pg.wait_for_timeout(300)
            if K['confirm'] not in pg.inner_text('body'):
                errs.append(f'{lbl} LP: two-step confirmation not shown')
    else:
        # simulation mode: not a dead button, but a way out to Settings
        settingsLink = pg.locator('button').filter(has_text=K['live'])
        if settingsLink.count()==0 or settingsLink.first.is_disabled():
            errs.append(f'{lbl} LP: simulation mode does not offer a way to Settings')
        else:
            settingsLink.first.click(); pg.wait_for_timeout(400)
            if 'settings' not in pg.url: errs.append(f'{lbl} LP: simulation button does not lead to Settings')

    # ---- Swap ----
    pg.goto(B+'/#swap', wait_until='domcontentloaded'); pg.wait_for_timeout(1900)
    sb = pg.inner_text('body')
    for k in ('from_','to'):
        if K[k] not in sb: errs.append(f'{lbl} Swap: missing "{K[k]}"')
    pg.get_by_label('Jumlah yang ditukar' if lang=='id' else 'Amount to swap').fill('50')
    pg.wait_for_timeout(1200)
    sb = pg.inner_text('body')
    if '0,0201' not in sb and '0.0201' not in sb: errs.append(f'{lbl} Swap: quote result not shown')
    if K['cost'] not in sb: errs.append(f'{lbl} Swap: quote breakdown not shown')
    swapBtn = pg.locator('button').filter(has_text=K['swap'])
    enabled = [i for i in range(swapBtn.count()) if not swapBtn.nth(i).is_disabled()]
    if mode=='bad':
        if enabled: errs.append(f'{lbl} Swap: route loses 32% but the swap button is still pressable')
        if '32' not in sb: errs.append(f'{lbl} Swap: loss warning does not state the figure')
    elif live and not enabled:
        errs.append(f'{lbl} Swap: LIVE mode, good quote, but swap button disabled')
    if pg.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth+1'):
        errs.append(f'{lbl} Swap: page overflows sideways')

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
            # A token logo that really does not exist answers 404 — that is the normal path
            # (the fallback icon is generated from the address), not a page error.
            pg.on('console', lambda mm, l=lbl: errs.append(f'{l} console: {mm.text[:160]}')
                  if mm.type=='error' and '/api/icon' not in mm.location.get('url','') and 'api/icon' not in mm.text else None)
            try: cek(pg, lbl, lang, mode, live)
            except Exception as e: errs.append(f'{lbl} FAILED: {str(e)[:160]}')
            pg.close()
        b.close()
print('\n'.join(dict.fromkeys(errs)) if errs else 'all UI checks passed')
sys.exit(1 if errs else 0)
