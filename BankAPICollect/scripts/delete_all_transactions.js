/**
 * delete_all_transactions.js
 *
 * Fast two-phase delete:
 *   Phase 1 — Collect all Sure transaction IDs by fetching all pages in parallel.
 *   Phase 2 — Delete every ID with controlled concurrency (default 20 at a time).
 *
 * This is far faster than the old approach (fetch page → delete → fetch page → ...)
 * because all IDs are known upfront and deletions run concurrently.
 *
 * Usage:
 *   npm run delete-all
 */

const axios = require('axios');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const HEADERS = {
    'X-Api-Key': process.env.SURE_API_KEY,
    'Content-Type': 'application/json'
};
const CONCURRENCY = 20; // simultaneous delete requests
const PAGE_FETCH_CONCURRENCY = 10; // simultaneous page fetches

function sureUrl(p) {
    return `${(process.env.SURE_SERVER_URL || '').replace(/\/$/, '')}${p}`;
}

async function fetchPage(page) {
    const res = await axios.get(sureUrl('/api/v1/transactions'), {
        headers: HEADERS,
        params: { per_page: 100, page }
    });
    return res.data;
}

async function runConcurrently(tasks, concurrency) {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
        const batch = tasks.slice(i, i + concurrency);
        results.push(...await Promise.all(batch.map(t => t())));
    }
    return results;
}

async function main() {
    // ── Phase 1: Collect all IDs ─────────────────────────────────────────────
    console.log('Phase 1: Collecting all transaction IDs...');

    const firstPage = await fetchPage(1);
    const { total_pages: totalPages } = firstPage.data?.pagination ?? firstPage.pagination ?? {};

    if (!totalPages) {
        console.log('No transactions found.');
        return;
    }

    const allIds = firstPage.transactions.map(t => t.id);
    process.stdout.write(`\r  Fetched page 1/${totalPages} — ${allIds.length} IDs so far...`);

    if (totalPages > 1) {
        const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        await runConcurrently(
            remainingPages.map(page => async () => {
                const data = await fetchPage(page);
                const ids = data.transactions?.map(t => t.id) ?? [];
                allIds.push(...ids);
                process.stdout.write(`\r  Fetched page ${page}/${totalPages} — ${allIds.length} IDs so far...`);
            }),
            PAGE_FETCH_CONCURRENCY
        );
    }

    console.log(`\n  Collected ${allIds.length} transaction IDs.\n`);

    // ── Phase 2: Delete with concurrency ─────────────────────────────────────
    console.log(`Phase 2: Deleting ${allIds.length} transactions (${CONCURRENCY} at a time)...`);

    let deleted = 0;
    let failed = 0;

    await runConcurrently(
        allIds.map(id => async () => {
            try {
                await axios.delete(sureUrl(`/api/v1/transactions/${id}`), { headers: HEADERS });
                deleted++;
            } catch (err) {
                failed++;
                // Don't log 404s — already deleted by a prior run
                if (err.response?.status !== 404) {
                    console.error(`\n  Failed to delete ${id}:`, err.response?.data || err.message);
                }
            }
            process.stdout.write(`\r  Deleted ${deleted}/${allIds.length}...`);
        }),
        CONCURRENCY
    );

    console.log(`\n\nDone. Deleted ${deleted} transactions.${failed ? ` (${failed} failed — see above)` : ''}`);
}

main().catch(err => {
    console.error('Fatal error:', err.response?.data || err.message);
    process.exit(1);
});
