import re, glob, json, sys
# ambil semua literal di dalam t(...) / tt(...) dari sumber
lits=set()
for f in glob.glob('src/**/*.jsx', recursive=True)+glob.glob('src/*.js'):
    if f.endswith('i18n.jsx'): continue
    s=open(f).read()
    for m in re.finditer(r"\btt?\(\s*'((?:[^'\\]|\\.)*)'", s): lits.add(m.group(1).replace("\\'","'"))
    for m in re.finditer(r'\btt?\(\s*"((?:[^"\\]|\\.)*)"', s): lits.add(m.group(1))
# label/hint/title/desc/sub/placeholder yang diteruskan sebagai prop string
for f in glob.glob('src/**/*.jsx', recursive=True)+glob.glob('src/*.js'):
    if f.endswith('i18n.jsx'): continue
    s=open(f).read()
    for a in ['label','hint','help','title','desc','sub','placeholder','text','okText']:
        for m in re.finditer(rf'\b{a}[:=]\s*[\'"]([^\'"]{{3,}})[\'"]', s): lits.add(m.group(1))
    for m in re.finditer(r"\['[a-z_0-9]+', '([^']{3,})'\]", s): lits.add(m.group(1))   # opsi select & label aksi
# kamus
d=open('src/i18n.jsx').read()
keys=set(m.group(1).replace("\\'","'") for m in re.finditer(r"^\s*'((?:[^'\\]|\\.)+)':", d, re.M))
keys |= set(m.group(1) for m in re.finditer(r'^\s*"([^"]+)":', d, re.M))
SKIP=re.compile(r"^[\s\d.,%$/()+\-]*$|^0x|^#|^[a-z_]+$|^(RPC|API|URL|PnL|uPnL|DPR|IL|LP|ETH|USDG|WETH|Gas|Mode|Copy|Wallet|Scout|Menu|Auto-swap|Full range|Live|Simulasi|Telegram|v3|v4)$|^https?:|^mis\.|^e\.g\.|^0x…|^~|Uniswap|lpcopy")
missing=sorted(x for x in lits-keys if not SKIP.search(x) and len(x)>3)
print(f"literal ditemukan: {len(lits)} | ada di kamus: {len(lits&keys)} | BELUM diterjemahkan: {len(missing)}")
for x in missing: print("   ", x[:100])
