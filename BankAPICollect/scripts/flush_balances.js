/**
 * flush_balances.js
 *
 * Fixes Sure account balances for all mapped accounts.
 *
 * Background: Sure updates its account balance field incrementally when
 * transactions are added via the API. During bulk imports this incremental
 * update can fall behind and leave the balance field incorrect. However,
 * when a transaction is DELETED Sure performs a full recalculation from
 * scratch. This script exploits that behaviour by posting a tiny dummy
 * transaction and then immediately deleting it, which forces Sure to
 * recompute the correct balance for each account.
 *
 * Usage:
 *   npm run flush-balances
 *
 * Safe to run multiple times — only touches/removes its own dummy transactions.
 */

const axios = require('axios');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const SURE_HEADERS = { 'X-Api-Key': process.env.SURE_API_KEY, 'Content-Type': 'application/json' };
const DUMMY_NAME = '__balance_flush__';
const SETTLE_MS = 8000; // wait for Sure's async recalculation (large accounts need more time)

function sureUrl(p) {
    return `${(process.env.SURE_SERVER_URL || '').replace(/\/$/, '')}${p}`;
}

function parseSureBalance(str) {
    if (str == null) return null;
    const num = parseFloat(str.replace(/[^0-9.-]/g, ''));
    return isNaN(num) ? null : num;
}

async function fetchSureAccounts() {
    const res = await axios.get(sureUrl('/api/v1/accounts'), { headers: SURE_HEADERS });
    return res.data.accounts;
}

async function flushAccountBalance(sureAccountId, accountName) {
    process.stdout.write(`  Flushing ${accountName}...`);

    // Post a dummy $0.01 income transaction to trigger the balance calculator
    const dummy = await axios.post(sureUrl('/api/v1/transactions'), {
        transaction: {
            account_id: sureAccountId,
            date: '2000-01-01',       // far past — won't affect any real date range
            amount: 0.01,
            name: DUMMY_NAME,
            nature: 'income',
            source: 'upbank'
        }
    }, { headers: SURE_HEADERS });

    await new Promise(r => setTimeout(r, SETTLE_MS));

    // Delete the dummy — this triggers Sure's full balance recalculation
    await axios.delete(sureUrl(`/api/v1/transactions/${dummy.data.id}`), { headers: SURE_HEADERS });

    await new Promise(r => setTimeout(r, SETTLE_MS));

    // Read the new balance
    const accounts = await fetchSureAccounts();
    const account = accounts.find(a => a.id === sureAccountId);
    const newBalance = account ? account.balance : '?';
    console.log(`\r  ✅ ${accountName.padEnd(30)} → ${newBalance}`);
    return parseSureBalance(newBalance);
}

async function main() {
    const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
    const sureToUp = Object.fromEntries(Object.entries(accountMapping).map(([k, v]) => [v, k]));

    if (Object.keys(sureToUp).length === 0) {
        console.error('No accounts in UP_ACCOUNT_MAPPING.');
        process.exit(1);
    }

    const sureAccounts = await fetchSureAccounts();
    const sureMap = new Map(sureAccounts.map(a => [a.id, a]));

    console.log('\nFlushing Sure account balances...\n');

    for (const sureId of Object.keys(sureToUp)) {
        const account = sureMap.get(sureId);
        if (!account) {
            console.log(`  ⚠️  Sure account ${sureId} not found — skipping`);
            continue;
        }
        try {
            await flushAccountBalance(sureId, account.name);
        } catch (err) {
            console.error(`\n  ❌ Failed to flush ${account.name}:`, err.response?.data || err.message);
        }
    }

    console.log('\nDone. Run npm run diagnose to verify.\n');
}

main().catch(err => {
    console.error('Fatal error:', err.response?.data || err.message);
    process.exit(1);
});
