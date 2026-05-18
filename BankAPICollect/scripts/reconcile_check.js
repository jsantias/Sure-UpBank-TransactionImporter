/**
 * reconcile_check.js
 *
 * For each account, compares Up Bank transactions against Sure transactions to
 * identify count/sum discrepancies and which transactions are missing from Sure.
 *
 * Uses the local cache (transactions_cache.json) when available so repeated runs
 * don't burn Up Bank API rate limits. Run build_cache.js first to populate it.
 *
 * Usage:
 *   npm run reconcile
 */

const axios = require('axios');
const fs = require('fs');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const UP_HEADERS = { 'Authorization': `Bearer ${process.env.UP_BANK_ACCESS_TOKEN}` };
const SURE_HEADERS = { 'X-Api-Key': process.env.SURE_API_KEY, 'Content-Type': 'application/json' };
const CACHE_PATH = process.env.CACHE_PATH || './transactions_cache.json';

function sureUrl(p) {
    return `${(process.env.SURE_SERVER_URL || '').replace(/\/$/, '')}${p}`;
}

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
    catch { return null; }
}

function txnsFromCache(cache, upId) {
    const account = cache?.accounts?.[upId];
    if (!account) return null;
    console.log(`    Using cache (${account.transactions.length} txns, fetched ${account.fetchedAt?.slice(0, 16) ?? 'unknown'})`);
    return account.transactions;
}

async function fetchUpTransactions(accountId) {
    let all = [];
    let nextUrl = `https://api.up.com.au/api/v1/accounts/${accountId}/transactions`;
    const syncStart = process.env.UP_BANK_SYNC_START || '2015-01-01T00:00:00Z';

    while (nextUrl) {
        const res = await axios.get(nextUrl, {
            headers: UP_HEADERS,
            params: { 'page[size]': 100, 'filter[since]': syncStart, 'filter[status]': 'SETTLED' }
        });
        all.push(...res.data.data);
        nextUrl = res.data.links.next || null;
        process.stdout.write(`\r    Up Bank: ${all.length} transactions fetched...`);
    }
    return all;
}

