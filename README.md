# Up Bank → [Sure](https://sureapp.com.au) Transaction Importer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Automatically sync your Up Bank transactions with Sure** – no manual CSV exports needed.

> Forked from [Nodemana/ActualBudget-UpBank-TransactionImporter](https://github.com/Nodemana/ActualBudget-UpBank-TransactionImporter) and extended with a streamlined onboarding process and reconciliation tooling to keep Sure balances accurate against Up Bank.

## Features

- **One-time setup**: Map accounts once, sync forever.
- **Hourly sync**: Transactions sync on a configurable cron schedule via Docker.
- **Full history import**: Pulls all settled transactions since your chosen sync start date.
- **Deduplication**: Local tracking file prevents duplicate imports across restarts.
- **Self-hosted & private**: Your data stays on your machine.

---

## Quickstart

### 1. Configure your `.env`

```env
SURE_SERVER_URL=http://your-sure-server:3000
SURE_API_KEY=your_sure_api_key

UP_BANK_ACCESS_TOKEN=up:yeah:your_up_bank_token

UP_BANK_SYNC_START=2019-01-01T00:00:00Z   # ISO 8601 — how far back to import

CRON_SCHEDULE="0 * * * *"   # hourly; see crontab.guru for other schedules
UTC_TIMEZONE_OFFSET=10      # AEST=10, AEDT=11, AWST=8, NZ=12, UTC=0

UP_ACCOUNT_MAPPING='{}'     # filled in after step 2

DATA_PATH=./imported_ids.json
```

> **Security**: Never commit your `.env` file. Up Bank tokens have full read access to your transactions.

### 2. Match accounts

```bash
cd BankAPICollect
npm run setup
```

This fetches your Up Bank and Sure accounts and auto-matches them by name. Copy the generated `UP_ACCOUNT_MAPPING` into your `.env`. For any unmatched accounts, create them in Sure first (matching the Up Bank display name makes auto-matching work), then re-run.

### 3. Initial import

```bash
npm run startup
```

Imports all settled transactions since `UP_BANK_SYNC_START`. For large histories this may take several minutes.

### 4. Set opening balances

```bash
npm run set-opening-balances
```

For accounts that existed before your sync start date, this posts a one-time "Opening Balance" transaction so Sure's running total matches Up Bank from day one.

> **Note**: Run this once, immediately after the initial import, while Up Bank balances are stable. Safe to re-run — already-set balances are skipped.

### 5. Ongoing sync

```bash
npm start
```

Runs a sync immediately, then schedules hourly syncs via the cron defined in `CRON_SCHEDULE`. On restart, it catches up on the past 7 days automatically.

---

## Docker

The image is published to GitHub Container Registry on every push to `production` and on version tags.

```bash
docker pull ghcr.io/jsantias/sure-upbank-transactionimporter:latest
```

### Docker Run

```bash
docker run -d \
  --env-file .env \
  --network="host" \
  -v $(pwd)/imported_ids.json:/app/imported_ids.json \
  ghcr.io/jsantias/sure-upbank-transactionimporter:latest
```

### Docker Compose

```yaml
services:
  up-sure-sync:
    image: ghcr.io/jsantias/sure-upbank-transactionimporter:latest
    container_name: up-sure-sync
    env_file: ./.env
    volumes:
      - ./imported_ids.json:/app/imported_ids.json
    network_mode: host
    restart: unless-stopped
```

---

## Maintenance & Troubleshooting

All maintenance scripts are run from the `BankAPICollect/` directory with `npm run <command>`.

### Diagnose balance mismatches

```bash
npm run diagnose             # summary table comparing Up Bank vs Sure balances
npm run diagnose:detail      # also prints sample transactions for mismatched accounts
```

Shows per-account: Up Bank balance, Sure reported balance, Sure calculated balance (sum of all transactions), and the diff. A ✅ means the calculated balance matches Up Bank; ❌ means there's a discrepancy.

### Fix stale Sure balance display

```bash
npm run build-cache           # build the local cache first (one-time or periodic)
npm run fix-balance                         # fix all accounts
npm run fix-balance -- "Spending"          # fix a specific account
npm run fix-balance -- "Spending" "2Up Spending"
```

Sure's balance display can become stale after bulk imports. `fix-balance` cycles a real transaction (delete + re-add from cache) to trigger Sure's balance recalculation without a full account reset. It's more reliable than `flush-balances` for accounts with complex histories.

```bash
npm run flush-balances
```

Alternative: posts and immediately deletes a dummy $0.01 transaction. Simpler but less reliable for accounts that have an Opening Balance transaction (Sure may exclude it from the recalculation).

### Build the local transaction cache

```bash
npm run build-cache           # full rebuild for all mapped accounts
npm run build-cache:update    # only re-fetch accounts whose cache is >6h old
```

Fetches all settled Up Bank transactions and saves them to `transactions_cache.json` (or `CACHE_PATH`). Once built, `find-phantoms`, `reconcile`, and `fix-balance` all read from this cache instead of hitting the Up Bank API, avoiding rate limits. Run periodically to keep the cache fresh.

### Find phantom transactions

```bash
npm run find-phantoms          # list Sure transactions with no matching Up Bank ID
npm run find-phantoms:delete   # delete them and clean up imported_ids.json
```

Phantoms are Sure transactions whose `external_id` doesn't match any Up Bank transaction. They inflate or deflate account balances.

### Deep reconciliation

```bash
npm run reconcile
```

For each account, fetches all Up Bank and Sure transactions, compares counts and sums, and identifies which Up Bank transactions are missing from Sure.

### Reset and reimport a single account

```bash
npm run delete-account -- "Account Name"
npm run startup
```

Deletes all Sure transactions for the named account, clears its entries from `imported_ids.json`, then re-imports everything from Up Bank. Use this when an account's transaction history is corrupted or out of sync.

> After resetting, re-run `npm run set-opening-balances` only if the account existed before your sync start date and needs a pre-sync opening balance.

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `SURE_SERVER_URL` | ✅ | Base URL of your Sure server (e.g. `http://192.168.1.10:3000`) |
| `SURE_API_KEY` | ✅ | Sure API key |
| `UP_BANK_ACCESS_TOKEN` | ✅ | Up Bank personal access token |
| `UP_ACCOUNT_MAPPING` | ✅ | JSON mapping Up Bank account IDs to Sure account IDs |
| `UP_BANK_SYNC_START` | ✅ | ISO 8601 date — how far back to import (e.g. `2019-01-01T00:00:00Z`) |
| `CRON_SCHEDULE` | ✅ | Cron expression for sync frequency (e.g. `0 * * * *` for hourly) |
| `UTC_TIMEZONE_OFFSET` | — | Integer UTC offset for your timezone. Defaults to `0`. Prevents transactions near midnight being dated incorrectly. |
| `DATA_PATH` | — | Path to the deduplication tracking file. Defaults to `./imported_ids.json`. |
| `CACHE_PATH` | — | Path to the local transaction cache. Defaults to `./transactions_cache.json`. |

---

## Scripts Reference

All scripts are run from the `BankAPICollect/` directory.

| Command | Description |
|---|---|
| `npm run setup` | Match Up Bank accounts to Sure accounts and generate `UP_ACCOUNT_MAPPING` |
| `npm run startup` | Full history import (all accounts, all transactions since sync start) |
| `npm start` | Ongoing sync — catches up on past 7 days, then runs on cron |
| `npm run set-opening-balances` | Post one-time opening balances for accounts with pre-sync history |
| `npm run build-cache` | Build local cache of Up Bank transactions (avoids API rate limits) |
| `npm run build-cache:update` | Refresh only stale cache entries (>6h old) |
| `npm run diagnose` | Compare Up Bank vs Sure balances for all accounts |
| `npm run diagnose:detail` | Diagnose with sample transactions for mismatched accounts |
| `npm run fix-balance` | Fix stale Sure balance display by cycling a real transaction from cache |
| `npm run flush-balances` | Alternative balance fix — cycles a dummy $0.01 transaction |
| `npm run find-phantoms` | Detect Sure transactions with no Up Bank match |
| `npm run find-phantoms:delete` | Detect and delete phantom transactions |
| `npm run reconcile` | Detailed transaction-level comparison between Up Bank and Sure |
| `npm run delete-account -- "Name"` | Wipe and reset a specific account for reimport |
| `npm run delete-all` | Delete all Sure transactions (nuclear reset) |

---

## Roadmap

- [x] Docker containerised setup
- [x] 2Up account support
- [x] Diagnostic and reconciliation tooling
- [ ] Web UI for non-technical setup
- [ ] Configurable sync frequency from UI
- [ ] Stock portfolio import as off-budget account

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit: `git commit -m 'feat: add my feature'`
4. Push: `git push origin feat/my-feature`
5. Open a PR

---

## Need Help? Found a Bug?

[Open an Issue](https://github.com/jsantias/Sure-UpBank-TransactionImporter/issues)
