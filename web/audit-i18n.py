# Bandingkan teks yang tampil di setiap halaman antara mode ID dan EN.
# Teks yang IDENTIK di kedua mode = kemungkinan belum diterjemahkan.
from playwright.sync_api import sync_playwright
import re, sys
B="http://127.0.0.1:8799"
PAGES=["ringkasan","posisi","aktivitas","target","aturan","wallet","scout","pengaturan"]
# pola yang memang tidak perlu diterjemahkan
SKIP=re.compile(r"^[\s\d.,%$€Ξ×–—·/()+\-]*$|^0x|^#\d|^v[34]$|USDG|WETH|ETH|Uniswap|lpcopy|ntfy|pm2|RPC|API|URL|PnL|uPnL|DPR|IL|getLogs|LIVE|Permit2|Alchemy|Ankr|bps|gwei|ms$|Bearer|x-api-key|x-token|LP$|^—$|Indonesia|English")
def texts(pg):
    return set(x.strip() for x in pg.evaluate("""()=>{
      const out=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      let n; while(n=w.nextNode()){const s=n.textContent.trim(); if(s.length>2) out.push(s);} 
      for(const e of document.querySelectorAll('[placeholder],[title],[aria-label]'))
        for(const a of ['placeholder','title','aria-label']){const v=e.getAttribute(a); if(v&&v.trim().length>2) out.push(v.trim());}
      return out;}"""))
with sync_playwright() as p:
    b=p.chromium.launch(); res={}
    for lang in ["id","en"]:
        ctx=b.new_context(viewport={"width":1500,"height":1200})
        ctx.add_init_script(f"localStorage.setItem('lpcopy-lang','{lang}')")
        pg=ctx.new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
        for page in PAGES:
            pg.goto(f"{B}/#{page}", wait_until="networkidle"); pg.wait_for_timeout(1600)
            if page=="pengaturan":
                for tab in ["RPC","Gas","Notifikasi","Notifications","Mesin","Engine","Keamanan","Security"]:
                    try: pg.get_by_role("tab", name=tab).click(timeout=800); pg.wait_for_timeout(500)
                    except Exception: pass
            res.setdefault(lang,set()).update(texts(pg))
        if errs: print(f"ERR JS ({lang}):", errs[:3])
        ctx.close()
    b.close()
same = sorted(x for x in (res['id'] & res['en']) if not SKIP.search(x))
print(f"teks ID={len(res['id'])} EN={len(res['en'])} | identik & mencurigakan: {len(same)}")
for x in same[:40]: print("   ", x[:95])
