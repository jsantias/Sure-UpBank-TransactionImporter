/**
 * Simple levelled logger.
 *
 * Usage:
 *   const log = require('../logger');   // from src/functions/
 *   const log = require('./src/logger'); // from project root
 *
 * Levels:
 *   log.debug(...)  — only printed when DEBUG=1 (or DEBUG=true / DEBUG=*)
 *   log.info(...)   — always printed (replaces console.log for structured output)
 *   log.warn(...)   — always printed
 *   log.error(...)  — always printed
 *
 * Enable debug output:
 *   DEBUG=1 node reconcile_full.js
 */

const DEBUG = ['1', 'true', '*'].includes((process.env.DEBUG || '').toLowerCase().trim());

function ts() {
    return new Date().toISOString();
}

const log = {
    isDebug: DEBUG,

    debug: DEBUG
        ? (...args) => console.debug(`[DEBUG ${ts()}]`, ...args)
        : () => {},

    info: (...args) => console.log(`[INFO  ${ts()}]`, ...args),

    warn: (...args) => console.warn(`[WARN  ${ts()}]`, ...args),

    error: (...args) => console.error(`[ERROR ${ts()}]`, ...args),
};

if (DEBUG) {
    log.debug('Debug logging enabled.');
}

module.exports = log;
