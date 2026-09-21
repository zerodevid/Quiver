'use strict';
// Penyeragaman jawaban OpenAPI GMGN (token/info, token/security, top holders /
// traders, wallet_stats) menjadi bentuk ringkas yang dipakai dasbor. Semua angka
// GMGN datang sebagai string; rasio 0–1 diubah ke persen di sini supaya UI dan
// poolHealth tidak perlu tahu konvensi GMGN. Kolom yang tidak terisi jadi null —
// GMGN dirancang untuk meme Solana/BSC, sebagian kolom bisa kosong untuk
// Robinhood, dan UI hanya menampilkan yang ada.
const num = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
const pctOf = (v) => { const n = num(v); return n == null ? null : n * 100; };
const yes = (v) => (v === 'yes' || v === true || v === 1 ? true : v === 'no' || v === false || v === 0 ? false : null);
const ms = (v) => { const n = num(v); return n > 0 ? n * 1000 : null; };
const lc = (a) => (a ? String(a).toLowerCase() : null);
const WINDOWS = ['1m', '5m', '1h', '6h', '24h'];

function normalizeTokenInfo(d) {
  const x = d?.token || d || {};
  const price = x.price && typeof x.price === 'object' ? x.price : {};
  const now = num(price.price) ?? num(x.price);
  const supply = num(x.circulating_supply) ?? num(x.total_supply);
  const windows = {};
  for (const w of WINDOWS) {
    const was = num(price[`price_${w}`]);
    windows[w] = {
      change: was > 0 && now > 0 ? (now / was - 1) * 100 : null,
      buys: num(price[`buys_${w}`]), sells: num(price[`sells_${w}`]), swaps: num(price[`swaps_${w}`]),
      volume: num(price[`volume_${w}`]), buyVolume: num(price[`buy_volume_${w}`]), sellVolume: num(price[`sell_volume_${w}`]),
    };
  }
  const st = x.stat || {}, dv = x.dev || {}, ln = x.link || {}, tg = x.wallet_tags_stat || {}, pool = x.pool || {};
  return {
    address: lc(x.address), symbol: x.symbol || null, name: x.name || null, logo: x.logo || null, decimals: num(x.decimals),
    priceUsd: now, supply, mcapUsd: now > 0 && supply > 0 ? now * supply : null,
    liquidityUsd: num(x.liquidity), holderCount: num(x.holder_count) ?? num(st.holder_count),
    athPriceUsd: num(x.ath_price), lockedPct: pctOf(x.locked_ratio), og: x.og === true,
    createdAt: ms(x.creation_timestamp), openAt: ms(x.open_timestamp),
    launchpad: x.launchpad || x.launchpad_platform || null, hotLevel: num(price.hot_level),
    pool: pool.pool_address ? { address: lc(pool.pool_address), exchange: pool.exchange || null, quoteSymbol: pool.quote_symbol || null, liquidityUsd: num(pool.liquidity), feePct: pctOf(pool.fee_ratio) } : null,
    windows,
    tags: {
      smart: num(tg.smart_wallets), renowned: num(tg.renowned_wallets), sniper: num(tg.sniper_wallets), rat: num(tg.rat_trader_wallets),
      bundler: num(tg.bundler_wallets), whale: num(tg.whale_wallets), fresh: num(tg.fresh_wallets), top: num(tg.top_wallets),
    },
    stat: {
      top10Pct: pctOf(st.top_10_holder_rate ?? dv.top_10_holder_rate), devTeamPct: pctOf(st.dev_team_hold_rate), creatorPct: pctOf(st.creator_hold_rate),
      ratVolPct: pctOf(st.top_rat_trader_percentage), bundlerVolPct: pctOf(st.top_bundler_trader_percentage), entrapmentVolPct: pctOf(st.top_entrapment_trader_percentage),
      botDegenPct: pctOf(st.bot_degen_rate), freshWalletPct: pctOf(st.fresh_wallet_rate), vaultPct: pctOf(st.private_vault_hold_rate),
    },
    dev: {
      creator: lc(dv.creator_address), status: dv.creator_token_status || null, balance: num(dv.creator_token_balance),
      openCount: num(dv.creator_open_count), cto: yes(dv.cto_flag), fundFrom: lc(dv.fund_from), fundFromAt: ms(dv.fund_from_ts),
      dexscrAd: yes(dv.dexscr_ad), dexscrBoost: yes(dv.dexscr_boost_fee), dexscrTrending: yes(dv.dexscr_trending_bar),
      athToken: dv.ath_token_info?.ath_token ? { address: lc(dv.ath_token_info.ath_token), symbol: dv.ath_token_info.symbol || null, mcapUsd: num(dv.ath_token_info.ath_mc) } : null,
    },
    links: {
      twitter: ln.twitter_username ? `https://x.com/${String(ln.twitter_username).replace(/^@/, '')}` : null,
      website: ln.website || null, telegram: ln.telegram || null, discord: ln.discord || null,
      gmgn: ln.gmgn || null, description: ln.description || null,
    },
  };
}

