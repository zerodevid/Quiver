<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logo-white.svg" />
    <img src="public/logo.svg" alt="Quiver" width="220" />
  </picture>
</p>

<p align="center">
  <strong>Liquidity position copying for Robinhood Chain and BNB Smart Chain</strong><br />
  Monitor target wallets, manage Uniswap v3/v4 (and PancakeSwap v3) positions, and track results<br />
  through a bilingual dashboard and Telegram bot.
</p>

<p align="center">
  <img src="public/robinhood-chain.jpg" alt="" width="20" height="20" align="absmiddle" />
  <span>Robinhood Chain</span>
  &nbsp;·&nbsp;
  <img src="public/bnb-chain.png" alt="" width="20" height="20" align="absmiddle" />
  <span>BNB Smart Chain</span>
</p>

<p align="center">
  Node.js · SQLite · ethers · React · Vite
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#dashboard-and-telegram">Dashboard</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#security-and-access">Security</a> ·
  <a href="README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="docs/quiver-demo-en.mp4">
    <img src="docs/demo-poster.jpg" alt="Quiver demo video — 3:07, 1080p" width="800" />
  </a><br />
  <sub>Narrated walkthrough of the dashboard (3:07). Wallet addresses, target names and position IDs are censored; all amounts are scaled by an undisclosed factor. <a href="docs/quiver-demo-en.srt">Subtitles</a></sub>
</p>

## Overview

Quiver is a self-hosted application that watches target wallets on Robinhood Chain and BNB Smart Chain and copies supported Uniswap v3, Uniswap v4 and PancakeSwap v3 liquidity actions according to configurable rules. It also supports manual LP management, swaps, wallet and pool research, and PnL reporting.

The example configuration starts in **simulation mode**, binds the dashboard to `127.0.0.1`, and contains no target wallets. Review simulated decisions before enabling live execution. Live mode can sign transactions and move funds from the configured wallet.

## Capabilities

| Area | Features |
| --- | --- |
| Copy execution | Event-based detection, target-specific rules, position sizing, range selection, and token/pool filters. |
| Position management | Partial and full exits, fee claims, exit triggers, and automatic fee harvesting (v3/v4 compounding, or claiming with the memecoin side sold into the quote asset). |
| Monitoring | One card per pool with live candles, every position's range as a clickable band, whole-pool PnL, and distance to each exit trigger. |
| Manual trading | LP creation and swaps with previews and confirmation. |
| Portfolio reporting | Position history, collected and unclaimed fees, realised PnL, held-token valuation, and equity charts. |
| Wallet research | Historical v3/v4 position reconstruction, performance summaries, and daily PnL calendars. |
| Pool and token research | Pool health, holder distribution, price depth and target-exit scenarios, DexScreener/GeckoTerminal/GMGN data, and trade-terminal links. |
| Learning | A built-in bilingual concentrated-liquidity course with a range simulator and glossary. |
| Sharing | PNG cards for individual positions, total PnL, and daily results, available through the dashboard and Telegram. |
| Controls | Indonesian and English interfaces, chain switcher, target alerts, activity logs, and runtime settings. |
| Infrastructure | SQLite persistence, multiple RPC endpoints, failover, log-range splitting, and a single-instance process lock. |

## Quick start

### Requirements

- **Node.js 22.12 or later.** The engine uses `node:sqlite`, and the dashboard build (Vite 8) requires Node 20.19+ or 22.12+.
- npm and JSON-RPC endpoints for Robinhood Chain (and BNB Smart Chain, if enabled).
- A modern browser for the dashboard.
- A dedicated signing wallet and transaction funding only when using live execution.

The optional `./lp` and `deploy.sh` wrappers require **zsh**. The Node commands below work without those wrappers.

### Install and build

From a checkout of this repository:

```sh
npm ci
npm ci --prefix web
cp config.example.json config.json
cp .env.example .env
chmod 600 .env
npm run build --prefix web
```

Edit `config.json` for non-secret settings and `.env` for credentials. Keep `mode.dry_run` set to `true` during initial setup.

### Start

```sh
npm start
```

