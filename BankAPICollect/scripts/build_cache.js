/**
 * build_cache.js
 *
 * Fetches all settled Up Bank transactions and saves them to a local cache file.
 * Run this once after initial setup, then periodically to pick up new transactions.
 * All other tools (find_phantoms, reconcile_check, fix_display_balance) use this
 * cache instead of hitting the Up Bank API, avoiding rate limits.
 *
 * Usage:
 *   npm run build-cache          # full rebuild for all accounts
 *   npm run build-cache:update   # only re-fetch accounts whose cache is >6h old
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const UP_HEADERS = { 'Authorization': `Bearer ${process.env.UP_BANK_ACCESS_TOKEN}` };
const CACHE_PATH = process.env.CACHE_PATH || './transactions_cache.json';
const UPDATE_MODE = process.argv.includes('--update');
const STALE_HOURS = 6;

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
    catch { return { version: 1, builtAt: null, accounts: {} }; }
}

function saveCache(cache) {
    fs.mkdirSync(path.dirname(path.resolve(CACHE_PATH)), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
    console.log(`\n✅ Cache saved → ${CACHE_PATH}\n`);
}

async function fetchUpAccounts() {
    const res = await axios.get('https://api.up.com.au/api/v1/accounts', { headers: UP_HEADERS });
    return res.data.data;
}

async function fetchTransactions(accountId) {
    const all = [];
    let nextUrl = `https://api.up.com.au/api/v1/accounts/${accountId}/transactions`;
    const syncStart = process.env.UP_BANK_SYNC_START || '2015-01-01T00:00:00Z';

    while (nextUrl) {
        const res = await axios.get(nextUrl, {
            headers: UP_HEADERS,
            params: { 'page[size]': 100, 'filter[since]': syncStart, 'filter[status]': 'SETTLED' }
        });
        all.push(...res.data.data);
        nextUrl = res.data.links.next || null;
        process.stdout.write(`\r  ${all.length} transactions fetched...`);
    }
    return all;
}

function toRecord(t) {
    const cents = t.attributes.amount.valueInBaseUnits;
    return {
        id: t.id,
        date: t.attributes.settledAt?.slice(0, 10) ?? t.attributes.createdAt.slice(0, 10),
        description: t.attributes.description,
        amountCents: cents,
        nature: cents < 0 ? 'expense' : 'income',
        settledAt: t.attributes.settledAt ?? t.attributes.createdAt,
    };
}

function isStale(fetchedAt) {
    if (!fetchedAt) return true;
    const ageHours = (Date.now() - new Date(fetchedAt).getTime()) / 3600000;
    return ageHours > STALE_HOURS;
}

async function main() {
    const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
    if (Object.keys(accountMapping).length === 0) {
        console.error('UP_ACCOUNT_MAPPING is empty — nothing to cache.');
        process.exit(1);
    }

    const cache = loadCache();
    cache.builtAt = new Date().toISOString();

    const upAccounts = await fetchUpAccounts();
    let built = 0, skipped = 0;

    for (const account of upAccounts) {
        const upId = account.id;
        if (!accountMapping[upId]) continue;

        const name = account.attributes.displayName;

        if (UPDATE_MODE && !isStale(cache.accounts[upId]?.fetchedAt)) {
            console.log(`${name}: cache is fresh — skipping`);
            skipped++;
            continue;
        }

        process.stdout.write(`\n${name}:\n`);
        const txns = await fetchTransactions(upId);
        console.log(`\n  ✅ ${txns.length} transactions`);

        cache.accounts[upId] = {
            name,
            sureId: accountMapping[upId],
            fetchedAt: new Date().toISOString(),
            transactions: txns.map(toRecord),
        };
        built++;
    }

    saveCache(cache);
    console.log(`Built: ${built} account(s)${skipped ? `, skipped ${skipped} (fresh)` : ''}.`);
    console.log('Run npm run find-phantoms or npm run reconcile to use the cache.\n');
}

main().catch(err => {
    console.error('Fatal:', err.response?.data || err.message);
    process.exit(1);
});
