'use strict';
// Verifies the Solana profile (networks.js) straight against mainnet:
//   node src/solana/verify.js [https://rpc-url]
// Checks that the endpoint really is mainnet-beta (genesis hash), every venue program exists
// and is executable, the program IDs equal the ones the official SDKs build transactions with,
// and the quote asset mints (USDC/USDT/wSOL) exist with the recorded decimals. Run it
// before turning dry_run off — one wrong character means transactions to another program.
const { Connection, PublicKey } = require('@solana/web3.js');
const { build } = require('../networks');

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

async function verify(url = 'https://api.mainnet-beta.solana.com', log = console.log) {
  const p = build('solana');
  const conn = new Connection(url, 'confirmed');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(`${ok ? 'OK ' : 'GAGAL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

  const genesis = await conn.getGenesisHash();
  check('genesis mainnet-beta', genesis === MAINNET_GENESIS, genesis);
  const slot = await conn.getSlot();
  check('slot terbaru terbaca', slot > 0, String(slot));

  // Venue programs: the account exists, is executable, and equals the SDK constant.
  const sdk = {
    meteora: () => require('@meteora-ag/dlmm').LBCLMM_PROGRAM_IDS['mainnet-beta'],
    orca: () => require('@orca-so/whirlpools-sdk').ORCA_WHIRLPOOL_PROGRAM_ID.toBase58(),
    raydium: () => require('@raydium-io/raydium-sdk-v2').CLMM_PROGRAM_ID.toBase58(),
  };
  const progs = p.venues.map((v) => v.program);
  const infos = await conn.getMultipleAccountsInfo(progs.map((a) => new PublicKey(a)));
  p.venues.forEach((v, i) => {
    const a = infos[i];
    check(`program ${v.label}`, !!a?.executable, `${v.program} (${a ? (a.executable ? 'executable' : 'BUKAN program') : 'TIDAK ADA'})`);
    let s = null;
    try { s = sdk[v.key]?.(); } catch { s = null; }
    check(`program ${v.label} = SDK`, s === v.program, s || 'SDK tidak terbaca');
  });

  // Quote mints: exist, owned by the token program, decimals as in QUOTES.
  for (const [mint, q] of Object.entries(p.QUOTES)) {
    try {
      const r = await conn.getParsedAccountInfo(new PublicKey(mint));
      const info = r.value?.data?.parsed?.info;
      const dec = info?.decimals;
      check(`mint ${q.symbol}`, r.value?.data?.parsed?.type === 'mint' && dec === q.decimals, `${mint} (desimal ${dec ?? '?'}, harus ${q.decimals})`);
    } catch (e) { check(`mint ${q.symbol}`, false, e.message); }
  }
  const bad = results.filter((r) => !r.ok);
  log(bad.length ? `\n${bad.length} pemeriksaan GAGAL — jangan matikan dry_run` : `\nsemua ${results.length} pemeriksaan lulus`);
  return { ok: !bad.length, results };
}

module.exports = { verify, MAINNET_GENESIS };

if (require.main === module) {
  verify(process.argv[2]).then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => { console.error(e.message); process.exit(1); });
}