Open [localhost:8799](http://127.0.0.1:8799). Add a wallet under **Targets**, review **Rules**, and inspect the resulting decisions under **Activity**.

The server serves the built React dashboard from `web/dist/`. Without that build, it falls back to the legacy interface in `public/`. The build output is not tracked in Git.

## Configuration

Use [config.example.json](config.example.json) as the starting point. Supported settings can also be edited from the dashboard; those changes are persisted to the configuration file. Target records are stored in SQLite, with `chains.<name>.targets[]` used to seed entries at startup.

One process runs every enabled chain at once. Global sections apply to all chains; everything that differs per chain lives under `chains.<name>` (`robinhood`, `bsc`). A legacy single-chain `config.json` is normalised on start-up (its top-level sections move to `chains.robinhood`) and a `chains.bsc` block is seeded in simulation mode with no targets.

| Section | Scope | Purpose |
| --- | --- | --- |
| `wallet` | global | Signing-key file location; overridden by `LPCOPY_PRIVATE_KEY` when set. The same key (and address) is used on every chain. |
| `server`, `db`, `telegram`, `notify`, `gmgn` | global | Dashboard binding and authentication, SQLite location, Telegram and ntfy notifications, GMGN API key. |
| `chains.<name>.enabled` | per chain | Start the engine for this chain. |
| `chains.<name>.chain` | per chain | RPC endpoints, concurrency, archive support, and log-query limits. |
| `chains.<name>.targets`, `rules` | per chain | Seed targets and copy rules (sizing, ranges, swaps, exits, filters). `filters.venues` may include `pancakev3` on BSC. |
| `chains.<name>.mode` | per chain | Simulation/live execution and pause state — BSC can stay in simulation while Robinhood is live. |
| `chains.<name>.loop`, `gas`, `prices`, `scout`, `risk` | per chain | Polling and scan windows, gas pricing and native reserve, native-token valuation, research window, daily drawdown breaker. |

Chain profiles (chain id, contract addresses, quote assets, venues, block time) live in [src/networks.js](src/networks.js). `node src/verify-chain.js bsc` checks a profile against the live chain: chain id, bytecode of every contract, `NonfungiblePositionManager.factory()` for each v3 venue, `PositionManager.poolManager()`, and the quote tokens' symbol and decimals.

On BNB Smart Chain the bot follows Uniswap v4, Uniswap v3, and PancakeSwap v3 (venue `pancakev3`). BNB/USD is read from the deepest PancakeSwap v3 USDT/WBNB pools; USDT (18 decimals) takes the stablecoin role that USDG has on Robinhood Chain. The seeded RPC list uses public endpoints that serve `eth_getLogs` up to 5000 blocks; add an Alchemy BNB endpoint from the Settings page once the network is enabled for your app.

### Credentials and environment variables

[.env.example](.env.example) lists the supported credential variables. Non-empty process environment values take precedence over `.env`, which takes precedence over configuration values.

| Variable | Purpose |
| --- | --- |
| `LPCOPY_PRIVATE_KEY` | Signing key; overrides `wallet.key_file`. |
| `LPCOPY_AUTH_TOKEN` | Dashboard access token. |
| `LPCOPY_TELEGRAM_BOT_TOKEN` | Telegram bot token. |
| `LPCOPY_NTFY_TOPIC` | Optional ntfy notification topic. |
| `LPCOPY_GMGN_API_KEY` | Optional GMGN OpenAPI key for GMGN candles and wallet/token data; without it only GeckoTerminal is used. |
| `BLOCKSCOUT_API_KEY` | Optional Blockscout Pro key for holder scans when no Alchemy endpoint is configured. |
| `LPCOPY_CONFIG` | Alternative configuration file path. |
| `LPCOPY_ENV` | Alternative `.env` file path. |
| `LPCOPY_DASHBOARD_URL` | Optional URL printed by the deployment helper. |

RPC URLs and headers can reference any environment variable with `${NAME}` placeholders, for example an `ALCHEMY_KEY` defined in `.env`:

```json
{
  "url": "https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}"
}
```

Environment-managed fields are read-only in the dashboard. Configuration writes preserve the underlying file values and placeholders instead of writing resolved credentials back to disk. This does not make an existing `config.json` safe to share: review it for inline credentials and private operational details first.

### Copy rules

Global rules can be overridden for individual targets.

| Group | Options |
| --- | --- |
| Sizing | `mirror`, `pct`, `multiplier`, or `fixed_quote`, with minimum entry, per-position, total-exposure, and daily-budget limits. |
| Range | `exact`, `recenter`, `scale`, `width_pct`, or `full`, aligned to pool tick spacing. |
| One-sided positions | Copy, skip, or shift the range, with a separate size cap. |
| Swaps | Enable automatic swaps and configure slippage and price-impact limits. |
| Exits | Follow target withdrawals, including partial exits, or use age, out-of-range, stop-loss, and take-profit triggers. |
| Filters | Allowed venues and quote assets, token lists, hook policy, pool age, position count, and cooldown. |

Consult `src/policy.js` for rule defaults and evaluation. Hooks are disabled for copied LP entries in the example configuration.

## Dashboard and Telegram

The dashboard shows one chain at a time; the switcher under the logo (or `?chain=bsc` in the URL) picks it and every page, setting, and action then applies to that chain. The Telegram bot has the same switcher (`/chain`), remembers the choice per chat, and labels notifications with the chain they came from.

| Group | Pages |
| --- | --- |
| Monitoring | **Overview**, **Monitor**, **Positions**, **Activity** |
| Copy | **Targets**, **Rules** |
| Actions | **Manual LP**, **Swap** |
| Research | **Wallet**, **Learn LP** |
| System | **Settings** |

Position, pool and token detail pages open from the tables and from the global search. Language preferences are stored per browser; Telegram language preferences are stored per chat.

**Settings → Display** adds a second currency beside every dollar figure on the dashboard (`$1,983.22  ≈ Rp 35.4M`). Dollars remain the primary unit: pools, token prices, copy budgets and every PnL calculation stay in USD, and the second currency is display-only annotation, written small and grey. The server fetches the rate from open exchange-rate sources (open.er-api.com, falling back to frankfurter.app), refreshes it every six hours, caches the last good rate across restarts, and serves it to the dashboard with the regular status poll. Choosing *None* removes the annotation entirely.

To connect Telegram:

1. Create a bot through BotFather and set `LPCOPY_TELEGRAM_BOT_TOKEN` in `.env`, then restart the application. Alternatively, configure the token through Settings if it is not environment-managed.
2. Generate a pairing code from the dashboard.
3. Send `/start <CODE>` to the bot. Pairing codes are single-use and expire after 15 minutes.

Paired chats can perform privileged actions, including changing execution mode and managing positions. Private-key import/export and editing RPC URLs containing credentials are excluded from Telegram controls.

## Execution and accounting

Quiver detects liquidity changes from pool and position-manager events rather than relying solely on router calldata. The watcher attributes supported position NFTs to target wallets and distinguishes custody transfers from disposal where supported.

The dashboard and Telegram use the same server API for operational actions. The executor handles transaction construction and submission; SQLite records positions, decisions, and accounting history.

Wallet research uses separate v3 and v4 reconstruction paths:

- **v4:** historical liquidity and fee-growth state where archive data is available, with fallback estimates when it is not.
- **v3:** liquidity and collection events to separate principal from fees, with historical pricing from available chain data.
- **After closing:** quote-asset proceeds and residual tokens are tracked separately. Held-token values can change until disposal; identifiable sales use their observed proceeds.

Displayed valuation depends on available RPC history, prices, token behaviour, and successful reconciliation. It should not be treated as a guaranteed liquidation value.

### Pool health and holder distribution

Pool detail shows explicit market/position warnings, a heuristic health status, holder count and top-address concentration. Missing, mismatched or stale data cannot yield a healthy status. Thresholds are visible in the panel; this is not a contract audit.

Holder scans reuse the configured Alchemy Robinhood endpoint without exposing its URL/key to the browser. The background scanner enumerates ERC-20 transfers, checks candidate balances and total supply at one fixed block, and only publishes a count when balances reconcile with supply. It excludes zero balances; counts refer to addresses, not distinct people. PoolManager, the viewed v3 pool and burn addresses are excluded from the concentration warning; other contracts remain included and are labelled.

One scan runs at a time, with bounded history, address counts and request timeouts. Results are cached for 15 minutes; subsequent successful scans read new transfers. Verified snapshots and discovery state are saved beside the configured database in `holders/`. An incomplete index, nonstandard token accounting, provider failure or scan limit is shown as unavailable rather than an estimated total. Restarts reuse the verified cache; absent or damaged caches are rebuilt. If no Alchemy endpoint is configured, Blockscout is used (optional `BLOCKSCOUT_API_KEY` for its Pro API).

Validation: `node test/pool-health.js`. Provider references: [Alchemy Transfers API](https://www.alchemy.com/docs/reference/transfers-api-quickstart) and [Blockscout holders API](https://docs.blockscout.com/api-reference/get-token-holders).

### Price depth and target-exit scenarios

Pool detail estimates gross quote-asset buying needed for +1%, +5%, +10% and the selected open position's break-even price. `/api/pool-depth` reads initialized ticks, current liquidity, NFT ownership/liquidity and tracked target token balances at one block, through configured RPC failover. Reads are bounded to ±14,000 ticks (128 bitmap words, 2,048 initialized ticks and 40 tracked NFTs), cached for 30 seconds; the UI rejects snapshots older than two minutes.

The piecewise concentrated-liquidity model compares our exit now, after tracked target LP withdrawals, and after those withdrawals plus an adjustable token sale. It revalues and removes our own LP before selling returned base tokens. Existing target wallet balances are optional; untracked LPs and unclaimed target LP fees are excluded. Principal proceeds exclude collected LP fees and gas. Swap loss includes modeled price impact and snapshot swap fees, measured against the price immediately before our sale; it is not a slippage tolerance or an executable quote. Hooks, liquidity gaps, missing positions/balances and depth limits produce unavailable results rather than partial-fill estimates. Dynamic fees, taxes, MEV, transaction ordering and alternative routes may change actual proceeds.

Math follows Uniswap's [concentrated-liquidity formulas](https://app.uniswap.org/whitepaper-v3.pdf) and [v4 storage layout](https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol). Checks: `node test/pool-depth.js`, `node test/liquidity-risk.js`, and `node --test web/src/breakeven.test.js`.

## Development

Run the backend and Vite in separate terminals:

```sh
npm start
```

```sh
npm run dev --prefix web
```

Vite proxies `/api` requests to `http://127.0.0.1:8799`. Use the Vite address printed in the terminal for frontend development.

### CLI

| Command | Purpose |
| --- | --- |
| `node --no-warnings src/index.js` | Start the application. |
| `node --no-warnings src/index.js scout <address> [blocks] [--chain=bsc]` | Research a wallet within a specified block window. |
| `node --no-warnings src/index.js add <address> "label" [--chain=bsc]` | Register a target (default chain: robinhood). |
| `node --no-warnings src/index.js list` | List targets on every chain. |
| `node --no-warnings src/verify-chain.js bsc [rpc-url]` | Verify a chain profile's contract addresses on-chain. |
| `npm run export-key -- <keystore.json>` | Offline: decrypt a keystore exported from the dashboard into a raw private key. |

With zsh installed, `./lp` accepts the same arguments as `src/index.js`. Do not run multiple engine instances against the same database.

### Verification

Run the JavaScript suites from the repository root, stopping on the first failure:

```sh
for file in test/*.js; do
  node --no-warnings "$file" || exit 1
done
npm run build --prefix web
```

The suites cover execution rules, wallet accounting, fee claims, fee harvesting (compounding and claim-and-sell), Telegram, share cards, environment handling, multi-chain configuration, and web security.

Optional frontend checks are in `web/check-ui.py`, `web/check-keys.py`, and `web/audit-i18n.py`. Review each script's setup requirements before running it; browser checks require Python Playwright and its browser binaries.

### Demo video

`demo/` renders a narrated walkthrough of the dashboard (1080p60 MP4 + SRT) with headless Chromium, ffmpeg and a local TTS model. Wallet addresses and target labels are replaced before they reach the browser, blurred, and audited during recording; every non-GET `/api` request is blocked, so recording cannot act on a live bot. See [`demo/README.md`](demo/README.md).

```sh
cd demo && npm install
export QTOKEN=…                    # dashboard access token; dashboard reachable at 127.0.0.1:20150 (or QBASE)
QLANG=en npm run voice && QLANG=en npm run studio && QLANG=en npm run record && QLANG=en npm run compose
```

## Deployment

Build the frontend, install production dependencies on the host, and run a single backend process. The repository includes a PM2 configuration; the process is named after the checkout directory, so several instances (`~/lpcopy`, `~/lpcopy2`, …) can coexist on one host, each with its own database:

```sh
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 status lpcopy
```

Create the host's own `config.json` and `.env` before starting it. Set dashboard authentication and serve remote access over HTTPS. Keep the backend bound to loopback when a local reverse proxy or tunnel provides access.

### Repository deployment helper

`deploy.sh` is tailored to the maintainer's SSH setup. Review its destination alias, remote path, and restart behaviour before using it in another environment. It requires zsh, SSH, rsync, and PM2 on the destination.

The helper builds the dashboard, synchronises application files and `web/dist/`, installs production dependencies, and restarts the PM2 process. It excludes `.env`, `config.json`, `data/`, and `logs/`. It deploys the working tree, so review uncommitted changes before running it.

Preserve and back up the database separately. Replacing it with a development copy can reset the scanner cursor and accounting history. When updating a live service, retain assets needed by already-open tabs or arrange deployment so HTML and its referenced bundles remain available together.

## Security and access

- Keep signing keys, access tokens, bot tokens, and RPC credentials out of Git. `.gitignore` excludes `.env`, `config.json`, runtime data, logs, and common key filenames; it does not remove secrets already committed.
- Use a dedicated signing wallet. Store its key in a protected file or `.env`, with permissions set to `600`. Enter secrets through an editor or secret-management workflow rather than shell commands that save them in history.
- Set `LPCOPY_AUTH_TOKEN` before allowing remote dashboard access. An empty effective authentication token disables the login gate.
- Treat paired Telegram chats as privileged operators and remove access when it is no longer needed.
- Review logs, database exports, screenshots, and share cards before publishing them. They can reveal wallet addresses, positions, balances, or pairing information.
- Use simulation mode to inspect behaviour before enabling live execution. Exposure limits and transaction checks reduce operational risk but do not guarantee profitable trades or successful exits.

## Limitations

- Supported ownership detection depends on the position and event model. Some hook-created positions without a supported NFT cannot be attributed to a target wallet.
- RPC rate limits, missing archive state, delayed indexing, and unavailable swap routes can delay actions or reduce research completeness.
- Swaps and LP creation can involve separate transactions. A successful swap does not guarantee that a subsequent mint succeeds.
- Hook and token behaviour can prevent swaps or withdrawals. Stop-loss and other exit triggers do not guarantee execution.
- Scout reports cover their configured scan window. Historical results can change when additional data is reconciled.

## Repository layout

```text
src/                   Backend, execution, research, API, and Telegram
  index.js             Application startup and CLI
  networks.js          Chain profiles (contracts, quote assets, venues)
  multichain.js        Per-chain configuration normalisation
  engine.js            Copy engine coordination
  watcher.js           Liquidity event detection
  policy.js            Copy rules and limits
  executor.js          Transaction construction and submission
  positions.js         Position synchronisation and accounting
  wallet.js            v4 wallet research
  walletv3.js          v3 wallet research
  proceeds.js          Post-close token proceeds
  holders.js           Token holder scans
  pool-depth.js        Price depth and target-exit model
  server.js            HTTP API and static serving
  telegram.js          Telegram bot
  share-card.js        SVG and PNG PnL cards
  env.js               Environment loading and configuration persistence
  verify-chain.js      Chain profile verification
  export-key.js        Offline keystore decryption
web/                   React dashboard and frontend checks
public/                Shared assets, fonts, and legacy dashboard
test/                  JavaScript regression suites
demo/                  Demo video pipeline (privacy-scrubbed recording, narration, composition)
docs/                  Demo video, poster, subtitles, and the Learn page brief
config.example.json    Non-secret configuration template
.env.example           Credential variable template
ecosystem.config.cjs   PM2 process configuration
deploy.sh              Maintainer deployment helper
lp                     zsh wrapper around src/index.js
README.id.md           Indonesian documentation (more detailed)
```

`data/`, `logs/`, `web/dist/`, and `demo/out/` are generated locally and excluded from Git.
