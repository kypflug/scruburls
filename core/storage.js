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
 * Settings store: port of core_js/storage.js.
 *
 * The values live in memory (`store.data`) and are written to
 * chrome.storage.local in the same string based format the original add-on
 * used, so exported `ClearURLs.conf` files stay compatible in both directions.
 */

export const CHROME_REQUEST_TYPES = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'
];

/** Keys that are internal bookkeeping of the MV3 port and never exported. */
export const INTERNAL_KEYS = ['dnrSignature', 'dnrCoverage', 'dnrStats', 'lastRulesCheck', 'lastRulesError'];

export const DEFAULT_HASH_URL = 'https://rules2.clearurls.xyz/rules.minify.hash';
export const DEFAULT_RULE_URL = 'https://rules2.clearurls.xyz/data.minify.json';

/**
 * Replace the old rule URLs with the new ones (kept for imported settings files).
 */
export function replaceOldURLs(url) {
    switch (url) {
        case 'https://raw.githubusercontent.com/KevinRoebert/ClearUrls/master/data/rules.hash?flush_cache=true':
        case 'https://gitlab.com/KevinRoebert/ClearUrls/raw/master/data/rules.hash':
        case 'https://gitlab.com/KevinRoebert/ClearUrls/-/jobs/artifacts/master/raw/rules.min.hash?job=hash%20rules':
        case 'https://gitlab.com/KevinRoebert/ClearUrls/-/jobs/artifacts/master/raw/rules.minify.hash?job=hash%20rules':
        case 'https://kevinroebert.gitlab.io/ClearUrls/data/rules.minify.hash':
            return DEFAULT_HASH_URL;
        case 'https://raw.githubusercontent.com/KevinRoebert/ClearUrls/master/data/data.json?flush_cache=true':
        case 'https://gitlab.com/KevinRoebert/ClearUrls/raw/master/data/data.json':
        case 'https://gitlab.com/KevinRoebert/ClearUrls/raw/master/data/data.min.json':
        case 'https://gitlab.com/KevinRoebert/ClearUrls/raw/master/data/data.minify.json':
        case 'https://gitlab.com/KevinRoebert/ClearUrls/-/jobs/artifacts/master/raw/data.minify.json?job=hash%20rules':
        case 'https://kevinroebert.gitlab.io/ClearUrls/data/data.minify.json':
            return DEFAULT_RULE_URL;
        default:
            return url;
    }
}

/**
 * Maps the numeric hash status of the original add-on to its i18n key.
 *  1 "up to date", 2 "updated", 3 "update available", 4 "error", 5 "something went wrong"
 */
export function hashStatusKey(statusCode) {
    switch (statusCode) {
        case 1: return 'hash_status_code_1';
        case 2: return 'hash_status_code_2';
        case 3: return 'hash_status_code_3';
        case 5: return 'hash_status_code_5';
        case 4:
        default: return 'hash_status_code_4';
    }
}

export class SettingsStore {
    /**
     * @param {object} [area] storage area with get/set/remove (defaults to chrome.storage.local)
     */
    constructor(area) {
        this.area = area || (globalThis.chrome && chrome.storage ? chrome.storage.local : null);
        this.data = {};
        this.pendingSaves = new Set();
        this.saveTimer = null;
        this.initSettings();
    }

    /**
     * Set default values for the settings.
     */
    initSettings() {
        const data = this.data;
        data.ClearURLsData = [];
        data.dataHash = '';
        data.badgedStatus = true;
        data.globalStatus = true;
        data.totalCounter = 0;
        data.cleanedCounter = 0;
        data.hashStatus = 'hash_status_code_4';
        data.loggingStatus = false;
        data.log = { log: [] };
        data.statisticsStatus = true;
        data.badged_color = '#ffa500';
        data.hashURL = DEFAULT_HASH_URL;
        data.ruleURL = DEFAULT_RULE_URL;
        data.contextMenuEnabled = true;
        data.historyListenerEnabled = true;
        data.localHostsSkipping = true;
        data.referralMarketing = true;
        data.logLimit = 100;
        data.domainBlocking = true;
        data.pingBlocking = true;
        data.eTagFiltering = false;
        data.watchDogErrorCount = 0;
        data.types = CHROME_REQUEST_TYPES.slice();
        data.pingRequestTypes = ['ping'];
        data.lastRulesCheck = 0;
        data.lastRulesError = '';
    }

