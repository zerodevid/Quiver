# Public API v1 (read-only)

Read your bot's balance, positions and balance / PnL chart data from scripts, spreadsheets,
Grafana or your own bot. The API is **read-only**: a key cannot change settings, switch modes,
open or close positions, or touch the wallet.

- Base URL: your dashboard URL, path `/api/v1`
- Format: JSON (UTF-8), `GET` only
- Auth: API key (not the dashboard access token)
- Amounts: USD numbers rounded to 2 decimals, timestamps in epoch **milliseconds**

## Get a key

Dashboard → **Settings → Security → API keys (read-only)** → name it → **Create API key**.

The key (`lpk_…`) is shown **once**; only a SHA-256 hash is stored on the server, so a lost key
cannot be recovered — revoke it and create another. Revoking takes effect immediately. Up to 20
active keys. Keys are per bot instance (each instance has its own database).

Treat a key like a password: it exposes your balance and positions (not your funds). Do not
put it in client-side code or public repos.

## Authentication

Send the key in either header:

```
Authorization: Bearer lpk_xxxxxxxx
X-API-Key: lpk_xxxxxxxx
```

```bash
curl -H "Authorization: Bearer $KEY" https://your-dashboard.example/api/v1/balance
```

The dashboard access token is **not** accepted here, and an API key does not open any other
dashboard route.

## Choosing a chain

On a multi-chain bot add `?chain=<name>` (for example `?chain=robinhood`, `?chain=bsc`).
Without it the main chain answers. `chain` in each response tells you which one you got.

## Limits and errors

60 requests per minute per key. Past that: `429` with a `Retry-After` header (seconds).

| Status | Meaning |
|---|---|
| 200 | OK |
| 401 | Missing, unknown or revoked key |
| 404 | Unknown endpoint |
| 405 | Method other than GET |
| 429 | Rate limit |
| 500 | Server error `{ "error": "kesalahan server" }` |

An error body is `{ "error": "<message>" }`. Error messages are in Indonesian.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v1` | List of endpoints |
| `GET /api/v1/status` | Bot state |
| `GET /api/v1/balance` | Wallet balance and PnL |
| `GET /api/v1/positions` | Open and closed positions |
| `GET /api/v1/position?id=` | One position |
| `GET /api/v1/equity` | Balance / PnL chart series |
| `GET /api/v1/pnl` | Statistics, daily PnL, result per source |
| `GET /api/v1/deposits` | Deposits and withdrawals behind the capital base |
| `GET /api/v1/activity` | Recent target actions and the bot's decisions |

The numbers come from the same routes as the dashboard, so they match what you see on screen.

### `GET /status`

```json
{ "chain": "robinhood", "label": "Robinhood Chain", "wallet": "0xabc…", "dryRun": false,
  "paused": false, "head": 123456, "lagBlocks": 0, "ethUsd": 2500,
  "lastSyncAt": 1792562606934, "openPositions": 3, "uptimeSec": 86400 }
```

### `GET /balance`

```json
{ "chain": "robinhood", "ts": 1792562607031,
  "totalUsd": 512.4, "cashUsd": 120.1, "positionsUsd": 380.2, "unclaimedFeesUsd": 12.1,
  "leftoverUsd": 0, "pnlUsd": 14, "realizedUsd": 12.5, "unrealizedUsd": 1.5,
  "capitalUsd": 498.4, "netPnlUsd": 14, "gasUsd": 3.2, "slippageUsd": 1.1,
  "openPositions": 3, "inRange": 2, "cashAssets": { "usd": 120.1 },
  "capitalStartedAt": 1790000000000 }
```

- `totalUsd` = cash + positions + unclaimed fees + leftover tokens.
- `pnlUsd` = realized + unrealized position PnL.
- `netPnlUsd` = `totalUsd − capitalUsd`; includes gas, zap and swap costs. `null` when no capital is tracked (for example before the first deposit scan).

### `GET /positions`

Query: `status=open` (default) | `closed` | `all`, `limit=1..100` (closed only, default 50).

```json
{ "chain": "robinhood", "syncedAt": 1792562606934,
  "open": [ { "id": 7, "venue": "v3", "tokenId": "101", "pool": "0x…", "status": "open",
    "pair": "PEPE/WETH", "symbol0": "PEPE", "symbol1": "WETH", "token0": "0x…", "token1": "0x…",
    "fee": 3000, "openedAt": 1792476206945, "closedAt": null, "ageHours": 5.2,
    "inRange": true, "tickLower": -1200, "tickUpper": 600, "curTick": 100,
    "costUsd": 50, "valueUsd": 53.4, "feeUsd": 1.2, "pnlUsd": 3.4, "pnlPct": 6.8, "outUsd": null,
    "source": "0xTarget…", "sourceLabel": "whale-1", "slPct": null, "tpPct": null } ],
  "closed": [ … same shape, with closedAt and outUsd set … ] }
