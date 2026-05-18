const BankAPILib = require('./src/functions/GetBankTransactions');
require('dotenv').config();

async function main() {
    try {
        const connection = await BankAPILib.AuthenticateUp();
        await BankAPILib.uploadTransactions(connection.data.data);
        console.log('Full import complete. Run node update.js for ongoing sync.');
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
