const axios = require('axios');
require('dotenv').config();

const UP_HEADERS = { 'Authorization': `Bearer ${process.env.UP_BANK_ACCESS_TOKEN}` };
const SURE_HEADERS = {
    'X-Api-Key': process.env.SURE_API_KEY,
    'Content-Type': 'application/json'
};

function sureUrl(path) {
    return `${(process.env.SURE_SERVER_URL || '').replace(/\/$/, '')}${path}`;
}

const UP_TYPE_LABEL = { TRANSACTIONAL: 'Spending', SAVER: 'Saver', HOME_LOAN: 'Home Loan' };

async function fetchUpAccounts() {
    const res = await axios.get('https://api.up.com.au/api/v1/accounts', { headers: UP_HEADERS });
    return res.data.data;
}

async function fetchSureAccounts() {
    const res = await axios.get(sureUrl('/api/v1/accounts'), { headers: SURE_HEADERS });
    return res.data.accounts;
}

async function main() {
    console.log('\nFetching accounts...\n');

    let upAccounts, sureAccounts;
    try {
        [upAccounts, sureAccounts] = await Promise.all([fetchUpAccounts(), fetchSureAccounts()]);
    } catch (err) {
        console.error('Failed to fetch accounts:', err.response?.data || err.message);
        process.exit(1);
    }

    const existingMapping = JSON.parse(process.env.UP_ACCOUNT_MAPPING || '{}');

    const matched = [];
    const unmatched = [];

    for (const upAccount of upAccounts) {
        const upId = upAccount.id;
        const upName = upAccount.attributes.displayName;
        const upType = UP_TYPE_LABEL[upAccount.attributes.accountType] || upAccount.attributes.accountType;

        // 1. Explicit mapping in env
        let sureId = existingMapping[upId];
        let sureAccount = sureId ? sureAccounts.find(a => a.id === sureId) : null;
        let matchSource = 'explicit mapping';

        // 2. Name match
        if (!sureAccount) {
            sureAccount = sureAccounts.find(a => a.name.toLowerCase() === upName.toLowerCase());
            if (sureAccount) {
                sureId = sureAccount.id;
                matchSource = 'name match';
            }
        }

        if (sureAccount) {
            matched.push({ upId, upName, upType, sureId, sureName: sureAccount.name, matchSource });
        } else {
            unmatched.push({ upId, upName, upType });
        }
    }

    // ── Matched accounts ────────────────────────────────────────────────────
    if (matched.length > 0) {
        console.log('✅ Matched accounts:\n');
        for (const m of matched) {
            console.log(`  Up Bank: ${m.upName} (${m.upType})`);
            console.log(`  Sure:    ${m.sureName} (ID: ${m.sureId})`);
            console.log(`  Via:     ${m.matchSource}\n`);
        }
    }

    // ── Unmatched accounts ───────────────────────────────────────────────────
    if (unmatched.length > 0) {
        console.log('❌ Unmatched Up Bank accounts (create these in Sure):\n');
        for (const u of unmatched) {
            console.log(`  ${u.upName}  (${u.upType})  [Up ID: ${u.upId}]`);
        }
        console.log('\n  In Sure: go to Accounts → New Account and create one for each above.');
        console.log('  Name them exactly the same to auto-match, or add them to UP_ACCOUNT_MAPPING below.\n');
    }

    // ── Generated mapping ────────────────────────────────────────────────────
    if (matched.length > 0) {
        const mapping = {};
        for (const m of matched) mapping[m.upId] = m.sureId;

        console.log('─────────────────────────────────────────────────────────');
        console.log('Generated UP_ACCOUNT_MAPPING (add to your .env if needed):');
        console.log('─────────────────────────────────────────────────────────');
        console.log(`UP_ACCOUNT_MAPPING='${JSON.stringify(mapping, null, 4)}'`);
    }

    // ── Sure accounts without a match ────────────────────────────────────────
    const matchedSureIds = new Set(matched.map(m => m.sureId));
    const unusedSure = sureAccounts.filter(a => !matchedSureIds.has(a.id));
    if (unusedSure.length > 0) {
        console.log('\n─────────────────────────────────────────────────────────');
        console.log('Sure accounts not matched to any Up Bank account:');
        for (const a of unusedSure) {
            console.log(`  ${a.name} (ID: ${a.id})`);
        }
    }

    if (unmatched.length === 0) {
        console.log('\n🎉 All Up Bank accounts are matched. You\'re ready to import!');
        console.log('   Run:  node update.js\n');
    } else {
        console.log(`\n⚠️  ${unmatched.length} account(s) need to be created in Sure before importing.\n`);
    }
}

main();