function normalizeTokenSecurity(d) {
  const x = d?.security || d || {};
  return {
    honeypot: yes(x.is_honeypot), openSource: yes(x.open_source), ownerRenounced: yes(x.owner_renounced),
    buyTaxPct: pctOf(x.buy_tax), sellTaxPct: pctOf(x.sell_tax),
    top10Pct: pctOf(x.top_10_holder_rate), devTeamPct: pctOf(x.dev_team_hold_rate), creatorPct: pctOf(x.creator_balance_rate),
    creatorSold: x.creator_token_status === 'creator_close' ? true : x.creator_token_status === 'creator_hold' ? false : null,
    insiderPct: pctOf(x.suspected_insider_hold_rate),
    rugPct: pctOf(x.rug_ratio), washTrading: x.is_wash_trading === true ? true : x.is_wash_trading === false ? false : null,
    ratVolPct: pctOf(x.rat_trader_amount_rate), bundlerVolPct: pctOf(x.bundler_trader_amount_rate),
    sniperCount: num(x.sniper_count), lpBurned: x.burn_status === 'burn' ? true : x.burn_status === '' ? false : null,
  };
}

// Baris top holders / top traders — bentuknya sama.
function normalizeWallets(d) {
  const list = Array.isArray(d) ? d : d?.list || d?.holders || d?.traders || [];
  return list.filter((r) => r && r.address).map((r) => ({
    address: lc(r.address), rank: r.wallet_tag_v2 || null,
    isPool: r.addr_type === 2, exchange: r.exchange || null,
    balance: num(r.balance) ?? num(r.amount_cur), usd: num(r.usd_value), pct: pctOf(r.amount_percentage),
    avgCost: num(r.avg_cost), avgSold: num(r.avg_sold), soldPct: pctOf(r.sell_amount_percentage),
    buyUsd: num(r.buy_volume_cur), sellUsd: num(r.sell_volume_cur), buyN: num(r.buy_tx_count_cur), sellN: num(r.sell_tx_count_cur),
    profit: num(r.profit), profitPct: pctOf(r.profit_change), realized: num(r.realized_profit), unrealized: num(r.unrealized_profit),
    isNew: r.is_new === true, suspicious: r.is_suspicious === true, transferIn: r.transfer_in === true,
    tags: Array.isArray(r.tags) ? r.tags : [], tokenTags: Array.isArray(r.maker_token_tags) ? r.maker_token_tags : [],
    name: r.name || null, twitter: r.twitter_username || null,
    since: ms(r.start_holding_at), exitAt: ms(r.end_holding_at), lastActive: ms(r.last_active_timestamp),
    fundFrom: lc(r.native_transfer?.address), fundFromName: r.native_transfer?.name || null,
  }));
}

function normalizeWalletStats(d, period = '7d') {
  const x = Array.isArray(d) ? d[0] : d?.list?.[0] || d || {};
  const c = x.common || {};
  return {
    period,
    realized: num(x.realized_profit), unrealized: num(x.unrealized_profit), winratePct: pctOf(x.winrate),
    cost: num(x.total_cost), buys: num(x.buy_count), sells: num(x.sell_count), pnlPct: pctOf(x.pnl),
    name: c.name || null, ens: c.ens || null, tag: c.tag || null, tags: Array.isArray(c.tags) ? c.tags : [],
    twitter: c.twitter_username || null, followers: num(c.followers_count), followCount: num(c.follow_count),
    createdTokens: num(c.created_token_count), createdAt: ms(c.created_at),
    fundFrom: c.fund_from || null, fundFromAddress: lc(c.fund_from_address), fundAmount: num(c.fund_amount),
    avatar: c.avatar || null,
  };
}

module.exports = { normalizeTokenInfo, normalizeTokenSecurity, normalizeWallets, normalizeWalletStats, WINDOWS };
