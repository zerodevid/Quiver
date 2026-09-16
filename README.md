<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logo-white.svg" />
    <img src="public/logo.svg" alt="Quiver" width="220" />
  </picture>
</p>

<p align="center">
  <strong>Liquidity position copying for Robinhood Chain</strong><br />
  Monitor target wallets, manage Uniswap v3/v4 positions, and track results<br />
  through a bilingual dashboard and Telegram bot.
</p>

<p align="center">
  <img src="public/robinhood-chain.jpg" alt="" width="20" height="20" align="absmiddle" />
  <span>Built on Robinhood Chain</span>
</p>

<p align="center">
  Node.js · SQLite · ethers · React · Vite
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#security-and-access">Security</a> ·
  <a href="README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="docs/quiver-demo-en.mp4">
    <img src="docs/demo-poster.jpg" alt="Quiver demo video — 3:06, 1080p" width="800" />
  </a><br />
  <sub>Narrated walkthrough of the dashboard (3:06). Wallet addresses and target names are censored. <a href="docs/quiver-demo-en.srt">Subtitles</a></sub>
</p>

## Overview

Quiver is a self-hosted application that watches target wallets on Robinhood Chain and copies supported Uniswap v3 and v4 liquidity actions according to configurable rules. It also supports manual LP management, swaps, wallet research, and PnL reporting.

The example configuration starts in **simulation mode**, binds the dashboard to `127.0.0.1`, and contains no target wallets. Review simulated decisions before enabling live execution. Live mode can sign transactions and move funds from the configured wallet.

## Capabilities

| Area | Features |
| --- | --- |
| Copy execution | Event-based detection, target-specific rules, position sizing, range selection, and token/pool filters. |
| Position management | Partial and full exits, fee claims, exit triggers, and optional v4 fee compounding. |
| Manual trading | LP creation and swaps with previews and confirmation. |
| Portfolio reporting | Position history, collected and unclaimed fees, realised PnL, held-token valuation, and equity charts. |
| Wallet research | Historical v3/v4 position reconstruction, performance summaries, and daily PnL calendars. |
| Sharing | PNG cards for individual positions, total PnL, and daily results, available through the dashboard and Telegram. |
| Controls | Indonesian and English interfaces, target alerts, activity logs, and runtime settings. |
| Infrastructure | SQLite persistence, multiple RPC endpoints, failover, log-range splitting, and a single-instance process lock. |

## Quick start

### Requirements

- **Node.js 22.12 or later** for the engine and dashboard build. The engine uses `node:sqlite`; the installed Vite version requires a newer Node release than the original SQLite minimum.
- npm and access to Robinhood Chain JSON-RPC endpoints.
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

Use [config.example.json](config.example.json) as the starting point. Supported settings can also be edited from the dashboard; those changes are persisted to the configuration file. Target records are stored in SQLite, with `targets[]` used to seed entries at startup.

| Section | Purpose |
| --- | --- |
| `chain` | RPC endpoints, concurrency, archive support, and log-query limits. |
| `wallet` | Signing-key file location; overridden by `LPCOPY_PRIVATE_KEY` when set. |
| `mode` | Simulation/live execution and pause state. |
| `loop` | Polling, synchronisation, and equity snapshot intervals. |
| `gas` | Gas pricing, gas limit, and native-token reserve. |
| `prices` | ETH valuation settings. |
| `server` | Bind address, port, and dashboard authentication. |
| `db` | SQLite database location. |
| `rules` | Sizing, ranges, swaps, exits, and filters. |
| `telegram`, `notify` | Telegram integration and optional ntfy notifications. |

### Credentials and environment variables

[.env.example](.env.example) lists the supported credential variables. Non-empty process environment values take precedence over `.env`, which takes precedence over configuration values.

| Variable | Purpose |
| --- | --- |
| `LPCOPY_PRIVATE_KEY` | Signing key; overrides `wallet.key_file`. |
| `LPCOPY_AUTH_TOKEN` | Dashboard access token. |
| `LPCOPY_TELEGRAM_BOT_TOKEN` | Telegram bot token. |
| `LPCOPY_NTFY_TOPIC` | Optional notification topic. |
| `LPCOPY_CONFIG` | Alternative configuration file path. |
| `LPCOPY_ENV` | Alternative `.env` file path. |
| `LPCOPY_DASHBOARD_URL` | Optional URL printed by the deployment helper. |

RPC URLs and headers can reference environment variables with `${NAME}` placeholders. For example:

