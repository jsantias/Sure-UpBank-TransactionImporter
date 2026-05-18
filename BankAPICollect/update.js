const BankAPILib = require('./src/functions/GetBankTransactions');
const fs = require('fs');
require('dotenv').config();
const cron = require('node-cron');
const log = require('./src/logger');

function trackingFileExists() {
    return fs.existsSync(process.env.DATA_PATH || './imported_ids.json');
}

async function printAccounts() {
    try {
        const UpResponse = await BankAPILib.AuthenticateUp();
        console.log("========================================================================================");
        console.log("===========================Up Accounts==================================================");
        console.log("========================================================================================");
        await BankAPILib.getUpAccounts(UpResponse);
        console.log("========================================================================================");
        console.log("===========================Sure Accounts================================================");
        console.log("========================================================================================");
        await BankAPILib.getBudgetAccounts();
    } catch (error) {
        console.error('Error in printAccounts:', error);
    }
}

async function fullImport() {
    try {
        await printAccounts();
        const connection = await BankAPILib.AuthenticateUp();
        await BankAPILib.uploadTransactions(connection.data.data);
    } catch (error) {
        console.error('Error in fullImport:', error);
    }
}

async function weeklyUpdate() {
    try {
        const connection = await BankAPILib.AuthenticateUp();
        const transactions = await BankAPILib.fetchTransactionsForPastWeek(connection);
        await BankAPILib.uploadWeeklyTransactions(transactions);
        await BankAPILib.checkBalanceDrift();
    } catch (error) {
        console.error('Error in weeklyUpdate:', error);
    }
}

// Only run the full history import on first launch (no tracking file yet).
// On restarts the weekly update cron catches up on any missed transactions.
if (trackingFileExists()) {
    log.debug('Tracking file found — skipping full import, running weekly sync now to catch up.');
    console.log('Tracking file found — skipping full import, running weekly sync now to catch up.');
    weeklyUpdate();
} else {
    log.debug('No tracking file found — running full import.');
    console.log('No tracking file found — running full import.');
    fullImport();
}

const scheduleExpr = process.env.CRON_SCHEDULE || '0 * * * *';
if (!cron.validate(scheduleExpr)) {
    console.error('Invalid CRON_SCHEDULE expression. Please check your environment variable.');
    process.exit(1);
}
cron.schedule(scheduleExpr, weeklyUpdate);
console.log(`Cron job scheduled: ${scheduleExpr}`);
