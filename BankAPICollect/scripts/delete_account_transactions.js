/**
 * delete_account_transactions.js
 *
 * Deletes all Sure transactions for one or more specific accounts by name,
 * and removes their IDs from imported_ids.json so they can be reimported.
 *
 * Usage:
 *   npm run delete-account -- "Kyrie Savings" "Home Loan"
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const SURE_HEADERS = { 'X-Api-Key': process.env.SURE_API_KEY, 'Content-Type': 'application/json' };
const UP_HEADERS = { 'Authorization': `Bearer ${process.env.UP_BANK_ACCESS_TOKEN}` };
const CONCURRENCY = 10;

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

// base429Delay: starting wait on 429 (2s for Sure, 60s for Up Bank which resets hourly)
async function withRetry(fn, label = 'request', { base429Delay = 2000, maxDelay = 60000 } = {}) {
    const maxRetries = 10;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err.response?.status;
            const isLast = attempt === maxRetries;

            if (status === 429 && !isLast) {
                const retryAfter = err.response.headers?.['retry-after'];
                const delayMs = retryAfter
                    ? parseInt(retryAfter, 10) * 1000
                    : Math.min(base429Delay * 2 ** attempt, maxDelay) + Math.floor(Math.random() * 1000);
                process.stdout.write(`\n  [${label}] 429 — waiting ${(delayMs / 1000).toFixed(0)}s...\n`);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }

            if ((status === 500 || status === 502 || status === 503 || status === 504 || !status) && !isLast) {
                const delayMs = Math.min(1000 * 2 ** attempt, 30000) + Math.floor(Math.random() * 500);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }

            throw err;
        }
    }
}

async function runConcurrently(tasks, concurrency) {
    for (let i = 0; i < tasks.length; i += concurrency) {
        await Promise.all(tasks.slice(i, i + concurrency).map(t => t()));
    }
}

async function fetchSureAccounts() {
    const res = await axios.get(sureUrl('/api/v1/accounts'), { headers: SURE_HEADERS });
    return res.data.accounts;
}

async function fetchSureTransactionIds(sureAccountId) {
    let ids = [];
    let page = 1;

    while (true) {
        const res = await axios.get(sureUrl('/api/v1/transactions'), {
            headers: SURE_HEADERS,
            params: { per_page: 100, page, account_id: sureAccountId }
        });
        const { transactions, pagination } = res.data;
        if (!transactions || transactions.length === 0) break;
        ids.push(...transactions.map(t => t.id));
        process.stdout.write(`\r  Fetched ${ids.length} Sure transaction IDs...`);
        if (page >= pagination.total_pages) break;
        page++;
    }
    return ids;
}

// Sure doesn't return external_id in its list API, so we fetch Up Bank transaction IDs
// directly and remove them from imported_ids.json.
async function fetchUpBankIdsForAccount(upAccountId) {
    const ids = [];
    let nextUrl = `https://api.up.com.au/api/v1/accounts/${upAccountId}/transactions`;
    const syncStart = process.env.UP_BANK_SYNC_START || '2015-01-01T00:00:00Z';

    while (nextUrl) {
        const url = nextUrl;
        const res = await withRetry(
            () => axios.get(url, {
                headers: UP_HEADERS,
                params: { 'page[size]': 100, 'filter[since]': syncStart, 'filter[status]': 'SETTLED' }
            }),
            'Up Bank fetch',
            { base429Delay: 60000, maxDelay: 3700000 }  // Up Bank resets hourly
        );
        for (const t of res.data.data) {
            ids.push(t.id);
            ids.push(`${t.id}-cashback`);
        }
        nextUrl = res.data.links.next || null;
        process.stdout.write(`\r  Fetched ${ids.length} Up Bank IDs to clear...`);
    }
    return ids;
}

async function main() {
    const targetNames = process.argv.slice(2);
    if (targetNames.length === 0) {
        console.error('Usage: npm run delete-account -- "Account Name" ["Another Account"]');
        process.exit(1);
    }

    const sureAccounts = await fetchSureAccounts();
    const accountMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');
    // Build reverse map: Sure ID → Up Bank ID
    const sureToUp = Object.fromEntries(Object.entries(accountMapping).map(([upId, sureId]) => [sureId, upId]));

    const importedIds = loadImportedIds();

    for (const targetName of targetNames) {
        const account = sureAccounts.find(
            a => a.name.toLowerCase() === targetName.toLowerCase()
        );

        if (!account) {
            const names = sureAccounts.map(a => `  "${a.name}"`).join('\n');
            console.error(`\nAccount "${targetName}" not found in Sure. Available accounts:\n${names}`);
            continue;
        }

        console.log(`\nDeleting transactions for: ${account.name} (${account.id})`);

        // Step 1: Delete all Sure transactions for this account
        const sureIds = await fetchSureTransactionIds(account.id);
        console.log(`\n  Found ${sureIds.length} Sure transactions to delete.`);

        if (sureIds.length > 0) {
            let deleted = 0, failed = 0;
            await runConcurrently(
                sureIds.map(id => async () => {
                    try {
                        await withRetry(
                            () => axios.delete(sureUrl(`/api/v1/transactions/${id}`), { headers: SURE_HEADERS }),
                            `DELETE ${id}`
                        );
                        deleted++;
                    } catch (err) {
                        if (err.response?.status !== 404) {
                            failed++;
                            console.error(`\n  Failed to delete ${id}:`, err.response?.data || err.message);
                        }
                    }
                    process.stdout.write(`\r  Deleted ${deleted}/${sureIds.length}...`);
                }),
                CONCURRENCY
            );
            console.log(`\n  Deleted ${deleted} Sure transactions.${failed ? ` (${failed} failed)` : ''}`);
        }

        // Step 2: Clear Up Bank IDs from imported_ids.json via the Up Bank API
        // (Sure doesn't return external_id, so we go to Up Bank directly)
        const upAccountId = sureToUp[account.id];
        if (upAccountId) {
            console.log(`  Clearing Up Bank IDs from tracking file...`);
            try {
                const upIds = await fetchUpBankIdsForAccount(upAccountId);
                let cleared = 0;
                for (const id of upIds) {
                    if (importedIds.delete(id)) cleared++;
                }
                saveImportedIds(importedIds);
                console.log(`\n  Cleared ${cleared} IDs from imported_ids.json.`);
            } catch (err) {
                console.log(`\n  ⚠️  Up Bank rate limited — Sure transactions were deleted but imported_ids.json`);
                console.log(`      was not updated. Wait for the rate limit to reset, then run this script`);
                console.log(`      again for "${account.name}" — it will skip the already-empty Sure account`);
                console.log(`      and only clean up imported_ids.json.\n`);
            }
        } else {
            console.log(`  ⚠️  No Up Bank mapping found for this Sure account — imported_ids.json not updated.`);
        }
    }

    console.log('\nDone. Run npm run startup to reimport these accounts.\n');
}

main().catch(err => {
    console.error('Fatal error:', err.response?.data || err.message);
    process.exit(1);
});