    /**
     * Loads the persisted values on top of the defaults.
     */
    async load() {
        this.initSettings();
        const items = this.area ? await this.area.get(null) : {};
        for (const [key, value] of Object.entries(items || {})) {
            this.set(key, value, true);
        }
        return this.data;
    }

    get(key) {
        return this.data[key];
    }

    /**
     * Save the value under the key in RAM. Port of `setData`: values may arrive
     * as the string representation used on disk / in exported settings.
     *
     * @param {string} key
     * @param {*} value
     * @param {boolean} fromDisk true while loading (skips write-backs for migrations)
     */
    set(key, value, fromDisk = false) {
        switch (key) {
            case 'ClearURLsData':
            case 'log':
            case 'dnrCoverage':
            case 'dnrStats':
                this.data[key] = typeof value === 'string' ? safeParse(value, this.data[key]) : value;
                if (key === 'log' && (!this.data.log || !Array.isArray(this.data.log.log))) {
                    this.data.log = { log: [] };
                }
                break;
            case 'hashURL':
            case 'ruleURL':
                this.data[key] = replaceOldURLs(String(value));
                break;
            case 'types':
            case 'pingRequestTypes':
                this.data[key] = Array.isArray(value)
                    ? value.slice()
                    : String(value).split(',').map((type) => type.trim()).filter(Boolean);
                break;
            case 'logLimit':
                this.data[key] = Math.max(0, Number(value) || 0);
                break;
            case 'totalCounter':
            case 'cleanedCounter':
            case 'watchDogErrorCount':
            case 'lastRulesCheck':
                this.data[key] = Number(value) || 0;
                break;
            case 'globalurlcounter':
                // migrate from old key
                this.data.totalCounter = Number(value) || 0;
                this.forget(key);
                break;
            case 'globalCounter':
                // migrate from old key
                this.data.cleanedCounter = Number(value) || 0;
                this.forget(key);
                break;
            case 'badgedStatus':
            case 'globalStatus':
            case 'loggingStatus':
            case 'statisticsStatus':
            case 'contextMenuEnabled':
            case 'historyListenerEnabled':
            case 'localHostsSkipping':
            case 'referralMarketing':
            case 'domainBlocking':
            case 'pingBlocking':
            case 'eTagFiltering':
                this.data[key] = toBoolean(value);
                break;
            default:
                this.data[key] = value;
        }
    }

    forget(key) {
        delete this.data[key];
        if (this.area) {
            Promise.resolve(this.area.remove(key)).catch(() => {});
        }
    }

    /**
     * Converts a given storage value to its on-disk string representation.
     */
    dataAsString(key) {
        const value = this.data[key];

        switch (key) {
            case 'ClearURLsData':
            case 'log':
            case 'dnrCoverage':
            case 'dnrStats':
                return JSON.stringify(value);
            case 'types':
            case 'pingRequestTypes':
                return (value || []).join(',');
            default:
                return value;
        }
    }

    /**
     * Returns the storage as JSON (export format of the original add-on).
     */
    asJSON() {
        const json = {};
        for (const key of Object.keys(this.data)) {
            if (INTERNAL_KEYS.includes(key)) continue;
            json[key] = this.dataAsString(key);
        }
        return json;
    }

    /**
     * Save multiple keys on the disk.
     * @param {string[]} keys
     */
    async save(keys) {
        if (!this.area) return;
        const json = {};
        for (const key of keys) {
            if (this.data[key] === undefined) continue;
            json[key] = this.dataAsString(key);
        }
        await this.area.set(json);
    }

    /**
     * Writes the whole storage to the disk.
     */
    saveAll() {
        return this.save(Object.keys(this.data));
    }

    /**
     * Schedules a save of the key (coalesces bursts of counter updates).
     */
    deferSave(key, delay = 1000) {
        this.pendingSaves.add(key);
        if (this.saveTimer !== null) return;

        this.saveTimer = setTimeout(() => {
            const keys = [...this.pendingSaves];
            this.pendingSaves.clear();
            this.saveTimer = null;
            this.save(keys).catch((e) => console.error('[ScrubURLs ERROR]: ' + e));
        }, delay);
    }

    /**
     * Flushes deferred saves immediately.
     */
    async flush() {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        const keys = [...this.pendingSaves];
        this.pendingSaves.clear();
        if (keys.length) await this.save(keys);
    }

    /**
     * Stores the hash status (see {@link hashStatusKey}).
     */
    storeHashStatus(statusCode) {
        this.data.hashStatus = hashStatusKey(statusCode);
    }
}

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value === 'true';
    return Boolean(value);
}

function safeParse(text, fallback) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return fallback;
    }
}