```json
{
  "url": "https://rpc.example.com/v2/${RPC_API_KEY}"
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

The dashboard provides **Overview**, **Positions**, **Activity**, **Targets**, **Rules**, **Manual LP**, **Swap**, **Wallet**, and **Settings** views. Language preferences are stored per browser; Telegram language preferences are stored per chat.

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
| `node --no-warnings src/index.js scout <address> [blocks]` | Research a wallet within a specified block window. |
| `node --no-warnings src/index.js add <address> "label"` | Register a target. |
| `node --no-warnings src/index.js list` | List targets. |

With zsh installed, `./lp` accepts the same arguments. Do not run multiple engine instances against the same database.

### Verification

Run the JavaScript suites from the repository root, stopping on the first failure:

```sh
for file in test/*.js; do
  node --no-warnings "$file" || exit 1
done
npm run build --prefix web
```

The suites cover execution rules, wallet accounting, fee claims, compounding, Telegram, share cards, environment handling, and web security. Test results should come from the current checkout; this README does not maintain a static passing-test count.

Optional frontend checks are in `web/check-ui.py`, `web/check-keys.py`, and `web/audit-i18n.py`. Review each script's setup requirements before running it; browser checks require Python Playwright and its browser binaries.

### Demo video

`demo/` renders a narrated walkthrough of the dashboard (1080p60 MP4 + SRT) with headless
Chromium, ffmpeg and a local TTS model. Wallet addresses and target labels are replaced
before they reach the browser, blurred, and audited during recording; every non-GET
`/api` request is blocked, so recording cannot act on a live bot. See
[`demo/README.md`](demo/README.md).

```sh
cd demo && npm install
export QTOKEN=…                    # dashboard access token; dashboard reachable at 127.0.0.1:20150 (or QBASE)
QLANG=en npm run voice && QLANG=en npm run studio && QLANG=en npm run record && QLANG=en npm run compose
```

## Deployment

Build the frontend, install production dependencies on the host, and run a single backend process. The repository includes a PM2 configuration:

```sh
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 status lpcopy
```

Create the host's own `config.json` and `.env` before starting it. Set dashboard authentication and serve remote access over HTTPS. Keep the backend bound to loopback when a local reverse proxy or tunnel provides access.

### Repository deployment helper

`deploy.sh` is tailored to the maintainer's SSH setup. Review its destination alias, remote path, and restart behaviour before using it in another environment. It requires zsh, SSH, rsync, and PM2 on the destination.

The helper builds the dashboard, synchronises application files and `web/dist/`, installs production dependencies, and restarts the `lpcopy` process. It excludes `.env`, `config.json`, `data/`, and `logs/`. It deploys the working tree, so review uncommitted changes before running it.

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
  engine.js            Copy engine coordination
  watcher.js           Liquidity event detection
  policy.js            Copy rules and limits
  executor.js          Transaction construction and submission
  positions.js         Position synchronisation and accounting
  wallet.js            v4 wallet research
  walletv3.js          v3 wallet research
  proceeds.js          Post-close token proceeds
  server.js            HTTP API and static serving
  share-card.js        SVG and PNG PnL cards
  env.js               Environment loading and configuration persistence
web/                   React dashboard and frontend checks
public/                Shared assets, fonts, and legacy dashboard
test/                 JavaScript regression suites
demo/                  Demo video pipeline (privacy-scrubbed recording, narration, composition)
docs/                  Demo video, poster, and subtitles
config.example.json    Non-secret configuration template
.env.example           Credential variable template
ecosystem.config.cjs   PM2 process configuration
deploy.sh              Maintainer deployment helper
```

`data/`, `logs/`, `web/dist/`, and `demo/out/` are generated locally and excluded from Git.

### Pool health and holder distribution

Pool detail shows explicit market/position warnings, a heuristic health status, holder count and top-address concentration. Missing, mismatched or stale data cannot yield a healthy status. Thresholds are visible in the panel; this is not a contract audit.

Holder scans reuse the configured Alchemy Robinhood endpoint without exposing its URL/key to the browser. The background scanner enumerates ERC-20 transfers, checks candidate balances and total supply at one fixed block, and only publishes a count when balances reconcile with supply. It excludes zero balances; counts refer to addresses, not distinct people. PoolManager, the viewed v3 pool and burn addresses are excluded from the concentration warning; other contracts remain included and are labelled.

One scan runs at a time, with bounded history, address counts and request timeouts. Results are cached for 15 minutes; subsequent successful scans read new transfers. Verified snapshots and discovery state are saved beside the configured database in `holders/`. An incomplete index, nonstandard token accounting, provider failure or scan limit is shown as unavailable rather than an estimated total. Restarts reuse the verified cache; absent or damaged caches are rebuilt. If no Alchemy endpoint is configured, Blockscout is used (optional `BLOCKSCOUT_API_KEY` for its Pro API).

Validation: `node test/pool-health.js`. Provider references: [Alchemy Transfers API](https://www.alchemy.com/docs/reference/transfers-api-quickstart) and [Blockscout holders API](https://docs.blockscout.com/api-reference/get-token-holders).
