const axios = require('axios');
const fs = require('fs');
const path = require('path');
const log = require('../logger');

//=============================================================================
//                         Imported ID Tracking
//=============================================================================

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
    const filePath = trackingPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([...ids]));
}

//=============================================================================
//                         Exponential Backoff
//=============================================================================

const RETRY_DEFAULTS = {
    maxRetries: 10,
    baseDelay: 1000,
    // For 429 without Retry-After: Up Bank's limit resets within the hour,
    // so back off from 60s and cap at just over one hour.
    base429Delay: 60000,
    maxDelay: 3700000,
    retryOn: [null, 429, 500, 502, 503, 504]
};

async function withRetry(fn, options = {}) {
    const maxRetries   = options.maxRetries   ?? RETRY_DEFAULTS.maxRetries;
    const baseDelay    = options.baseDelay    ?? RETRY_DEFAULTS.baseDelay;
    const base429Delay = options.base429Delay ?? RETRY_DEFAULTS.base429Delay;
    const maxDelay     = options.maxDelay     ?? RETRY_DEFAULTS.maxDelay;
    const retryOn      = options.retryOn      ?? RETRY_DEFAULTS.retryOn;
    const label        = options.label        ?? 'request';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn();
            if (attempt > 0) log.debug(`[${label}] Succeeded on attempt ${attempt + 1}.`);
            return result;
        } catch (err) {
            const status = err.response?.status ?? null;
            const isRetryable = retryOn.includes(status);

            if (!isRetryable || attempt === maxRetries) {
                if (attempt > 0) {
                    log.error(`[${label}] Failed after ${attempt} retries (HTTP ${status ?? 'network error'}).`);
                }
                throw err;
            }

            let delayMs;
            if (status === 429 && err.response.headers?.['retry-after']) {
                delayMs = parseInt(err.response.headers['retry-after'], 10) * 1000;
                log.warn(`[${label}] Rate limited — waiting ${(delayMs / 1000).toFixed(0)}s (Retry-After). Attempt ${attempt + 1}/${maxRetries}.`);
            } else if (status === 429) {
                // No Retry-After header — rate limit resets within the hour, so back off from 60s.
                const jitter = Math.floor(Math.random() * 5000);
                delayMs = Math.min(base429Delay * 2 ** attempt, maxDelay) + jitter;
                log.warn(`[${label}] Rate limited — waiting ${(delayMs / 1000).toFixed(0)}s. Attempt ${attempt + 1}/${maxRetries}.`);
            } else {
                const jitter = Math.floor(Math.random() * 1000);
                delayMs = Math.min(baseDelay * 2 ** attempt, maxDelay) + jitter;
                const reason = status ? `HTTP ${status}` : 'network error';
                log.warn(`[${label}] ${reason} — retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries}).`);
            }

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

//=============================================================================
//                         Sure API Helpers
//=============================================================================

function sureHeaders() {
    return {
        'X-Api-Key': process.env.SURE_API_KEY,
        'Content-Type': 'application/json'
    };
}

function sureUrl(path) {
    const base = (process.env.SURE_SERVER_URL || '').replace(/\/$/, '');
    return `${base}${path}`;
}

async function getSureAccounts() {
    log.debug('Fetching Sure accounts...');
    const response = await withRetry(
        () => axios.get(sureUrl('/api/v1/accounts'), { headers: sureHeaders() }),
        { label: 'Sure accounts' }
    );
    log.debug(`Fetched ${response.data.accounts.length} Sure accounts.`);
    return response.data.accounts;
}

async function getSureCategories() {
    log.debug('Fetching Sure categories...');
    let allCategories = [];
    let page = 1;
    while (true) {
        const response = await withRetry(
            () => axios.get(sureUrl('/api/v1/categories'), { headers: sureHeaders(), params: { per_page: 100, page } }),
            { label: `Sure categories page ${page}` }
        );
        allCategories = [...allCategories, ...response.data.categories];
        if (page >= response.data.pagination.total_pages) break;
        page++;
    }
    log.debug(`Fetched ${allCategories.length} Sure categories.`);
    return allCategories;
}

// Normalise a Sure category name to the same slug format Up Bank uses.
// e.g. "TV & Music" → "tv-and-music", "Restaurants & Cafés" → "restaurants-and-cafes"
function toSlug(name) {
    return name
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
        .replace(/&/g, 'and')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function buildCategoryMap(sureCategories) {
    const map = new Map();
    for (const cat of sureCategories) {
        map.set(toSlug(cat.name), cat.id);
    }
    log.debug(`Built category map with ${map.size} entries.`);
    return map;
}

function resolveCategoryId(transaction, categoryMap) {
    if (categoryMap.size === 0) return undefined;
    const childSlug = transaction.relationships.category?.data?.id;
    const parentSlug = transaction.relationships.parentCategory?.data?.id;
    return (childSlug && categoryMap.get(childSlug))
        || (parentSlug && categoryMap.get(parentSlug))
        || undefined;
}

function buildNotes(transaction) {
    const parts = [];
    if (transaction.attributes.message) parts.push(transaction.attributes.message);
    if (transaction.attributes.note?.text) parts.push(transaction.attributes.note.text);
    return parts.length > 0 ? parts.join(' | ') : undefined;
}

async function postSureTransaction(transactionData) {
    log.debug(`POST transaction: external_id=${transactionData.external_id} amount=${transactionData.amount} nature=${transactionData.nature} date=${transactionData.date}`);
    // retryOn excludes 5xx: a server error may have already created the transaction
    // before the response was lost, so retrying could produce a duplicate.
    const response = await withRetry(
        () => axios.post(sureUrl('/api/v1/transactions'), { transaction: transactionData }, { headers: sureHeaders() }),
        { label: `Sure POST ${transactionData.external_id}`, maxRetries: 3, retryOn: [null, 429] }
    );
    return { created: response.status === 201, data: response.data };
}

// Sure updates its balance incrementally on POST (which can fall behind during bulk
// imports) but performs a full recalculation on DELETE. Posting then deleting a
// dummy transaction forces Sure to recompute the correct balance for the account.
async function flushSureAccountBalance(sureAccountId) {
    log.debug(`Flushing balance for Sure account ${sureAccountId}`);
    try {
        const dummy = await axios.post(
            sureUrl('/api/v1/transactions'),
            { transaction: { account_id: sureAccountId, date: '2000-01-01', amount: 0.01, name: '__balance_flush__', nature: 'income', source: 'upbank' } },
            { headers: sureHeaders() }
        );
        await new Promise(r => setTimeout(r, 2000));
        await axios.delete(sureUrl(`/api/v1/transactions/${dummy.data.id}`), { headers: sureHeaders() });
        await new Promise(r => setTimeout(r, 2000));
        log.debug(`Balance flush complete for ${sureAccountId}`);
    } catch (err) {
        log.warn(`Balance flush failed for ${sureAccountId}:`, err.response?.data || err.message);
    }
}

//=============================================================================
//                         Up Bank Helpers
//=============================================================================

async function AuthenticateUp() {
    log.debug('Authenticating with Up Bank...');
    const accessToken = process.env.UP_BANK_ACCESS_TOKEN;
    try {
        const result = await withRetry(
            () => axios.get('https://api.up.com.au/api/v1/accounts', {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            }),
            { label: 'Up Bank auth' }
        );
        log.debug(`Up Bank auth successful — ${result.data.data.length} accounts found.`);
        return result;
    } catch (error) {
        throw new Error('Error fetching Up Bank accounts: ' + error.message);
    }
}

async function getUpAccounts(connection) {
    console.log(connection.data.data);
}

async function getBudgetAccounts() {
    const accounts = await getSureAccounts();
    console.log('Available Sure Accounts:', accounts.map(a => `${a.name} (ID: ${a.id})`).join(', '));
}

function formatDate(attributes) {
    const timezoneOffset = parseInt(process.env.UTC_TIMEZONE_OFFSET || 0);
    const dateObj = new Date(attributes.settledAt || attributes.createdAt);
    dateObj.setHours(dateObj.getHours() + timezoneOffset);
    return dateObj.toISOString().split('T');
}

async function fetchTransactionsForAccount(accountId, accessToken) {
    let allTransactions = [];
    let nextPageUrl = `https://api.up.com.au/api/v1/accounts/${accountId}/transactions`;

    let syncStart = process.env.UP_BANK_SYNC_START;
    if (!syncStart) {
        syncStart = '2015-01-01T00:00:00Z';
    }

    log.debug(`Fetching transactions for account ${accountId} since ${syncStart}`);

    try {
        while (nextPageUrl) {
            const url = nextPageUrl;
            log.debug(`GET ${url}`);
            const response = await withRetry(
                () => axios.get(url, {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                    params: { 'page[size]': 100, 'filter[since]': syncStart, 'filter[status]': 'SETTLED' }
                }),
                { label: `Up Bank transactions ${accountId}` }
            );
            allTransactions = [...allTransactions, ...response.data.data];
            nextPageUrl = response.data.links.next || null;
            console.log(`Fetched ${allTransactions.length} transactions so far`);
        }
        log.debug(`Finished fetching account ${accountId} — ${allTransactions.length} total.`);
        return allTransactions;
    } catch (error) {
        log.error(`Error fetching transactions for account ${accountId}:`, error.response?.data || error.message);
        throw new Error(`Error fetching transactions for account ${accountId}: ${error.message}`);
    }
}

async function fetchAllTransactions(connection) {
    try {
        const accessToken = process.env.UP_BANK_ACCESS_TOKEN;
        const accounts = connection.data.data;
        let allTransactions = [];

        for (const account of accounts) {
            const transactions = await fetchTransactionsForAccount(account.id, accessToken);
            allTransactions = [...allTransactions, ...transactions];
        }
        return allTransactions;
    } catch (error) {
        throw new Error('Error fetching all transactions: ' + error.message);
    }
}

//=============================================================================
//                         Transaction Formatting
//=============================================================================

// external_id is stored in Sure for reference but not relied on for deduplication
// (Sure does not enforce uniqueness on it). Local tracking via imported_ids.json
// is the source of truth for preventing duplicate imports.
function buildSureTransaction(transaction, sureAccountId, categoryMap = new Map()) {
    const amountValue = parseFloat(transaction.attributes.amount.value);
    const category_id = resolveCategoryId(transaction, categoryMap);
    const notes = buildNotes(transaction);
    const built = {
        account_id: sureAccountId,
        date: formatDate(transaction.attributes)[0],
        amount: Math.abs(amountValue),
        name: transaction.attributes.description || 'Unknown',
        nature: amountValue < 0 ? 'expense' : 'income',
        external_id: transaction.id,
        source: 'upbank',
        ...(category_id && { category_id }),
        ...(notes && { notes })
    };
    log.debug(`Built transaction: ${built.external_id} "${built.name}" ${built.nature} $${built.amount} on ${built.date}${category_id ? ` [cat: ${category_id}]` : ''}`);
    return built;
}

async function importTransaction(sureTransaction) {
    try {
        const result = await postSureTransaction(sureTransaction);
        log.debug(`Import result for ${sureTransaction.external_id}: ${result.created ? 'created' : 'already exists'}`);
        return result.created ? 'created' : 'exists';
    } catch (err) {
        log.error(
            `Error importing transaction (external_id: ${sureTransaction.external_id}):`,
            err.response?.data || err.message
        );
        return 'error';
    }
}

//=============================================================================
//                         Full Import (startup)
//=============================================================================

async function uploadTransactions(accounts) {
    try {
        const importedIds = loadImportedIds();
        log.debug(`Loaded ${importedIds.size} already-imported IDs from tracking file.`);

        const [sureAccounts, sureCategories] = await Promise.all([getSureAccounts(), getSureCategories()]);
        const categoryMap = buildCategoryMap(sureCategories);
        const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
        const accessToken = process.env.UP_BANK_ACCESS_TOKEN;

        for (const account of accounts) {
            const upAccountId = account.id;
            const upAccountName = account.attributes.displayName;

            let sureAccountId = accountMapping[upAccountId];
            if (!sureAccountId) {
                const match = sureAccounts.find(a => a.name.toLowerCase() === upAccountName.toLowerCase());
                if (match) sureAccountId = match.id;
            }

            if (!sureAccountId) {
                log.warn(`No account mapping found for Up Account: ${upAccountName} (ID: ${upAccountId})`);
                console.log('Available Sure Accounts:', sureAccounts.map(a => `${a.name} (ID: ${a.id})`).join(', '));
                continue;
            }

            log.debug(`Processing account: ${upAccountName} (Up: ${upAccountId} → Sure: ${sureAccountId})`);
            const transactions = await fetchTransactionsForAccount(upAccountId, accessToken);
            let created = 0, skipped = 0, errors = 0;

            for (const transaction of transactions) {
                if (importedIds.has(transaction.id)) {
                    log.debug(`Skipping already-imported: ${transaction.id}`);
                    skipped++;
                    continue;
                }

                const result = await importTransaction(buildSureTransaction(transaction, sureAccountId, categoryMap));
                if (result === 'created') {
                    importedIds.add(transaction.id);
                    created++;
                } else if (result === 'exists') {
                    skipped++;
                } else {
                    errors++;
                }
            }

            saveImportedIds(importedIds);
            console.log(`${upAccountName}: ${created} created, ${skipped} already existed, ${errors} errors`);
            if (created > 0) {
                process.stdout.write(`  Flushing Sure balance for ${upAccountName}...`);
                await flushSureAccountBalance(sureAccountId);
                process.stdout.write('\r' + ' '.repeat(60) + '\r');
            }
        }
    } catch (error) {
        log.error('Error in uploadTransactions:', error);
        throw error;
    }
}

//=============================================================================
//                         Weekly Sync
//=============================================================================

async function fetchDateRangeTransactionsForAccount(accountId, accessToken, since) {
    let allTransactions = [];
    let nextPageUrl = `https://api.up.com.au/api/v1/accounts/${accountId}/transactions`;

    log.debug(`Fetching transactions for account ${accountId} since ${since}`);

    try {
        while (nextPageUrl) {
            const url = nextPageUrl;
            log.debug(`GET ${url}`);
            const response = await withRetry(
                () => axios.get(url, {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                    params: { 'page[size]': 100, 'filter[since]': since, 'filter[status]': 'SETTLED' }
                }),
                { label: `Up Bank transactions ${accountId}` }
            );
            allTransactions = [...allTransactions, ...response.data.data];
            nextPageUrl = response.data.links.next || null;
        }
        log.debug(`Finished fetching account ${accountId} — ${allTransactions.length} transactions.`);
        return allTransactions;
    } catch (error) {
        log.error(`Error fetching transactions for account ${accountId}:`, error.response?.data || error.message);
        throw new Error(`Error fetching transactions for account ${accountId}: ${error.message}`);
    }
}

async function fetchTransactionsForPastWeek(connection) {
    try {
        const accessToken = process.env.UP_BANK_ACCESS_TOKEN;
        const accounts = connection.data.data;
        let allTransactions = [];

        const oneWeekAgo = new Date(Date.now() - 24 * 7 * 60 * 60 * 1000).toISOString();
        const syncStart = process.env.UP_BANK_SYNC_START;
        const maxPullDate = (syncStart && syncStart > oneWeekAgo) ? syncStart : oneWeekAgo;

        log.debug(`Weekly sync pulling transactions since ${maxPullDate}`);

        for (const account of accounts) {
            try {
                const transactions = await fetchDateRangeTransactionsForAccount(account.id, accessToken, maxPullDate);
                log.debug(`${account.attributes.displayName}: ${transactions.length} transactions in window.`);
                allTransactions = [...allTransactions, ...transactions];
            } catch (accountError) {
                log.error(`Error processing account ${account.attributes.displayName}:`, accountError);
            }
        }
        return allTransactions;
    } catch (error) {
        log.error('Error fetching transactions for past week:', error);
        throw new Error('Error fetching transactions for past week: ' + error.message);
    }
}

async function uploadWeeklyTransactions(weeklyTransactions) {
    try {
        const importedIds = loadImportedIds();
        log.debug(`Loaded ${importedIds.size} already-imported IDs.`);

        const [sureAccounts, sureCategories] = await Promise.all([getSureAccounts(), getSureCategories()]);
        const categoryMap = buildCategoryMap(sureCategories);
        const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');

        const transactionsByAccount = weeklyTransactions.reduce((acc, transaction) => {
            const accountId = transaction.relationships.account.data.id;
            if (!acc[accountId]) acc[accountId] = [];
            acc[accountId].push(transaction);
            return acc;
        }, {});

        log.debug(`Weekly upload: ${weeklyTransactions.length} transactions across ${Object.keys(transactionsByAccount).length} accounts.`);

        for (const [upAccountId, transactions] of Object.entries(transactionsByAccount)) {
            let sureAccountId = accountMapping[upAccountId];

            if (!sureAccountId) {
                log.warn(`No account mapping found for Up Account ID: ${upAccountId}`);
                console.log('Available Sure Accounts:', sureAccounts.map(a => `${a.name} (ID: ${a.id})`).join(', '));
                continue;
            }

            log.debug(`Processing ${transactions.length} transactions for account ${upAccountId} → Sure ${sureAccountId}`);
            let created = 0, skipped = 0, errors = 0;

            for (const transaction of transactions) {
                if (importedIds.has(transaction.id)) {
                    log.debug(`Skipping already-imported: ${transaction.id}`);
                    skipped++;
                    continue;
                }

                const result = await importTransaction(buildSureTransaction(transaction, sureAccountId, categoryMap));
                if (result === 'created') {
                    importedIds.add(transaction.id);
                    created++;
                } else if (result === 'exists') {
                    skipped++;
                } else {
                    errors++;
                }
            }

            saveImportedIds(importedIds);
            console.log(`Account ${upAccountId}: ${created} created, ${skipped} already existed, ${errors} errors`);
            if (created > 0) {
                await flushSureAccountBalance(sureAccountId);
            }
        }
    } catch (error) {
        log.error('Error in uploadWeeklyTransactions:', error);
        throw error;
    }
}

//=============================================================================
//                         Balance Drift Check
//=============================================================================

function parseSureBalance(str) {
    if (str == null) return null;
    const n = parseFloat(str.replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? null : n;
}

async function fetchUpBankBalances() {
    const res = await withRetry(
        () => axios.get('https://api.up.com.au/api/v1/accounts', {
            headers: { Authorization: `Bearer ${process.env.UP_BANK_ACCESS_TOKEN}` }
        }),
        { label: 'Up Bank balance check' }
    );
    return new Map(res.data.data.map(a => [a.id, a]));
}

function computeDrift(upMap, sureMap, accountMapping, threshold) {
    const drifted = [];
    for (const [upId, sureId] of Object.entries(accountMapping)) {
        const upAcc = upMap.get(upId);
        const sureAcc = sureMap.get(sureId);
        if (!upAcc || !sureAcc) continue;

        const upBal = parseFloat(upAcc.attributes.balance.value);
        const sureRaw = parseSureBalance(sureAcc.balance) ?? 0;
        // Liability accounts (e.g. home loans) are stored as positive in Sure but
        // negative in Up Bank — flip the sign for comparison.
        const sureBal = sureAcc.classification === 'liability' ? -sureRaw : sureRaw;
        const diff = Math.round((upBal - sureBal) * 100) / 100;

        if (Math.abs(diff) > threshold) {
            drifted.push({ name: sureAcc.name, sureId, upBal, sureBal, diff });
        }
    }
    return drifted;
}

// Attempt to fix an account that Sure is short on (Up Bank > Sure).
// Reimports a 30-day window in case the weekly sync missed transactions.
// Returns the number of transactions recovered.
async function reimportRecentTransactions(upId, sureId, categoryMap) {
    const accessToken = process.env.UP_BANK_ACCESS_TOKEN;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const txns = await fetchDateRangeTransactionsForAccount(upId, accessToken, since);

    const importedIds = loadImportedIds();
    let created = 0;
    for (const txn of txns) {
        if (importedIds.has(txn.id)) continue;
        const result = await importTransaction(buildSureTransaction(txn, sureId, categoryMap));
        if (result === 'created') {
            importedIds.add(txn.id);
            created++;
        }
    }
    if (created > 0) saveImportedIds(importedIds);
    return created;
}

async function checkBalanceDrift(threshold = 0.01) {
    const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
    if (Object.keys(accountMapping).length === 0) return [];
    const sureToUp = Object.fromEntries(Object.entries(accountMapping).map(([k, v]) => [v, k]));

    log.debug('Running balance drift check...');

    let [upMap, sureAccounts] = await Promise.all([fetchUpBankBalances(), getSureAccounts()]);
    let sureMap = new Map(sureAccounts.map(a => [a.id, a]));
    let drifted = computeDrift(upMap, sureMap, accountMapping, threshold);

    if (drifted.length === 0) {
        log.info('Balance check passed — all accounts match Up Bank ✅');
        return [];
    }

    // Sure's reported balance can lag after bulk imports. Flush the drifting
    // accounts to force a recalculation, then re-check before acting.
    log.info(`Apparent drift on ${drifted.length} account(s) — flushing to confirm...`);
    for (const { sureId, name } of drifted) {
        log.debug(`Flushing ${name}...`);
        await flushSureAccountBalance(sureId);
    }

    [upMap, sureAccounts] = await Promise.all([fetchUpBankBalances(), getSureAccounts()]);
    sureMap = new Map(sureAccounts.map(a => [a.id, a]));
    drifted = computeDrift(upMap, sureMap, accountMapping, threshold);

    if (drifted.length === 0) {
        log.info('Balance drift resolved after flush — all accounts match Up Bank ✅');
        return [];
    }

    // Confirmed real drift — attempt auto-remediation per account.
    const [sureCategories] = await Promise.all([getSureCategories()]);
    const categoryMap = buildCategoryMap(sureCategories);

    for (const { name, sureId, upBal, sureBal, diff } of drifted) {
        const upId = sureToUp[sureId];
        const diffStr = `${diff > 0 ? '+' : ''}$${Math.abs(diff).toFixed(2)}`;
        log.warn(`[DRIFT] "${name}" — Up Bank: $${upBal.toFixed(2)}, Sure: $${sureBal.toFixed(2)}, diff: ${diffStr}`);

        if (diff > 0) {
            // Sure is missing value — try reimporting the past 30 days.
            log.info(`[REMEDIATE] "${name}" — reimporting past 30 days to recover missing transactions...`);
            const recovered = await reimportRecentTransactions(upId, sureId, categoryMap);
            if (recovered > 0) {
                await flushSureAccountBalance(sureId);
                log.info(`[REMEDIATE] "${name}" — recovered ${recovered} transaction(s). Re-run sync to verify.`);
            } else {
                // Nothing in the 30-day window — drift is older or is an opening balance issue.
                log.warn(`[REMEDIATE] "${name}" — no missing transactions found in past 30 days.`);
                log.warn(`  If this account predates your sync start date, run: node set_opening_balances.js`);
                log.warn(`  Otherwise run: node diagnose.js --detail`);
            }
        } else {
            // Sure has extra value — phantom transactions. Can't safely auto-delete
            // without external_id (Sure's API doesn't return it in list responses).
            log.warn(`[REMEDIATE] "${name}" — Sure has $${Math.abs(diff).toFixed(2)} extra. Manual steps:`);
            log.warn(`  1. node find_phantoms.js           # identify phantom transactions`);
            log.warn(`  2. node find_phantoms.js --delete  # remove them`);
        }
    }

    // Final check to report outcome.
    [upMap, sureAccounts] = await Promise.all([fetchUpBankBalances(), getSureAccounts()]);
    sureMap = new Map(sureAccounts.map(a => [a.id, a]));
    const stillDrifted = computeDrift(upMap, sureMap, accountMapping, threshold);

    if (stillDrifted.length === 0) {
        log.info('Auto-remediation successful — all accounts now match Up Bank ✅');
    } else {
        log.warn(`${stillDrifted.length} account(s) need manual attention. Run: node diagnose.js`);
    }

    return stillDrifted;
}

module.exports = {
    AuthenticateUp,
    getUpAccounts,
    getBudgetAccounts,
    fetchAllTransactions,
    uploadTransactions,
    fetchTransactionsForPastWeek,
    uploadWeeklyTransactions,
    checkBalanceDrift
};