```

`source` is the wallet being copied (`null` for a manual position). A position that was just
opened and not yet synced can have `valueUsd` equal to its cost and `feeUsd` 0.

### `GET /position?id=7`

One position, same shape as above plus `claimedUsd` (fees already claimed) and `withdrawnUsd`
(partial withdrawals already in the wallet). Returns `{ "error": … }` if the id is unknown.

### `GET /equity`

Query: `range=6h|12h|24h|3d|7d|14d|30d|90d|180d|365d|all` (default `7d`).

```json
{ "chain": "robinhood", "range": "7d", "from": 1791957806000,
  "series": [ { "ts": 1792541006945, "totalUsd": 120.5, "cashUsd": 100, "positionsUsd": 20,
                "feesUsd": 0.5, "pnlUsd": 0, "netPnlUsd": null, "openPositions": 1 }, … ],
  "baseline": { "ts": 1791957000000, "totalUsd": 118.2, "pnlUsd": -1.1, "netPnlUsd": null },
  "extremes": { "pnl": { "hi": 14, "lo": 0, "dd": 0, "hiTs": 1792562607035, "loTs": 1792541006945 } } }
```

- Points are one every ~5 minutes, thinned to at most ~360 per response; the last point is the live "now" value. Peaks and troughs are always kept.
- `baseline` is the last point before the window (for "change over this range"), or `null` for `all`.
- `extremes` has `pnl`, `net` and `value` entries with high, low and max drawdown (`dd`) computed from all points before thinning.
- Points without a cash reading have `cashUsd` and `netPnlUsd` set to `null`.

### `GET /pnl`

Query: `range` as above (default `30d`), applied to `dailyUtc`.

```json
{ "chain": "robinhood", "range": "30d",
  "stats": { "closedCount": 40, "wins": 25, "losses": 12, "flat": 3, "winRatePct": 67.6,
             "avgPnl": 1.9, "best": 14.2, "worst": -8.1, "avgHoldHours": 7.3 },
  "dailyUtc": [ { "date": "2026-10-21", "pnlUsd": 8.5 } ],
  "bySource": [ { "source": "0xTarget…", "label": "whale-1", "open": 1, "closed": 12,
                  "wins": 8, "losses": 4, "realizedUsd": 21.3, "unrealizedUsd": 1.1, "netUsd": 18.9 } ] }
```

`stats` and `bySource` cover all closed positions (all time); only `dailyUtc` follows `range`. It
groups realized PnL (net of gas and outside slippage) by UTC day of close. Win rate = wins / (wins + losses); break-even closes
are `flat`.

### `GET /deposits`

```json
{ "baselineUsd": 400, "capitalUsd": 498.4, "baselineTs": 1790000000000,
  "deposits": [ { "ts": 1790100000000, "kind": "deposit", "symbol": "USDG", "amount": 100,
                  "usd": 100, "txHash": "0x…" } ] }
```

Returns `{ "capitalUsd": null, "deposits": [] }` when no capital is tracked.

### `GET /activity`

Query: `limit=1..100` (default 50).

```json
{ "activity": [ { "id": 981, "ts": 1792562000000, "kind": "open", "venue": "v3",
  "source": "0xTarget…", "sourceLabel": "whale-1", "pair": "PEPE/WETH",
  "verdict": "copy", "reason": null, "txHash": "0x…" } ] }
```

`verdict` is the bot's decision on the target's action (`copy`, `dry`, `skip`, `error`);
`reason` explains skips and errors.

## Examples

Google Sheets (Apps Script):

```js
function balance() {
  const r = UrlFetchApp.fetch('https://your-dashboard.example/api/v1/balance',
    { headers: { Authorization: 'Bearer ' + PropertiesService.getScriptProperties().getProperty('LPK') } });
  return JSON.parse(r.getContentText()).totalUsd;
}
```

Python, balance curve for 30 days:

```python
import os, requests
h = {"Authorization": "Bearer " + os.environ["LPK"]}
r = requests.get("https://your-dashboard.example/api/v1/equity", params={"range": "30d"}, headers=h).json()
for p in r["series"]:
    print(p["ts"], p["totalUsd"], p["pnlUsd"])
```

## Notes for maintainers

- Code: `src/apiv1.js`; wired in `src/server.js` before the dashboard token gate. Key management routes (`/api/apikeys`, `/api/apikeys/revoke`) sit behind the dashboard token.
- Table `api_keys` (created on start): `hash`, `hint` (shown in the UI), `created_ts`, `last_used_ts`, `revoked_ts`.
- Each endpoint is a whitelisted projection of a dashboard route; add fields there explicitly so internal columns never leak.
- Tests: `node test/api-v1.js`.
