/**
 * set_opening_balances.js
 *
 * Run this ONCE after your initial import to set the correct opening balance
 * for each account in Sure. The opening balance is calculated as:
 *
 *   opening_balance = current_Up_Bank_balance - sum(all_settled_transactions_since_UP_BANK_SYNC_START)
 *
 * This ensures Sure's running total matches Up Bank from day one.
 *
 * Usage:
 *   npm run set-opening-balances
 *
 * Safe to re-run — already-posted opening balances are skipped via imported_ids.json.
 */

const axios = require('axios');
const fs = require('fs');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const log = require('../src/logger');

const UP_HEADERS = { 'Authorization': `Bearer ${process.env.UP_BANK_ACCESS_TOKEN}` };
const SURE_HEADERS = {
    'X-Api-Key': process.env.SURE_API_KEY,
    'Content-Type': 'application/json'
};

function sureUrl(path) {
    return `${(process.env.SURE_SERVER_URL || '').replace(/\/$/, '')}${path}`;
}

function trackingPath() {
    return process.env.DATA_PATH || './imported_ids.json';
}

function loadImportedIds() {
    try {
        return new Set(JSON.parse(fs.readFileSync(trackingPath(), 'utf8')));
    } catch {
        return new Set();
    }
}

function saveImportedIds(ids) {
    fs.writeFileSync(trackingPath(), JSON.stringify([...ids]));
}

async function fetchUpAccounts() {
    const res = await axios.get('https://api.up.com.au/api/v1/accounts', { headers: UP_HEADERS });
    return res.data.data;
}

// Fetch all SETTLED transactions for an account since a given ISO date.
// Using filter[status]=SETTLED avoids including pending amounts that may change.
async function fetchSettledTransactionsSince(accountId, since) {
    let allTransactions = [];
    let nextUrl = `https://api.up.com.au/api/v1/accounts/${accountId}/transactions`;

    while (nextUrl) {
        const res = await axios.get(nextUrl, {
            headers: UP_HEADERS,
            params: { 'page[size]': 100, 'filter[since]': since, 'filter[status]': 'SETTLED' }
        });
        allTransactions = [...allTransactions, ...res.data.data];
        nextUrl = res.data.links.next || null;
        process.stdout.write(`\r  Fetched ${allTransactions.length} transactions...`);
    }
    if (allTransactions.length > 0) console.log();
    return allTransactions;
}

async function postOpeningBalance(sureAccountId, amountDollars, date) {
    const transactionData = {
        account_id: sureAccountId,
        date,
        amount: Math.abs(amountDollars),
        name: 'Opening Balance',
        nature: amountDollars >= 0 ? 'income' : 'expense',
        external_id: `opening_balance_${sureAccountId}`,
        source: 'upbank'
    };
    await axios.post(
        sureUrl('/api/v1/transactions'),
        { transaction: transactionData },
        { headers: SURE_HEADERS }
    );
}

async function main() {
    const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
    const syncStart = process.env.UP_BANK_SYNC_START;

    if (!syncStart || syncStart.trim().startsWith('#') || syncStart.trim() === '') {
        console.log('UP_BANK_SYNC_START is not set — importing all history means opening balance is $0.');
        console.log('Nothing to do. If your account had a balance before Up Bank, set UP_BANK_SYNC_START and re-run.');
        return;
    }

    const syncDate = syncStart.split('T')[0];
    console.log(`\nCalculating opening balances as of: ${syncDate}`);
    console.log('(This may take a few minutes if you have many transactions)\n');

    const importedIds = loadImportedIds();
    const upAccounts = await fetchUpAccounts();
    let anyPosted = false;

    for (const account of upAccounts) {
        const upId = account.id;
        const sureId = accountMapping[upId];
        if (!sureId) continue;

        const name = account.attributes.displayName;
        const openingBalanceExternalId = `opening_balance_${sureId}`;

        if (importedIds.has(openingBalanceExternalId)) {
            console.log(`${name}: already has an opening balance — skipping.`);
            continue;
        }

        const currentCents = account.attributes.balance.valueInBaseUnits;
        console.log(`\n${name}`);
        console.log(`  Current balance:  $${(currentCents / 100).toFixed(2)}`);

        const transactions = await fetchSettledTransactionsSince(upId, syncStart);
        const sumCents = transactions.reduce(
            (sum, t) => sum + t.attributes.amount.valueInBaseUnits, 0
        );

        const openingCents = currentCents - sumCents;
        const openingDollars = openingCents / 100;

        console.log(`  Transactions since sync start: ${transactions.length}`);
        console.log(`  Net movement since sync start: $${(sumCents / 100).toFixed(2)}`);
        console.log(`  Opening balance needed:        $${openingDollars.toFixed(2)}`);

        if (openingCents === 0) {
            console.log('  Opening balance is $0 — skipping (no entry needed).');
            importedIds.add(openingBalanceExternalId);
            saveImportedIds(importedIds);
            continue;
        }

        try {
            await postOpeningBalance(sureId, openingDollars, syncDate);
            importedIds.add(openingBalanceExternalId);
            saveImportedIds(importedIds);
            console.log(`  ✅ Posted opening balance of $${openingDollars.toFixed(2)}`);
            anyPosted = true;
        } catch (err) {
            console.error(`  ❌ Failed to post opening balance:`, err.response?.data || err.message);
        }
    }

    if (anyPosted) {
        console.log('\n✅ Done! Opening balances have been posted to Sure.');
        console.log('   Your Sure account balances should now match Up Bank.\n');
    } else {
        console.log('\nNo new opening balances were needed.\n');
    }
}

main().catch(err => {
    console.error('Fatal error:', err.response?.data || err.message);
    process.exit(1);
});
