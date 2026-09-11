/*
 * ScrubURLs (unofficial Manifest V3 port of ClearURLs)
 * Copyright (c) 2017-2025 Kevin Röbert (original ClearURLs)
 * Copyright (c) 2026 ScrubURLs contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * Log and statistics helpers (port of pushToLog / increase*Counter from tools.js).
 */

// Max amount of log entries to prevent performance issues
export const LOG_THRESHOLD = 5000;

/**
 * Appends an entry to the global log (only when logging is activated).
 */
export function pushToLog(store, beforeProcessing, afterProcessing, rule) {
    const data = store.data;
    const limit = Math.max(0, Number(data.logLimit));

    if (!data.loggingStatus || limit === 0 || isNaN(limit)) return;

    if (!data.log || !Array.isArray(data.log.log)) {
        data.log = { log: [] };
    }

    while (data.log.log.length >= limit || data.log.log.length >= LOG_THRESHOLD) {
        data.log.log.shift();
    }

    data.log.log.push({
        before: beforeProcessing,
        after: afterProcessing,
        rule,
        timestamp: Date.now()
    });
    store.deferSave('log');
}

/**
 * Increase by {number} the total counter.
 */
export function increaseTotalCounter(store, number) {
    if (store.data.statisticsStatus && number > 0) {
        store.data.totalCounter += number;
        store.deferSave('totalCounter');
    }
}

/**
 * Increase by one the cleaned counter.
 */
export function increaseCleanedCounter(store) {
    if (store.data.statisticsStatus) {
        store.data.cleanedCounter++;
        store.deferSave('cleanedCounter');
    }
}
