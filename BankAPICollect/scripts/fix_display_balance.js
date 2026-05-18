/**
 * fix_display_balance.js
 *
 * Fixes a stale Sure account balance display by cycling a real transaction
 * (delete + re-add from local cache) rather than a dummy. Deleting triggers
 * Sure's full balance recalculation; re-adding restores data integrity.
 *
 * Unlike flush_balances.js (which uses a dummy $0.01 transaction), this uses
 * the account's most recent real transaction from the local cache, making the
 * recalculation more reliable for accounts with complex histories.
 *
 * Usage:
 *   npm run fix-balance                              # fix all mapped accounts
 *   npm run fix-balance -- "Spending"               # fix one account by name
 *   npm run fix-balance -- "Spending" "2Up Spending"
 *
 * Requires: run npm run build-cache first.
 */

const axios = require('axios');
const fs = require('fs');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const SURE_HEADERS = { 'X-Api-Key': process.env.SURE_API_KEY, 'Content-Type': 'application/json' };
const CACHE_PATH = process.env.CACHE_PATH || './transactions_cache.json';
const SETTLE_MS = 10000;

function sureUrl(p) {
    return `${(process.env.SURE_SERVER_URL || '').replace(/\/$/, '')}${p}`;
}

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
    catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSureBalance(sureId) {
    const res = await axios.get(sureUrl('/api/v1/accounts'), { headers: SURE_HEADERS });
    const account = res.data.accounts.find(a => a.id === sureId);
    return account?.balance ?? null;
}

async function fetchMostRecentCyclableTxn(sureId) {
    const res = await axios.get(sureUrl('/api/v1/transactions'), {
        headers: SURE_HEADERS,
        params: { per_page: 50, page: 1, account_id: sureId }
    });
    const txns = res.data.transactions || [];
    // Skip balance-flush dummies and opening balance transactions — we need a real transaction
    return txns.find(t => t.name !== '__balance_flush__' && t.name !== 'Opening Balance') || null;
}

async function fixAccountBalance(upId, sureId, accountName, cache) {
    console.log(`\n── ${accountName} ──`);

    const beforeBal = await fetchSureBalance(sureId);
    console.log(`  Before: ${beforeBal ?? '?'}`);

    const sureTxn = await fetchMostRecentCyclableTxn(sureId);
    if (!sureTxn) {
        console.log('  ⚠️  No cyclable transaction found in Sure — skipping.');
        return;
    }

    // Look up this transaction in the cache for reliable data
    const cachedAccount = cache?.accounts?.[upId];
    const cachedTxn = cachedAccount?.transactions?.find(t => t.id === sureTxn.external_id);

    // Derive amount and nature from cache (preferred) or Sure's response
    const signedCents = cachedTxn?.amountCents ?? sureTxn.signed_amount_cents ?? null;
    const nature = cachedTxn?.nature ?? sureTxn.nature ?? (signedCents !== null && signedCents >= 0 ? 'income' : 'expense');
    const amount = signedCents !== null ? Math.abs(signedCents) / 100 : Math.abs(sureTxn.amount ?? 0);
    const name = cachedTxn?.description ?? sureTxn.name;
    const date = cachedTxn?.date ?? sureTxn.date;

    console.log(`  Cycling: ${date}  ${name}`);
    if (!cachedTxn && sureTxn.external_id) {
        console.log(`  ⚠️  Transaction not in cache — using Sure's data. Run npm run build-cache to improve accuracy.`);
    }

    // Delete the transaction (triggers Sure's full balance recalculation)
    await axios.delete(sureUrl(`/api/v1/transactions/${sureTxn.id}`), { headers: SURE_HEADERS });
    await sleep(SETTLE_MS);

    // Re-add the transaction to restore data integrity
    try {
        await axios.post(sureUrl('/api/v1/transactions'), {
            transaction: {
                account_id: sureId,
                date,
                amount,
                name,
                nature,
                ...(sureTxn.external_id ? { external_id: sureTxn.external_id } : {}),
                source: 'upbank'
            }
        }, { headers: SURE_HEADERS });
    } catch (err) {
        console.error(`  ❌ Failed to re-add transaction:`, err.response?.data || err.message);
        console.log(`  ⚠️  Transaction was deleted but not re-added. Run npm run startup or npm run reconcile.`);
        return;
    }

    await sleep(SETTLE_MS);

    const afterBal = await fetchSureBalance(sureId);
    console.log(`  After:  ${afterBal ?? '?'}`);

    if (afterBal !== beforeBal) {
        console.log(`  ✅ Balance updated.`);
    } else {
        console.log(`  ⚠️  Balance unchanged after cycling.`);
        console.log(`      If this account has an "Opening Balance" transaction, Sure may exclude it`);
        console.log(`      from its recalculation. Use npm run diagnose to verify the calculated balance is correct.`);
    }
}

async function main() {
    const cache = loadCache();
    if (!cache) {
        console.error(`❌ No cache found at ${CACHE_PATH}. Run: npm run build-cache`);
        process.exit(1);
    }

    const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
    if (Object.keys(accountMapping).length === 0) {
        console.error('UP_ACCOUNT_MAPPING is empty.');
        process.exit(1);
    }

    const sureAccounts = (await axios.get(sureUrl('/api/v1/accounts'), { headers: SURE_HEADERS })).data.accounts;
    const sureMap = new Map(sureAccounts.map(a => [a.id, a]));

    const nameFilters = process.argv.slice(2).map(s => s.toLowerCase());

    console.log('\nFixing Sure account balance display...\n');

    for (const [upId, sureId] of Object.entries(accountMapping)) {
        const sureAccount = sureMap.get(sureId);
        if (!sureAccount) continue;
        if (nameFilters.length > 0 && !nameFilters.includes(sureAccount.name.toLowerCase())) continue;

        try {
            await fixAccountBalance(upId, sureId, sureAccount.name, cache);
        } catch (err) {
            console.error(`\n  ❌ Failed for ${sureAccount.name}:`, err.response?.data || err.message);
        }
    }

    console.log('\nDone. Run npm run diagnose to verify.\n');
}

main().catch(err => {
    console.error('Fatal error:', err.response?.data || err.message);
    process.exit(1);
});
