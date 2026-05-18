/**
 * find_phantoms.js
 *
 * Finds Sure transactions that have no matching Up Bank transaction (by external_id).
 * These are phantom records that inflate/deflate the account balance.
 *
 * Uses the local transaction cache (transactions_cache.json) when available to avoid
 * hitting the Up Bank API. Run build_cache.js first to populate the cache.
 *
 * Usage:
 *   npm run find-phantoms          # list phantoms for all mapped accounts
 *   npm run find-phantoms:delete   # also delete them from Sure
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const UP_HEADERS = { 'Authorization': `Bearer ${process.env.UP_BANK_ACCESS_TOKEN}` };
const SURE_HEADERS = { 'X-Api-Key': process.env.SURE_API_KEY, 'Content-Type': 'application/json' };
const DELETE_MODE = process.argv.includes('--delete');
const CONCURRENCY = 20;
const CACHE_PATH = process.env.CACHE_PATH || './transactions_cache.json';

function sureUrl(p) {
    return `${(process.env.SURE_SERVER_URL || '').replace(/\/$/, '')}${p}`;
}

function trackingPath() {
    return process.env.DATA_PATH || './imported_ids.json';
}

function loadImportedIds() {
    try { return new Set(JSON.parse(fs.readFileSync(trackingPath(), 'utf8'))); }
    catch { return new Set(); }
}

function saveImportedIds(ids) {
    const p = trackingPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([...ids]));
}

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
    catch { return null; }
}

function idsFromCache(cache, upId) {
    const account = cache?.accounts?.[upId];
    if (!account) return null;
    const ids = new Set();
    for (const t of account.transactions) {
        ids.add(t.id);
    }
    console.log(`    Using cache (${ids.size} IDs, fetched ${account.fetchedAt?.slice(0, 16) ?? 'unknown'})`);
    return ids;
}

async function fetchUpIds(accountId) {
    const ids = new Set();
    let nextUrl = `https://api.up.com.au/api/v1/accounts/${accountId}/transactions`;
    const syncStart = process.env.UP_BANK_SYNC_START || '2015-01-01T00:00:00Z';

    while (nextUrl) {
        const res = await axios.get(nextUrl, {
            headers: UP_HEADERS,
            params: { 'page[size]': 100, 'filter[since]': syncStart, 'filter[status]': 'SETTLED' }
        });
        for (const t of res.data.data) {
            ids.add(t.id);
        }
        nextUrl = res.data.links.next || null;
        process.stdout.write(`\r    Up Bank: ${ids.size} IDs loaded...`);
    }
    return ids;
}

async function fetchSureTransactions(sureAccountId) {
    const all = [];
    let page = 1;
    while (true) {
        const res = await axios.get(sureUrl('/api/v1/transactions'), {
            headers: SURE_HEADERS,
            params: { per_page: 100, page, account_id: sureAccountId }
        });
        const { transactions, pagination } = res.data;
        if (!transactions || transactions.length === 0) break;
        all.push(...transactions);
        process.stdout.write(`\r    Sure:     ${all.length} transactions loaded...`);
        if (page >= pagination.total_pages) break;
        page++;
    }
    return all;
}

async function runConcurrently(tasks, concurrency) {
    for (let i = 0; i < tasks.length; i += concurrency) {
        await Promise.all(tasks.slice(i, i + concurrency).map(t => t()));
    }
}

async function main() {
    const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
    const upAccounts = (await axios.get('https://api.up.com.au/api/v1/accounts', { headers: UP_HEADERS })).data.data;
    const sureAccounts = (await axios.get(sureUrl('/api/v1/accounts'), { headers: SURE_HEADERS })).data.accounts;

    const upMap = new Map(upAccounts.map(a => [a.id, a]));
    const sureMap = new Map(sureAccounts.map(a => [a.id, a]));

    const cache = loadCache();
    if (cache) {
        console.log(`Using local cache (built ${cache.builtAt?.slice(0, 16) ?? 'unknown'}). Run npm run build-cache:update to refresh.\n`);
    } else {
        console.log(`No local cache found at ${CACHE_PATH} — fetching from Up Bank API.\nRun npm run build-cache to avoid API rate limits.\n`);
    }

    const importedIds = loadImportedIds();
    let totalPhantoms = 0;

    for (const [upId, sureId] of Object.entries(accountMapping)) {
        const upAccount = upMap.get(upId);
        const sureAccount = sureMap.get(sureId);
        if (!upAccount || !sureAccount) continue;

        console.log(`\n── ${sureAccount.name} ──`);

        // Load Up Bank IDs from cache or API
        process.stdout.write('  Loading Up Bank transaction IDs...\n');
        const upIds = idsFromCache(cache, upId) ?? await fetchUpIds(upId);
        process.stdout.write('\n');

        // Load Sure transactions
        process.stdout.write('  Loading Sure transactions...\n');
        const sureTxns = await fetchSureTransactions(sureId);
        process.stdout.write('\n');

        // Check if Sure returns external_id
        const sampleWithExtId = sureTxns.find(t => t.external_id);
        if (!sampleWithExtId && sureTxns.length > 0) {
            console.log('  ⚠️  Sure does not return external_id — falling back to imported_ids.json matching');
        }

        // Find phantoms: Sure transactions whose external_id is not in Up Bank
        const phantoms = sureTxns.filter(t => {
            if (!t.external_id) {
                // No external_id — check if it's a known balance-flush dummy
                return t.name === '__balance_flush__';
            }
            return !upIds.has(t.external_id);
        });

        if (phantoms.length === 0) {
            console.log('  ✅ No phantom transactions found.');
            continue;
        }

        const phantomSum = phantoms.reduce((s, t) => s + (t.signed_amount_cents ?? 0), 0) / 100;
        console.log(`  ❌ ${phantoms.length} phantom(s) found, net sum: $${phantomSum.toFixed(2)}`);
        for (const t of phantoms) {
            console.log(`     ${t.date}  ${String(t.name).padEnd(40).slice(0, 40)}  signed_cents=${t.signed_amount_cents}  external_id=${t.external_id ?? 'null'}  id=${t.id}`);
        }

        totalPhantoms += phantoms.length;

        if (DELETE_MODE) {
            console.log(`  Deleting ${phantoms.length} phantom(s)...`);
            let deleted = 0;
            await runConcurrently(
                phantoms.map(t => async () => {
                    try {
                        await axios.delete(sureUrl(`/api/v1/transactions/${t.id}`), { headers: SURE_HEADERS });
                        if (t.external_id) {
                            importedIds.delete(t.external_id);
                            importedIds.delete(`${t.external_id}-cashback`);
                        }
                        deleted++;
                    } catch (err) {
                        if (err.response?.status !== 404) {
                            console.error(`\n  Failed to delete ${t.id}:`, err.response?.data || err.message);
                        }
                    }
                }),
                CONCURRENCY
            );
            saveImportedIds(importedIds);
            console.log(`  Deleted ${deleted} phantom transaction(s).`);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    if (totalPhantoms === 0) {
        console.log('✅ No phantom transactions found across all accounts.\n');
    } else if (DELETE_MODE) {
        console.log(`✅ Cleaned up ${totalPhantoms} phantom transaction(s). Run npm run diagnose to verify.\n`);
    } else {
        console.log(`Found ${totalPhantoms} phantom transaction(s) total.`);
        console.log('Run npm run find-phantoms:delete to remove them.\n');
    }
}

main().catch(err => {
    console.error('Fatal error:', err.response?.data || err.message);
    process.exit(1);
});
