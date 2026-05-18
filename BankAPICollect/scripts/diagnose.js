/**
 * diagnose.js
 *
 * Compares Up Bank account balances against Sure and shows a per-account breakdown.
 *
 * Usage:
 *   npm run diagnose              # summary table
 *   npm run diagnose:detail       # also show first 5 transactions per mismatched account
 */

const axios = require('axios');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const UP_HEADERS = { 'Authorization': `Bearer ${process.env.UP_BANK_ACCESS_TOKEN}` };
const SURE_HEADERS = { 'X-Api-Key': process.env.SURE_API_KEY, 'Content-Type': 'application/json' };
const DETAIL = process.argv.includes('--detail');

function sureUrl(p) {
    return `${(process.env.SURE_SERVER_URL || '').replace(/\/$/, '')}${p}`;
}

function parseSureBalance(str) {
    if (str == null) return null;
    const num = parseFloat(str.replace(/[^0-9.-]/g, ''));
    return isNaN(num) ? null : num;
}

async function fetchUpAccounts() {
    const res = await axios.get('https://api.up.com.au/api/v1/accounts', { headers: UP_HEADERS });
    return res.data.data;
}

async function fetchSureAccounts() {
    const res = await axios.get(sureUrl('/api/v1/accounts'), { headers: SURE_HEADERS });
    return res.data.accounts;
}

async function fetchSureAccountStats(sureAccountId) {
    let totalCount = 0;
    let sumCents = 0;
    let page = 1;
    const sampleTransactions = [];

    while (true) {
        const res = await axios.get(sureUrl('/api/v1/transactions'), {
            headers: SURE_HEADERS,
            params: { per_page: 100, page, account_id: sureAccountId }
        });
        const { transactions, pagination } = res.data;
        if (!transactions || transactions.length === 0) break;

        for (const t of transactions) {
            totalCount++;
            sumCents += t.signed_amount_cents ?? 0;
            if (sampleTransactions.length < 5) sampleTransactions.push(t);
        }

        if (page >= pagination.total_pages) break;
        page++;
    }

    return { totalCount, calculatedBalance: sumCents / 100, sampleTransactions };
}

async function main() {
    const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
    const sureToUp = Object.fromEntries(Object.entries(accountMapping).map(([k, v]) => [v, k]));

    const [upAccounts, sureAccounts] = await Promise.all([fetchUpAccounts(), fetchSureAccounts()]);

    const upMap = new Map(upAccounts.map(a => [a.id, a]));
    const sureMap = new Map(sureAccounts.map(a => [a.id, a]));

    const col = (s, w) => String(s ?? '').padEnd(w).slice(0, w);
    const money = n => n == null ? '—' : `$${n.toFixed(2)}`;

    const W = 105;
    console.log('\n' + '─'.repeat(W));
    console.log(
        col('Account', 22) +
        col('Up Bank', 14) +
        col('Sure (reported)', 18) +
        col('Sure (calculated)', 20) +
        col('Diff (Up−calc)', 16) +
        col('Txn count', 10)
    );
    console.log('─'.repeat(W));

    let anyMismatch = false;

    for (const [sureId, upId] of Object.entries(sureToUp)) {
        const sureAccount = sureMap.get(sureId);
        const upAccount = upMap.get(upId);
        if (!sureAccount || !upAccount) continue;

        const upBalance = parseFloat(upAccount.attributes.balance.value);
        const sureReported = parseSureBalance(sureAccount.balance);

        process.stdout.write(`  Fetching Sure transactions for ${sureAccount.name}...`);
        const { totalCount, calculatedBalance, sampleTransactions } = await fetchSureAccountStats(sureId);
        process.stdout.write('\r' + ' '.repeat(65) + '\r');

        const diff = upBalance - calculatedBalance;
        // Liability accounts (loans) show balance as positive "amount owed" in Sure,
        // but signed_amount_cents sums to negative — this difference is expected.
        const isLiability = sureAccount.classification === 'liability';
        const calcMatchesReported = isLiability
            ? Math.abs((sureReported ?? 0) + calculatedBalance) < 0.01   // liability: reported ≈ -calculated
            : Math.abs((sureReported ?? 0) - calculatedBalance) < 0.01;
        const flag = Math.abs(diff) < 0.01 ? '✅' : '❌';
        if (Math.abs(diff) >= 0.01) anyMismatch = true;

        console.log(
            flag + ' ' +
            col(sureAccount.name, 21) +
            col(money(upBalance), 14) +
            col(money(sureReported), 18) +
            col(money(calculatedBalance), 20) +
            col(money(diff), 16) +
            col(totalCount, 10)
        );

        if (!calcMatchesReported) {
            console.log(`     ↳ Sure reported ≠ calculated — run npm run flush-balances to fix`);
        }

        if (DETAIL && Math.abs(diff) >= 0.01 && sampleTransactions.length > 0) {
            console.log('     Sample transactions (first 5):');
            for (const t of sampleTransactions) {
                console.log(`       ${t.date}  ${String(t.name).padEnd(35).slice(0, 35)}  ${String(t.classification).padEnd(8)}  signed_cents=${t.signed_amount_cents}`);
            }
        }
    }

    console.log('─'.repeat(W));
    if (!anyMismatch) {
        console.log('\n✅ All transaction balances match Up Bank.\n');
    } else {
        console.log('\n❌ Some accounts have mismatches. Review the rows above.\n');
        console.log('Tips:');
        console.log('  • Diff positive  → Sure is missing transactions or amounts are wrong');
        console.log('  • Diff negative  → Sure has extra/duplicate transactions');
        console.log('  • Run with --detail to see sample transactions for mismatched accounts\n');
    }
}

main().catch(err => {
    console.error('Fatal error:', err.response?.data || err.message);
    process.exit(1);
});
