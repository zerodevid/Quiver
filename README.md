<p align="center">
  <img src="public/quiver-512.png" alt="Quiver" width="96" />
</p>

<h1 align="center">Quiver</h1>

<p align="center">
  <strong>Copy-LP engine for Robinhood Chain.</strong><br />
  Mirrors Uniswap v4 and v3 liquidity positions from any set of target wallets,<br />
  with a bilingual web dashboard and a full-featured Telegram bot.
</p>

<p align="center">
  <img alt="Node.js ≥ 22.5" src="https://img.shields.io/badge/node-%E2%89%A5%2022.5-339933?logo=node.js&logoColor=white" />
  <img alt="ethers v6" src="https://img.shields.io/badge/ethers-v6-2535a0" />
  <img alt="React 19" src="https://img.shields.io/badge/react-19-61dafb?logo=react&logoColor=white" />
  <img alt="Chain 4663" src="https://img.shields.io/badge/chain-Robinhood%20(4663)-cc0000" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-169%20passing-brightgreen" />
</p>

> 🇮🇩 The original, more discursive Indonesian documentation is preserved in [`README.id.md`](README.id.md).

---

## Table of contents

- [Overview](#overview)
- [Key features](#key-features)
- [Architecture](#architecture)
- [How detection works](#how-detection-works)
- [Quick start](#quick-start)
- [Command-line interface](#command-line-interface)
- [Configuration](#configuration)
  - [Secrets in `.env`](#secrets-in-env)
- [Copy rules](#copy-rules)
- [Going live](#going-live)
- [Dashboard](#dashboard)
- [Telegram bot](#telegram-bot)
- [Wallet research](#wallet-research)
- [RPC layer](#rpc-layer)
- [Deployment](#deployment)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Engineering notes](#engineering-notes)
- [Known limitations](#known-limitations)
- [Security](#security)

---

## Overview

Quiver watches one or more **target wallets** on Robinhood Chain (chainId `4663`) and reproduces their liquidity-provision activity on **Uniswap v4** and **Uniswap v3** in your own wallet, subject to a configurable rule set: position sizing, range transformation, hook and token filters, exposure caps, and exit triggers.

It ships **in simulation mode by default**. No transaction is ever broadcast until you explicitly flip the `SIMULATION → LIVE` switch in the dashboard or set `mode.dry_run: false`.

Everything the engine does is observable and controllable from three equivalent surfaces — a **React dashboard**, a **Telegram bot**, and a small **CLI** — all of which talk to the same internal API, so validation and safety rails are implemented exactly once.

---

## Key features

| Area | What you get |
|---|---|
| **Event-driven detection** | Tracks `PoolManager.ModifyLiquidity` (v4), `IncreaseLiquidity` / `DecreaseLiquidity` (v3), and ERC-721 `Transfer` events instead of decoding router calldata — so new routers and automation services are picked up automatically. |
| **Flexible sizing** | `mirror`, `pct`, `multiplier`, or `fixed_quote` (USD or ETH), all bounded by per-position, total-exposure, and daily-budget caps. Oversized entries are scaled down proportionally, not rejected. |
| **Range strategies** | `exact`, `recenter`, `scale`, `width_pct`, `full` — snapped to the pool's `tickSpacing`. Explicit policy for one-sided (limit-order-like) positions. |
| **Two-tier auto-swap** | A *treasury bridge* (`ETH ↔ WETH ↔ USDG`) ensures you hold the pool's quote asset, then an in-pool *zap* acquires the speculative side and **re-sizes from real balances** after the swap. Both are slippage- and price-impact-bounded. |
| **Exit management** | Follow the target out (fully or proportionally), plus independent triggers: out-of-range timer, stop-loss, take-profit, and maximum age. Stale signals are never executed in LIVE mode. |
| **Exact fee accounting** | Unclaimed v4 fees are computed from `PoolManager` storage (`feeGrowthInside`), not estimated. v3 fees use `Collect − Decrease`. |
| **Wallet research** | Full historical reconstruction of any wallet's LP performance (profit, win rate, fees, average capital, daily calendar) persisted in SQLite. Cross-checked against LP Agent to within ~1%. |
| **Manual LP & swap** | Open positions and swap assets by hand through the *same* execution path used by the copier, with live previews and two-step confirmation. |
| **Resilient RPC pool** | Method-aware routing across multiple endpoints, DNS-over-HTTPS with IP pinning (defeats ISP DNS hijacking), automatic failover, recursive `getLogs` range splitting, and a lowest-head block cursor. |
| **Bilingual UI** | Indonesian / English with locale-aware number and date formatting. |
| **Operational tooling** | pm2 process definition, one-command deploy script, structured logs, single-instance lock. |

---

## Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │                 Robinhood Chain              │
                         │  PoolManager · PositionManager · NPM v3 …    │
                         └───────────────┬──────────────────────────────┘
                                         │ JSON-RPC (multiple endpoints, method-routed)
                                         ▼
┌──────────────┐   ┌────────────────────────────────────────────────────────────┐
│  CLI (`lp`)  │   │                        src/engine.js                       │
│  scout · add │   │  ┌───────────┐  ┌───────────┐  ┌────────────┐  ┌────────┐  │
│  list · run  │──▶│  │  watcher  │─▶│  policy   │─▶│  executor  │─▶│ Kyber  │  │
└──────────────┘   │  │  (events) │  │  (rules)  │  │ (tx build) │  │ (swap) │  │
                   │  └───────────┘  └───────────┘  └────────────┘  └────────┘  │
                   │        │              │               │                     │
                   │        ▼              ▼               ▼                     │
                   │  ┌─────────────────────────────────────────────────────┐    │
                   │  │        SQLite (node:sqlite) — data/lpcopy.db        │    │
                   │  │  targets · positions · decisions · wallets · equity │    │
                   │  └─────────────────────────────────────────────────────┘    │
                   └───────────────────────────┬────────────────────────────────┘
                                               │ server.api(method, path, body)
                          ┌────────────────────┼─────────────────────┐
                          ▼                    ▼                     ▼
                 ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐
                 │  HTTP API +     │  │  React dashboard │  │  Telegram bot   │
                 │  static server  │  │  (web/dist)      │  │  (src/telegram) │
                 └─────────────────┘  └──────────────────┘  └─────────────────┘
```

The engine runs three timers: a **tick** (`loop.poll_ms`, default 1.5 s) that scans new blocks and evaluates target actions, a **position sync** (`loop.sync_seconds`) that refreshes value, PnL, IL, and exit triggers, and an **equity snapshot** (`loop.equity_seconds`) for the portfolio chart.

The HTTP server is started **before** engine initialisation so the dashboard is reachable while the engine is still warming up on a slow RPC.

---

## How detection works

Target wallets on this chain interact with liquidity through several paths simultaneously — the `PositionManager` directly, a `V4UtilsRouter` automation service (role `AUTOMATION_OPERATOR`), and the `UniversalRouter`. Decoding calldata would mean chasing every new router forever. All of those paths converge on the same on-chain events, so that is what Quiver observes:

| Venue | Event source | Owner attribution |
|---|---|---|
| Uniswap v4 | `PoolManager.ModifyLiquidity` | event `salt` = PositionManager `tokenId` → `ownerOf` |
| Uniswap v3 | `NPM.IncreaseLiquidity` / `DecreaseLiquidity` | indexed `tokenId` → `ownerOf` |
| both | ERC-721 `Transfer` | position moved or burned |

Position NFT transfers **to or from a contract** are classified as `custody_out` / `custody_in` and trigger nothing — the automation service used by typical targets temporarily custodies the NFT within a single transaction. Only transfers to an externally-owned address count as a disposal. Without this distinction a live bot would close positions that are still open.

Verified contract addresses on Robinhood Chain:

```
PoolManager (v4)     0x8366a39cc670b4001a1121b8f6a443a643e40951
PositionManager      0x58daec3116aae6d93017baaea7749052e8a04fa7
NPM (v3)             0x73991a25c818bf1f1128deaab1492d45638de0d3
UniversalRouter      0x8876789976decbfcbbbe364623c63652db8c0904
Permit2              0x000000000022d473030f116ddee9f6b43ac78ba3
USDG (6 decimals)    0x5fc5360d0400a0fd4f2af552add042d716f1d168
WETH9 (EIP-1967)     0x0bd7d308f8e1639fab988df18a8011f41eacad73
```

---

## Quick start

### Requirements

- **Node.js ≥ 22.5** — the persistence layer uses the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module (no native build step). Production runs Node 22. The `--no-warnings` flag in the start scripts silences the experimental-module notice.
- A wallet **dedicated to this bot** (never your main wallet) with USDG and a little ETH for gas — only required for LIVE mode.
- For the dashboard build: `npm` and a modern browser. For UI checks: Python 3 with Playwright.

### Install

```bash
git clone <repository-url> lpcopy
cd lpcopy
npm install                      # engine dependencies (ethers only)
cp config.example.json config.json
cp .env.example .env && chmod 600 .env   # secrets — see Secrets in .env
```

### Run

```bash
./lp                             # engine + dashboard at http://127.0.0.1:8799
```

On first launch the engine seeds any `targets` listed in `config.json`, opens the SQLite database at `data/lpcopy.db`, and begins scanning in **simulation mode**. Open the dashboard, add a target under **Targets**, and watch decisions appear under **Activity**.

> The pre-built React dashboard lives in `web/dist`. If it is absent, the server falls back to the legacy Tabler UI in `public/`. See [Dashboard](#dashboard) to build it.

---

## Command-line interface

`lp` is a thin wrapper around `node --no-warnings src/index.js`.

| Command | Description |
|---|---|
| `./lp` | Start the engine, HTTP API, dashboard, and Telegram bot. |
| `./lp scout <address> [blocks]` | Produce a candidate report for a wallet before copying it: live/closed positions, total value, unclaimed fees, in-range ratio, medians, and top pairs. Default window is `scout.blocks` (900 000 blocks ≈ 25 h). |
| `./lp add <address> ["label"]` | Register a target wallet. |
| `./lp list` | List registered targets and their enabled state. |

Environment variables:

| Variable | Purpose |
|---|---|
| `LPCOPY_CONFIG` | Path to the configuration file (default `./config.json`). |
| `LPCOPY_ENV` | Path to the secrets file (default `./.env`). |
| `LPCOPY_PRIVATE_KEY` | Signing key for LIVE mode; overrides `wallet.key_file`. |
| `LPCOPY_AUTH_TOKEN`, `LPCOPY_TELEGRAM_BOT_TOKEN`, `LPCOPY_NTFY_TOPIC` | Override `server.auth_token`, `telegram.bot_token`, `notify.ntfy_topic`. See [Secrets in `.env`](#secrets-in-env). |

A PID file (`data/lpcopy.pid`) enforces a **single running instance** — two processes sharing one database would overwrite each other's block cursor.

---

## Configuration

Start from `config.example.json`. Most settings are also editable at runtime from the dashboard's **Settings** and **Rules** pages, and changes there are written back to the file. Secrets (tokens, RPC API keys, optionally the wallet key) belong in [`.env`](#secrets-in-env) rather than in `config.json`; both files are git-ignored.

| Section | Key settings | Notes |
|---|---|---|
| `chain` | `endpoints[]`, `max_inflight`, `dns_over_https` | Each endpoint may declare `no_logs`, `max_log_blocks`, `archive`, `max_batch`. See [RPC layer](#rpc-layer). |
| `wallet` | `key_file` | Path to the private key (default `~/.lpcopy/key`). Must be mode `600`. `LPCOPY_PRIVATE_KEY` in `.env` takes precedence. |
| `mode` | `dry_run`, `paused` | `dry_run: true` = simulation. |
| `loop` | `poll_ms`, `max_block_span`, `sync_seconds`, `equity_seconds`, `stale_action_seconds` | Engine cadence; actions older than `stale_action_seconds` (default 300) are skipped in LIVE mode. |
| `gas` | `price_multiplier`, `priority_wei`, `max_gas_limit`, `native_reserve_wei` | ETH reserve is never spent on swaps. |
| `prices` | `eth_usd`, `auto_eth_price` | ETH/USD is derived on-chain from the deepest ETH/USDG pools when `auto_eth_price` is on (within 0.07 % of Blockscout). |
| `server` | `port`, `host`, `auth_token` | **Set an access token before exposing the dashboard beyond localhost** — `LPCOPY_AUTH_TOKEN` in `.env`, or `auth_token` here. An empty token disables the gate. |
| `db` | `path` | SQLite file, relative to the project root. |
| `scout` | `blocks` | Default scan window for `lp scout`. |
| `notify` | `ntfy_topic` | Optional ntfy.sh push notifications (or `LPCOPY_NTFY_TOPIC`). |
| `telegram` | `bot_token`, `chat_ids[]`, `notify{}` | Token preferably as `LPCOPY_TELEGRAM_BOT_TOKEN`. See [Telegram bot](#telegram-bot). |
| `targets[]` | `address`, `label`, `enabled`, `rules` | Seeded into the database on first run; per-target `rules` override the global set. |
| `rules` | `sizing`, `range`, `onesided`, `swap`, `exit`, `filters` | See [Copy rules](#copy-rules). |

### Secrets in `.env`

Secrets can live in a `.env` file next to `config.json` instead of inside it, so the config can be backed up or shared without them:

```bash
cp .env.example .env && chmod 600 .env
```

| Variable | Replaces |
|---|---|
| `LPCOPY_PRIVATE_KEY` | `wallet.key_file` — the key file is ignored and the dashboard's import/generate/remove wallet actions are disabled. |
| `LPCOPY_AUTH_TOKEN` | `server.auth_token` |
| `LPCOPY_TELEGRAM_BOT_TOKEN` | `telegram.bot_token` |
| `LPCOPY_NTFY_TOPIC` | `notify.ntfy_topic` |
| any name, e.g. `ALCHEMY_KEY` | referenced from RPC URLs or headers as `${ALCHEMY_KEY}`, e.g. `"url": "https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}"` |

- Precedence: variables already set in the environment > `.env` > `config.json`. Empty lines in `.env` have no effect.
- Values from `.env` are **never written back** to `config.json`; every config write goes through `src/env.js`, which restores the file's own values and the `${NAME}` templates before saving.
- The dashboard refuses to edit a field that `.env` controls (it would be overwritten on restart) and says which variable to change instead.
- Only variable **names** are logged at startup. The process refuses to start if `.env` holds `LPCOPY_PRIVATE_KEY` and is readable by other users.
- `.env` is git-ignored and not sent by `deploy.sh`; create it on each machine.

---

## Copy rules

All rules are editable globally and **per target** from the dashboard's **Rules** page or the Telegram menu.

### Sizing (`rules.sizing`)

| Mode | Behaviour |
|---|---|
| `mirror` | Identical liquidity to the target. |
| `pct` | A percentage of the target's liquidity. |
| `multiplier` | A multiple of the target's liquidity (may exceed 1). |
| `fixed_quote` | A fixed amount of capital per position (`fixed_quote_usd` or `fixed_quote_eth`). |

Every mode is bounded by `max_quote_per_position_usd`, `max_total_exposure_usd`, and `daily_budget_usd`. When a cap binds, the position is **scaled down proportionally**. Entries below `min_quote_usd` are skipped.

### Range (`rules.range`)

| Mode | Behaviour |
|---|---|
| `exact` | Same ticks as the target. |
| `recenter` | Same width, centred on the current price. |
| `scale` | Width multiplied by `scale`. |
| `width_pct` | Fixed ±`width_pct` % around the current price. |
| `full` | Full range. |

All ranges are aligned to the pool's `tickSpacing` (`align: nearest`), and `min_width_ticks` prevents degenerate ranges.

### One-sided positions (`rules.onesided`)

When the target's range lies entirely above or below the current price, the position holds a single token — effectively a limit order. `policy` may be `copy`, `skip`, or `shift` (move to the current price), with its own `max_quote_usd` cap.

### Auto-swap (`rules.swap`)

Pools on this chain are not uniformly USDG-quoted: of 5 901 new v4 pools observed over ~12 hours, **50 % were quoted in native ETH**, 26.8 % in USDG, and 4.3 % in WETH. Holding a single asset would block half of the opportunities, so entries proceed in two tiers:

1. **Treasury bridge** (`ensureQuoteAsset`) — guarantees you hold the pool's quote asset. `ETH ↔ WETH` via `deposit()` / `withdraw()` (1:1, no slippage); `USDG ↔ ETH` via the deepest ETH/USDG pool (a $1 000 swap moves that pool by ~0.74 bps).
2. **In-pool zap** — swaps part of the quote asset into the speculative token, then **re-computes the position size from actual balances** rather than planned figures.

Both tiers respect `max_slippage_bps` and `max_price_impact_bps`; a swap that would exceed either is rejected rather than forced.

> The bridge is *permitted* to route through hooked pools even though LP into hooked pools is filtered by default. A swap is atomic and protected by `amountOutMinimum` — the worst case is a revert. A hook on a pool where you *hold liquidity* can block `beforeRemoveLiquidity` and lock your capital, which is why the hook filter applies to LP only.

### Exit (`rules.exit`)

- `follow_target` / `follow_partial` — close (or partially close) when the target does.
- `out_of_range_minutes`, `stop_loss_pct`, `take_profit_pct`, `max_age_hours` — independent triggers (`0` = disabled).
- `sell_max_loss_bps` — bound on route loss when liquidating leftover memecoins. A leftover the route refuses is never dropped: it is re-quoted every `leftover_retry_sec` seconds (default 5, one Kyber quote per token per tick) and sold the moment it clears the bound. A loud alert (red banner + alarm on the dashboard, 🚨 Telegram card) fires on the first refusal and every 6 h it stays stuck.

  **Leftovers in the books.** A closed position's `out_quote` first carries the leftover at the pool price of the close (`left_token` / `left_amount` / `left_quote` on the row). When the leftover is sold — by the retry queue or from the Swap page — the sale's actual proceeds replace that estimate (FIFO across positions holding the same token), so realised PnL is what really came back, not a mid-price guess. Until it sells, equity values the leftover at the current pool price (`summary.leftoverUsd`, shown on the Overview composition and Telegram summary), and the difference to the close estimate counts as unrealised PnL. Tokens that leave the wallet outside the bot are treated as sold at the current price. This removed a $150 "dip then jump" in the equity curve around every close that returned memecoins, and turned one position recorded as −$52 into the +$15 it actually made.

### Filters (`rules.filters`)

`allow_hooks`, `quote_whitelist`, `token_whitelist` / `token_blacklist`, `min_pool_age_minutes`, `min_target_quote_usd`, `max_open_positions`, `cooldown_seconds` (per pool), `venues` (`v4`, `v3`), and `max_fee_bps` (pools with 35 %, 88 %, and even 99 % fees exist on this chain).

---

## Going live

1. **Store a dedicated private key** — never your main wallet:
   ```bash
   mkdir -p ~/.lpcopy
   echo "0xYOUR_PRIVATE_KEY" > ~/.lpcopy/key
   chmod 600 ~/.lpcopy/key
   ```
   The bot refuses to use a key file (or a `.env` holding `LPCOPY_PRIVATE_KEY`) whose permissions are more permissive than `600`. The key file lives outside the project directory, which is why it remains the recommended place.
2. **Fund the wallet** with USDG and a small amount of ETH for gas.
3. **Enable LIVE** — flip the badge in the dashboard header (or set `mode.dry_run: false` in `config.json`).

The first transaction involving each token incurs two one-time approvals (`ERC20 → Permit2`, then `Permit2 → PositionManager`).

Safety rails that apply in LIVE mode:

- Actions older than `loop.stale_action_seconds` (default 300 s) discovered after downtime are **skipped, never executed** — a stale LP signal is not a signal.
- Position-size caps, exposure caps, cooldowns, and filters are re-evaluated **immediately before** every transaction is built.
- Manual LP and swap plans are **never executed as submitted**; the server rebuilds the plan from the same inputs at the current price so every check runs again.
- **One exit per position at a time.** While a close is waiting for its receipt (up to 90 s), auto-exit triggers, the exit reconciler, and repeated clicks cannot send a second burn that would revert and waste gas. A receipt timeout is reported as *not confirmed yet*, not as a failure.

---

## Dashboard

**Stack:** Vite · React 19 · HeroUI v3 · Tailwind v4 · lucide-react · recharts. Source in `web/`, production build in `web/dist`, served by `src/server.js`. Pages are code-split with `React.lazy` (≈ 79 KB gzip initial load).

```bash
cd web
npm install          # once
npx vite             # dev server; /api is proxied to 127.0.0.1:8799
npx vite build       # production build (deploy.sh does this automatically)
```

### Pages

| Page | Contents |
|---|---|
| **Overview** | Portfolio value and growth chart, PnL per period, win rate and track record, daily PnL calendar, results per source (target or manual), block lag, skip reasons, RPC health. |
| **Positions** | Per-position value, fees (collected + unclaimed), PnL, IL, price range with distance-to-edge, age. Closing shows a pending toast until the receipt arrives, then the amount received and realised PnL. Click a pair for the **detail page**: pool candlestick chart with the position's range and entry/exit markers (GeckoTerminal), DexScreener embed, market stats, and position composition. |
| **Activity** | Target actions and the engine's decision for each, with the reason — paginated. |
| **Targets** | Add, enable/disable, rename, remove, per-target rule overrides, and research shortcuts. |
| **Rules** | All six rule groups, globally or per target. |
| **Manual LP** | Three-step flow (pool → amount → range) with a live-recomputing preview. Pool picker is searchable and can discover pools directly from a token address via the v4 `Initialize` event (both currencies are indexed). |
| **Swap** | Two-box swap card via Kyber, with quoted route cost and a hard stop on routes that lose more than the configured bound. |
| **Wallet** | Wallet research — see [Wallet research](#wallet-research). |
| **Scout** | The `lp scout` report, in the browser. |
| **Settings** | LIVE/simulation, cadence, wallet, RPC endpoints (test & add), gas, engine, notifications, Telegram, dashboard token. Fields controlled by `.env` are shown read-only with the variable to change. |

### Target alerts

The bell in the header polls `/api/feed` and raises a toast — plus an optional two-tone sound and a desktop notification while the tab is in the background — whenever a target wallet opens or adds to an LP position, together with what the bot decided (copied, simulated, skipped and why). Preferences are per browser (`localStorage`): a desk laptop may beep, a phone need not. Opening the dashboard never replays history, and actions backfilled after downtime are filtered by age.

### Internationalisation

A language switcher sits at the foot of the sidebar; the choice is stored in the browser and defaults to the system locale. Numbers and dates follow the locale (`$0,00` / `59.451.560` in Indonesian, `$0.00` / `59,451,416` in English).

The dictionary (`web/src/i18n.jsx`) uses **Indonesian text as the key**, so a missing translation renders a correct Indonesian sentence rather than a raw key. Two checks keep it honest:

```bash
cd web && python3 check-keys.py    # every t('…') in the code has a dictionary entry
cd web && python3 audit-i18n.py    # render each page in both languages; flag identical text
```

### Caching

Hashed Vite assets under `/assets/*` are served `private, immutable` (cached by the browser, not by Cloudflare — the dashboard sits behind a token gate). `index.html` is always `no-store`.

---

## Telegram bot

Everything in the dashboard is also available from a Telegram chat. The bot **contains no business logic of its own**: every button calls the exact same internal API routes the browser uses (`server.api`), so validation and safety rails live in one place. If the dashboard rejects something, the bot rejects it too.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. **Dashboard → Settings → Telegram** → paste the token → **Save**. The bot starts listening immediately, without a process restart. (Alternatively, set `LPCOPY_TELEGRAM_BOT_TOKEN` in `.env` and restart — the dashboard then shows the token as managed by `.env`.)
3. **Generate a pairing code** in the dashboard and send `/start <CODE>` to the bot. Codes are single-use and expire after 15 minutes.

If no chat is paired yet, the bot prints its own pairing code to the log on startup, so pairing over SSH alone is possible.

Tokens can be replaced at any time while the bot is running: the previous listener is torn down first (generation counter + cancellation of the in-flight long-poll) so two loops never contend for the same update queue. A token rejected by Telegram is reported back to the dashboard rather than silently ignored.

### Menu

| | |
|---|---|
| 📊 Summary | portfolio value, PnL with 24 h change, one-line engine health (paused / lagging / sync stalled / RPC cooling), open positions, track record, per-target results, copy counters |
| 💼 Positions | list with value, fees, PnL, IL, range, age; close positions; open detail pages |
| 🎯 Targets | list, toggle, rename, remove, add, per-target rules, research |
| 📜 Activity | recent target actions and bot decisions, paginated |
| ⚙️ Rules | all six rule groups, every field editable |
| 🔧 Settings | LIVE/simulation, cadence, wallet, RPC (test & add), gas, engine, notifications, chats, dashboard token |
| ➕ Manual LP | pick pool, amount, range — preview first |
| 🔁 Swap | Kyber swap with quote and route cost before confirmation |
| 🔎 Research · 🔭 Scout | scan any wallet; results delivered to the chat |
| 🧹 Leftovers | queue of residual memecoins: retry sale or drop from queue |
| 📝 Logs · 🧾 Transactions · 💵 Balance | |

Slash commands: `/summary` `/positions` `/targets` `/activity` `/rules` `/settings` `/balance` `/leftovers` `/logs` `/tx` `/scout <address>` `/research <address>` `/pause` `/resume` `/help`.

### Notifications

Every event that moves funds arrives as a formatted card with action buttons:

| Card | Contents |
|---|---|
| 🟢 **LP copied** / ➕ **LP added** | pair, venue, fee tier, capital, price range with the current price marked, target and mirrored NFT, reason, swaps performed, tx |
| 🔴 **LP closed** / ➖ **LP reduced** | realised PnL and %, proceeds vs. cost, holding time, reason, leftover sale, tx |
| 🛡 **Auto-exit** | the same, for stop-loss, take-profit, out-of-range, max-age, and missed-exit reconciliation |
| 🧹 **Leftover sold** | amount received, token value, route loss, DEX, attempt number |

The engine passes structured detail with each notification and the bot reads the numbers back through the same API as the dashboard, so a card never disagrees with the screens. If a card cannot be built, the plain message is sent instead. Errors and warnings arrive as `⛔ Error · <context>` / `⚠️ Warning · <context>` with the detail underneath. Each category can be toggled under **Notifications**; the outbound queue is rate-limited so a log flood never trips Telegram's send limits. ntfy.sh keeps receiving plain text.

### Deliberately not available in Telegram

- **Importing or exporting private keys.** Chat history is stored on Telegram's servers; change wallets from the dashboard.
- **Editing RPC URLs that embed API keys** (adding plain endpoints is fine).

A paired chat can do **everything** the dashboard can. Treat `telegram.chat_ids` as the list of people who hold the dashboard key — review it periodically under **Settings → Telegram chats**.

---

## Wallet research

Open any wallet in the **Wallet** page to see total profit, win rate, fees, average capital, a daily profit calendar, open positions, and the complete position history. Results are persisted in SQLite (`wallets`, `wpositions`, `wevents`, `wprices`), so reopening a wallet costs no RPC calls. The ⟳ button rescans; **Full history** scans from genesis (~10 minutes for ~150 positions, once).

Validation against LP Agent for a reference wallet (full history): closed positions 145 vs 146, win rate 81.55 % vs 82.39 %, fees $2 620.46 vs $2.62k, average capital $591.91 vs $589.08.

### Uniswap v4 methodology

Capital and proceeds are **not** derived from ERC-20 `Transfer` events. Automated rebalances close and reopen positions within a single `unlock`, and `PoolManager`'s flash accounting nets the amounts — producing **no transfers at all**. Instead, the engine reads pool and position state **at the block before each event** through an archive node:

- principal — from `L`, the tick range, and `sqrtPriceX96` at that block
- fees — `L × (feeGrowthInside − feeGrowthInsideLast) / 2¹²⁸` at that block

Both are exact; fees computed this way match `tokens out − principal` to the last digit on non-netted transactions. Fee-claim events (zero liquidity delta) are included.

Only `rpc.ordofi.network` serves archive state (`archive: true`). Without it the engine degrades gracefully: price from the nearest `Swap` event plus amounts from transfers, with the guard that principal can never exceed what was received.

### Uniswap v3 methodology

v3 has its own path (`src/walletv3.js`) and is cheaper than v4: `NonfungiblePositionManager` emits token amounts directly and separates principal from fees —

```
IncreaseLiquidity(tokenId indexed, liquidity, amount0, amount1)   capital in
DecreaseLiquidity(tokenId indexed, liquidity, amount0, amount1)   PRINCIPAL out
Collect(tokenId indexed, recipient, amount0, amount1)             actually received
```

so **fees = Collect − Decrease**, tracked cumulatively so fee-only claims are captured in full.

Each event is valued at the pool price **at its own block**, sourced from `Swap` events rather than the archive node — deliberately the opposite of the v4 path. On one real position the archive returned a price 4.7× off from three consecutive `Swap` events around it, then later refused the block entirely (`missing trie node`); the same wallet's PnL swung from **−$19k to +$231k** depending on the source. Event logs are part of the block and cannot drift; the archive is used only when no `Swap` exists at all.

Positions whose NFTs have been **burned** are recovered from the pool's `Mint` event in the opening transaction (the log address *is* the pool; the ticks are in the topics). On a test wallet this raised the reconstructed history from 24 to **60** positions — exactly the number of NFTs it ever held.

---

## RPC layer

`eth_getLogs` and `eth_call` are not served equally well by the same endpoint, so `src/rpc.js` routes **per method** and spreads load to the least-busy eligible endpoint — hammering a single endpoint is exactly what triggers `429`.

| Endpoint | `eth_call` | `eth_getLogs` | Notes |
|---|---|---|---|
| `robinhood-rpc.publicnode.com` | ~93 ms | **refused** | fastest; `getLogs` beyond ~10 recent blocks returns *"Archive requests require a personal token"* |
| `rpc.mainnet.chain.robinhood.com` | ~250 ms | yes | official; returns `429` under burst load |
| `rpc.ordofi.network` | ~232 ms | yes (slow, ~4.5 s) | only archive node; `getLogs` limited to 3 000-block ranges |

`config.example.json` ships with these three public endpoints. Keyed providers (e.g. Alchemy) can be added with the key kept in `.env`: `"url": "https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}"`. The dashboard masks key-bearing URLs and the Telegram bot will not edit them.

Endpoints evaluated and rejected: `robinhood.drpc.org` (free tier answers only `eth_chainId`), `rpc.arrowrpc.com` (down), `robinhoodchain.blockscout.com/api/eth-rpc` (behind Cloudflare).

Design decisions:

- **DNS-over-HTTPS with IP pinning.** `rpc.mainnet.chain.robinhood.com` is hijacked by at least one Indonesian ISP to a captive portal, breaking TLS. The pool resolves via 1.1.1.1 DoH and pins the IP while preserving the original SNI.
- **Parallel `getLogs`, not a JSON-RPC batch.** If one sub-query in a batch is refused upstream, the whole cycle fails with no chance of failover. Three separate calls each fail over independently.
- **Recursive range splitting** (`getLogsSafe`). A silently timed-out `getLogs` once made `scout` report "no positions" for a wallet with 50+. Failures now split the range recursively and throw if they persist.
- **Lowest-head block cursor** (`safeHead`). Endpoints disagree by 10–20 blocks. Advancing the cursor to the fastest endpoint's head while `getLogs` is served by a lagging one would lose the blocks in between permanently.

---

## Deployment

Production runs on a Singapore VPS under **pm2** as the `lpcopy` process (see `ecosystem.config.cjs`: auto-restart, 250 MB memory cap, timestamped logs in `logs/`). The dashboard is exposed through a Cloudflare tunnel and protected by `server.auth_token`.

```bash
./deploy.sh
```

builds the dashboard, rsyncs `src test public package.json README.md lp ecosystem.config.cjs deploy.sh .env.example` and `web/dist` to the server, installs production dependencies, and restarts pm2. It **deliberately excludes** `config.json` and `.env` (both live only on the server), `data/` (block cursor and positions — pushing it would rewind the cursor and re-evaluate old actions), and `logs/`.

Secrets on the server live in `~/lpcopy/.env` (mode `600`); `config.json` there refers to RPC keys as `${NAME}`. At startup the log lists which variables were loaded — names only, never values:

```
.env dimuat: LPCOPY_AUTH_TOKEN, LPCOPY_TELEGRAM_BOT_TOKEN, ALCHEMY_KEY
```

Day-to-day on the server:

```bash
pm2 status lpcopy
pm2 logs lpcopy --lines 50
pm2 restart lpcopy
pm2 stop lpcopy
```

---

## Testing

All suites run against the real engine with the chain, transaction sending, and third-party APIs mocked — they never touch funds and need no network.

| Command | Coverage |
|---|---|
| `node test/edge.js` | **28** adversarial scenarios through policy, engine, and watcher: target adds to an already-mirrored position, partial withdrawals, NFT moves, custody by automation contracts, hooked pools, every cap (count, exposure, cooldown, minimums), one-sided positions, insufficient balance, duplicate actions, leftover-memecoin sale queue. |
| `node test/riset.js` | **11** tests for v3 wallet research: fee/principal separation, fee-only claims, NFTs transferred and returned, event-block pricing vs estimate flagging, and two regressions for the "v3-only wallet appears empty" bug. |
| `node test/telegram.js` | **99** tests with a mocked Telegram API but the real server route table. The core test is a crawler that presses **every** button reachable from the main menu and asserts no throw, no empty screen, and no `undefined`/`NaN` leaking into text. Also verifies the rules menu and `policy.js` agree in both directions, and renders every notification card and the Summary screen. |
| `node test/env.js` | **10** tests for `.env`: parsing, precedence, refusing a world-readable private key, `${NAME}` RPC templates, secrets never written back to `config.json` (including after dashboard edits), and settings routes locking `.env`-managed fields. |
| `node test/market.js` | **8** tests for DexScreener/GeckoTerminal caching and entry-price derivation. |
| `node test/icons.js` | **8** tests for token logo fetching, validation, and caching. |
| `node test/rentang.js` | **5** tests for manual-LP range → tick conversion in both quote orientations. |
| `cd web && python3 check-ui.py` | Drives Manual LP and Swap in Chromium and WebKit, desktop and mobile, both languages, simulation and LIVE, good and lossy routes — with API responses stubbed so success paths render. |

Run everything:

```bash
| `node test/sisa.js` | **9** tests for leftover bookkeeping on the bot's own positions: close records the leftover and its close-price estimate, sales (USDG, native ETH, manual FIFO, oversized) replace the estimate with real proceeds, equity values unsold leftovers at the current pool price (close price when unreadable), and tokens gone from the wallet are realised at the current price. |
for f in test/*.js; do node --no-warnings "$f"; done
```

For dry-running **real** target transactions without broadcasting, see the commit *"dry-run cermin Bang GE"*: the bot runs unmodified, but each `exec.send` is intercepted and executed in sequence via `eth_simulateV1` on a pinned block, so swap → mint → burn → leftover sale see each other's state changes.

---

## Project structure

```
lp                    CLI entry point (zsh wrapper)
config.example.json   configuration template
.env.example          secrets template (copy to .env, chmod 600)
ecosystem.config.cjs  pm2 process definition
deploy.sh             build + rsync + pm2 restart

src/
  index.js            bootstrap: .env, CLI dispatch, single-instance lock, timers
  env.js              .env loading, config overrides, secret-free config writes
  engine.js           orchestrator
  watcher.js          target LP action detection (events)
  policy.js           rule engine: sizing, range, filters
  executor.js         transaction builder & sender (v4 actions, Permit2)
  positions.js        position sync, PnL, IL, exit triggers
  manual.js           manual LP & swap (same execution path as the copier)
  kyber.js            Kyber aggregator client
  fees.js             exact unclaimed v4 fees from PoolManager storage
  pools.js            pool state, token metadata, ETH price, pool age
  v3math.js           tick / liquidity mathematics (tested against Uniswap vectors)
  chain.js            contract addresses, ABIs, Actions/Commands constants
  rpc.js              RPC pool: method routing, DoH pinning, failover, queueing
  db.js               SQLite schema (node:sqlite)
  wallet.js           v4 wallet research
  walletv3.js         v3 wallet research
  scout.js            candidate wallet report
  market.js           DexScreener / GeckoTerminal market data (cached)
  icons.js            token logo resolution and caching
  settings.js         runtime-editable settings
  server.js           HTTP API + static server; server.api is the single door
  telegram.js         Telegram bot (thin client over server.api)

web/                  React dashboard source (Vite + HeroUI v3 + Tailwind v4)
  src/pages/          Overview · Positions · PositionDetail · Activity · Targets
                      Rules · ManualLp · Swap · Wallet · Scout · Settings
  src/i18n.jsx        ID/EN dictionary
  check-ui.py         Playwright UI checks
  check-keys.py       i18n key coverage
  audit-i18n.py       i18n render audit
  dist/               production build (git-ignored)

public/               legacy Tabler UI — fallback when web/dist is absent
test/                 edge · env · riset · telegram · market · icons · rentang
data/                 SQLite database, PID file, icon cache (git-ignored)
logs/                 engine and pm2 logs (git-ignored)
```

---

## Engineering notes

Findings that were expensive to obtain and are worth knowing before touching the code:

- **v4 action encodings were matched against real on-chain calldata**, not memory: `0x020d` = `MINT_POSITION + SETTLE_PAIR`, `0x020d14` adds `SWEEP` for native ETH, `0x0111` = `DECREASE + TAKE_PAIR`, `0x060c0f` = `SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL`. The swap encoder reproduces a real swap **byte-for-byte**; the mint encoder passes `eth_estimateGas` from a real LP's address.
- **`PoolManager` storage layout**: `_pools` mapping at slot 6; within a pool, `+1/+2` feeGrowthGlobal, `+3` liquidity, `+4` ticks, `+6` positions. Verified because liquidity read from storage equals `getPositionLiquidity(tokenId)`. This is what makes unclaimed fees exact.
- **`feeGrowthAbove` is easy to invert.** When `tickCurrent < tickUpper` the value is `upper.feeGrowthOutside`, *not* `global − outside`. The wrong direction wraps to ~10⁴⁸.
- **Dynamic-fee flag.** Uniswap v4 uses the top bit of the `uint24` fee (`0x800000`) to mean "fee set by hook at execution time". Unhandled, such pools display as *"fee 838.86 %"*. They are shown as *dynamic* and rejected for manual LP.
- **WETH9 on this chain is an EIP-1967 proxy** (implementation `0xc6b8…947e`). Selector scans of the proxy bytecode fail; check the implementation.
- **Node ≥ 20 calls `lookup` with `{ all: true }`**, so the custom DNS callback must return an array — otherwise `ERR_INVALID_IP_ADDRESS: undefined`.
- **Token logos** — Blockscout returns `403` to servers (TLS fingerprinting), but its image CDN does not. Since every pair contains one of USDG / WETH / ETH, those three logos are vendored in `web/public/tokens/` and served locally; memecoins get a deterministic address-derived identicon.
- **Range display direction** depends on `quoteSide`: when the quote asset is `token0`, the speculative token's price is the *inverse* of the tick, so `tickLower` yields the *highest* price. Verified by comparing two equivalent pool orientations.
- **Telegram layout**: proportional fonts make whitespace alignment unreliable, so every numeric table is wrapped in `<pre>` with column widths measured *before* HTML escaping; emoji never enter `<pre>`. A test enforces this.

---

## Known limitations

- **Hooked v4 pools are not mirrored by default** (`filters.allow_hooks: false`). Hooks can veto withdrawals. Enable only if you understand the risk.
- **LPs created through hook contracts** (e.g. launchpad `DopplerHookInitializer`) have no NFT, so ownership cannot be attributed. Their count is surfaced as `overview.unsupportedSenders` so you know what was missed.
- **Swap and mint are two separate transactions.** `UniversalRouter` on this chain supports `V4_POSITION_MANAGER_CALL` (`0x14`), so an atomic single-transaction path is possible but not yet implemented.
- **v3 unclaimed fees** are read by simulating `collect` via `eth_call`, which requires a funded wallet for the simulation to succeed.
- **`scout` only sees its scan window.** Positions opened before the window are not counted, and the report says so.
- **Position valuation uses the current price** in the copier (an archive node is only used by the research module). For copying this is correct — you are entering now, not then.

---

## Security

- `.env`, `config.json`, `data/`, `logs/`, and any `key*` / `*.mnemonic` files are git-ignored. **Never commit them.** Only `.env.example` is tracked.
- Keep secrets in `.env`: values from it are never written to `config.json` and never logged. Bot tokens and RPC keys are masked before they reach the browser.
- The private key is read from a file (or `.env`) that must be mode `600`; the process refuses otherwise. Use a wallet dedicated to this bot.
- The dashboard can enable LIVE mode and close positions. **Set an access token (`LPCOPY_AUTH_TOKEN`) before binding to anything other than `127.0.0.1`.** An empty token disables authentication entirely.
- A paired Telegram chat has the same authority as the dashboard. Audit `telegram.chat_ids` regularly.
- Key import/export and API-key-bearing RPC URLs are intentionally unavailable through Telegram.

---

<p align="center"><sub>Quiver is a private project (<code>"private": true</code>); no open-source licence is granted.</sub></p>