async function fetchSureTransactions(sureAccountId) {
    let all = [];
    let page = 1;

    while (true) {
        const res = await axios.get(sureUrl('/api/v1/transactions'), {
            headers: SURE_HEADERS,
            params: { per_page: 100, page, account_id: sureAccountId }
        });
        const { transactions, pagination } = res.data;
        if (!transactions || transactions.length === 0) break;
        all.push(...transactions);
        process.stdout.write(`\r    Sure:     ${all.length} transactions fetched...`);
        if (page >= pagination.total_pages) break;
        page++;
    }
    return all;
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

    for (const [upId, sureId] of Object.entries(accountMapping)) {
        const upAccount = upMap.get(upId);
        const sureAccount = sureMap.get(sureId);
        if (!upAccount || !sureAccount) continue;

        const upBalance = parseFloat(upAccount.attributes.balance.value);

        process.stdout.write(`\nChecking ${sureAccount.name}...\n`);

        // Load Up Bank transactions from cache or API
        process.stdout.write(`  Loading Up Bank transactions...\n`);
        const rawUpTxns = txnsFromCache(cache, upId);
        let upTxns, upSum, upOldest, upNewest, upIdSet;

        if (rawUpTxns) {
            // Cache records use amountCents (signed integer)
            upSum = rawUpTxns.reduce((s, t) => s + t.amountCents, 0) / 100;
            upOldest = rawUpTxns.length ? rawUpTxns[rawUpTxns.length - 1].date : 'n/a';
            upNewest = rawUpTxns.length ? rawUpTxns[0].date : 'n/a';
            upIdSet = new Set(rawUpTxns.map(t => t.id));
            upTxns = rawUpTxns; // used for missing-txn reporting below
        } else {
            const fetched = await fetchUpTransactions(upId);
            process.stdout.write('\n');
            upSum = fetched.reduce((s, t) => s + parseFloat(t.attributes.amount.value), 0);
            upOldest = fetched.length ? fetched[fetched.length - 1].attributes.settledAt?.slice(0, 10) : 'n/a';
            upNewest = fetched.length ? fetched[0].attributes.settledAt?.slice(0, 10) : 'n/a';
            upIdSet = new Set(fetched.map(t => t.id));
            upTxns = fetched;
        }

        // Fetch Sure transactions
        process.stdout.write(`  Loading Sure transactions...\n`);
        const sureTxns = await fetchSureTransactions(sureId);
        process.stdout.write('\n');

        const sureSum = sureTxns.reduce((s, t) => s + (t.signed_amount_cents ?? 0), 0) / 100;
        const sureOldest = sureTxns.length ? sureTxns[sureTxns.length - 1].date : 'n/a';
        const sureNewest = sureTxns.length ? sureTxns[0].date : 'n/a';

        const sureExternalIds = new Set(sureTxns.map(t => t.external_id).filter(Boolean));

        // Find Up Bank transactions missing from Sure
        const missingCount = rawUpTxns
            ? rawUpTxns.filter(t => !sureExternalIds.has(t.id)).length
            : upTxns.filter(t => !sureExternalIds.has(t.id)).length;

        const upTxnCount = rawUpTxns ? rawUpTxns.length : upTxns.length;

        console.log(`\n  ── ${sureAccount.name} ──`);
        console.log(`  Up Bank:  ${upTxnCount} txns  sum=$${upSum.toFixed(2)}  range: ${upOldest} → ${upNewest}`);
        console.log(`  Sure:     ${sureTxns.length} txns  sum=$${sureSum.toFixed(2)}  range: ${sureOldest} → ${sureNewest}`);
        console.log(`  Up balance field: $${upBalance.toFixed(2)}`);
        console.log(`  Count diff: ${upTxnCount - sureTxns.length} (Up Bank vs Sure)`);
        console.log(`  Sum diff:   $${(upSum - sureSum).toFixed(2)}`);

        if (missingCount > 0) {
            if (rawUpTxns) {
                const missing = rawUpTxns.filter(t => !sureExternalIds.has(t.id));
                const missingSum = missing.reduce((s, t) => s + t.amountCents, 0) / 100;
                console.log(`  Missing txns sum: $${missingSum.toFixed(2)} (${missing.length} transactions)`);
                console.log(`  Oldest missing: ${missing[missing.length - 1]?.date}`);
                console.log(`  Newest missing: ${missing[0]?.date}`);
                console.log(`  Sample missing (newest 5):`);
                for (const t of missing.slice(0, 5)) {
                    console.log(`    ${t.date}  ${String(t.description).padEnd(35).slice(0, 35)}  $${(t.amountCents / 100).toFixed(2)}`);
                }
            } else {
                const missing = upTxns.filter(t => !sureExternalIds.has(t.id));
                const missingSum = missing.reduce((s, t) => s + parseFloat(t.attributes.amount.value), 0);
                console.log(`  Missing txns sum: $${missingSum.toFixed(2)} (${missing.length} transactions)`);
                console.log(`  Oldest missing: ${missing[missing.length - 1]?.attributes.settledAt?.slice(0, 10)}`);
                console.log(`  Newest missing: ${missing[0]?.attributes.settledAt?.slice(0, 10)}`);
                console.log(`  Sample missing (newest 5):`);
                for (const t of missing.slice(0, 5)) {
                    const amt = parseFloat(t.attributes.amount.value);
                    console.log(`    ${t.attributes.settledAt?.slice(0, 10)}  ${String(t.attributes.description).padEnd(35).slice(0, 35)}  $${amt.toFixed(2)}`);
                }
            }
        }
    }

    console.log('\nDone.\n');
}

main().catch(err => {
    console.error('Fatal error:', err.response?.data || err.message);
    process.exit(1);
});
