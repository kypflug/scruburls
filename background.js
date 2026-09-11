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
 * Service worker of ScrubURLs (unofficial Manifest V3 port of ClearURLs).
 *
 * Responsibilities:
 *  - load settings and rules, build the cleaning engine
 *  - compile the rules into declarativeNetRequest dynamic rules (the network level cleaning)
 *  - observe requests (non blocking) for statistics, log and badge, and fix top level
 *    navigations the DNR rules cannot express (redirect trackers, fragments, unsupported regexes)
 *  - history API cleaning, context menu, badge, icon, rule updates, watchdog
 *  - message API for the popup / options / log / cleaning tool pages
 */
import { Engine } from './core/engine.js';
import { SettingsStore } from './core/storage.js';
import { compile, fitRules, actionsCovered } from './core/dnr_compiler.js';
import { pushToLog, increaseTotalCounter, increaseCleanedCounter } from './core/log.js';
import { countFields, sha256, isDataURL, isEmpty } from './core/tools.js';

const BLOCK_PAGE_PATH = '/html/siteBlockedAlert.html';
const CONTEXT_MENU_ID = 'copy-link-to-clipboard';
const RULES_ALARM = 'clearurls-rules-update';
const WATCHDOG_ALARM = 'clearurls-watchdog';
const RULES_CHECK_INTERVAL_MINUTES = 360;
const RULES_CHECK_MIN_AGE_MS = 60 * 60 * 1000;
const WATCHDOG_INTERVAL_MINUTES = 60;
const WATCHDOG_DIRTY_URL = 'https://clearurls.roebert.eu?utm_source=addon';
const WATCHDOG_CLEAN_URL = new URL('https://clearurls.roebert.eu').toString();
const CHAIN_TTL_MS = 10000;
const FIX_LIMIT_PER_TAB = 4;
const FIX_WINDOW_MS = 10000;

const store = new SettingsStore();
const engine = new Engine(() => store.data);

let coverage = null;
let dnrLock = Promise.resolve();

/** Per tab badge counters (mirrored into chrome.storage.session). */
const badges = new Map();
/** URL of the last request that was blocked per tab (for the blocked page). */
const blockedSources = new Map();
/** Recently seen (tab, type, cleaned url) keys, used to recognise DNR redirect chains. */
const recentChains = new Map();
/** Loop guard for tabs.update / replaceState fixes. */
const fixHistory = new Map();

const translate = (key, ...placeholders) => chrome.i18n.getMessage(key, placeholders);

function handleError(error) {
    console.error('[ScrubURLs ERROR]: ' + (error && error.message ? error.message : error));
}

/* ----------------------------------------------------------------------------
 * Initialisation
 * ------------------------------------------------------------------------- */

const ready = init().catch((error) => {
    handleError(error);
});

async function init() {
    await store.load();

    if (!hasRulesData()) {
        await loadBundledRules();
    }

    engine.loadData(store.data.ClearURLsData);
    coverage = store.data.dnrCoverage || null;

    try {
        const session = await chrome.storage.session.get(['badges', 'blockedSources']);
        for (const [tabId, entry] of Object.entries(session.badges || {})) badges.set(Number(tabId), entry);
        for (const [tabId, url] of Object.entries(session.blockedSources || {})) blockedSources.set(Number(tabId), url);
    } catch (e) {
        // storage.session is optional
    }

    await ensureDynamicRules();
    await Promise.all([setIcon(), setBadgeColor(), setupContextMenu(), setupAlarms()]);

    checkForRulesUpdate().catch(handleError);
}

function hasRulesData() {
    const data = store.data.ClearURLsData;
    return data && typeof data === 'object' && data.providers && !isEmpty(data.providers);
}

/**
 * Loads the rules shipped with the extension (used on first start and as offline fallback).
 */
async function loadBundledRules() {
    try {
        const [dataResponse, hashResponse] = await Promise.all([
            fetch(chrome.runtime.getURL('data/data.minify.json')),
            fetch(chrome.runtime.getURL('data/rules.minify.hash'))
        ]);
        const text = (await dataResponse.text()).trim();
        store.data.ClearURLsData = JSON.parse(text);
        store.data.dataHash = (await hashResponse.text()).trim() || await sha256(text);
        store.storeHashStatus(1);
        await store.save(['ClearURLsData', 'dataHash', 'hashStatus']);
    } catch (error) {
        handleError(error);
        store.data.ClearURLsData = { providers: {} };
        store.storeHashStatus(5);
    }
}

/* ----------------------------------------------------------------------------
 * declarativeNetRequest
 * ------------------------------------------------------------------------- */

function dnrSignature() {
    const s = store.data;
    return JSON.stringify([
        chrome.runtime.getManifest().version, s.dataHash, s.globalStatus, s.domainBlocking, s.pingBlocking,
        s.eTagFiltering, s.referralMarketing, s.localHostsSkipping, s.types
    ]);
}

/**
 * (Re)compiles the DNR rules if the rules data or a relevant setting changed.
 */
function ensureDynamicRules(force = false) {
    dnrLock = dnrLock.then(() => updateDynamicRules(force)).catch(handleError);
    return dnrLock;
}

async function updateDynamicRules(force) {
    const signature = dnrSignature();
    const existing = await chrome.declarativeNetRequest.getDynamicRules();

    if (!force && store.data.dnrSignature === signature && (existing.length > 0 || !store.data.globalStatus)) {
        return;
    }

    if (!store.data.globalStatus || !hasRulesData()) {
        if (existing.length) {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((rule) => rule.id) });
        }
        coverage = null;
        store.data.dnrCoverage = null;
        store.data.dnrStats = { rules: 0, disabled: true };
        store.data.dnrSignature = signature;
        await store.save(['dnrCoverage', 'dnrStats', 'dnrSignature']);
        return;
    }

    const dnr = chrome.declarativeNetRequest;
    const compiled = compile({ data: store.data.ClearURLsData, settings: store.data, blockPagePath: BLOCK_PAGE_PATH });
    const { rules, coverage: newCoverage, stats } = await fitRules(compiled, {
        isRegexSupported: (request) => dnr.isRegexSupported(request),
        limits: {
            maxRules: dnr.MAX_NUMBER_OF_DYNAMIC_RULES || 30000,
            maxUnsafeRules: dnr.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES || 5000,
            maxRegexRules: dnr.MAX_NUMBER_OF_REGEX_RULES || 1000
        }
    });

    stats.failedRules = await applyDynamicRules(rules, existing.map((rule) => rule.id));
    stats.compiledAt = Date.now();

    coverage = newCoverage;
    store.data.dnrCoverage = newCoverage;
    store.data.dnrStats = stats;
    store.data.dnrSignature = signature;
    await store.save(['dnrCoverage', 'dnrStats', 'dnrSignature']);

    console.log('[ScrubURLs]: compiled ' + stats.rules + ' declarativeNetRequest rules (' + stats.regexRules + ' regex) for '
        + stats.compiledProviders + '/' + stats.providers + ' providers');
}

/**
 * Replaces the dynamic rule set. Falls back to smaller batches if Chrome rejects the whole set.
 * @return {number} number of rules that could not be added
 */
async function applyDynamicRules(rules, removeRuleIds) {
    const dnr = chrome.declarativeNetRequest;

    try {
        await dnr.updateDynamicRules({ removeRuleIds, addRules: rules });
        return 0;
    } catch (error) {
        console.warn('[ScrubURLs]: bulk rule update failed, retrying in batches: ' + error.message);
    }

    await dnr.updateDynamicRules({ removeRuleIds });
    let failed = 0;

    for (let i = 0; i < rules.length; i += 50) {
        const batch = rules.slice(i, i + 50);
        try {
            await dnr.updateDynamicRules({ addRules: batch });
        } catch (batchError) {
            for (const rule of batch) {
                try {
                    await dnr.updateDynamicRules({ addRules: [rule] });
                } catch (ruleError) {
                    failed++;
                    console.warn('[ScrubURLs]: dropping rule ' + rule.id + ': ' + ruleError.message, rule);
                }
            }
        }
    }

    return failed;
}

/* ----------------------------------------------------------------------------
 * Request observation (statistics, log, badge, fallback for top level navigations)
 * ------------------------------------------------------------------------- */

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        handleRequest(details).catch(handleError);
    },
    { urls: ['<all_urls>'] }
);

async function handleRequest(details) {
    await ready;
    const settings = store.data;
    const type = details.type;
    const isMainFrame = type === 'main_frame';

    if (isDataURL(details.url) || !/^(https?|wss?|ftp):/i.test(details.url)) return;
    if (!settings.types.includes(type) && !settings.pingRequestTypes.includes(type)) return;

    // Add fields from the request to the global url counter
    increaseTotalCounter(store, countFields(details.url));

    if (!settings.globalStatus) return;

    const needEngine = isMainFrame || settings.statisticsStatus || settings.loggingStatus || settings.badgedStatus;
    if (!needEngine) return;

    const result = engine.cleanRequest(details.url, details);
    if (!result.actions.length) return;

    // Only actions that really take effect are counted: redirections of sub resources
    // cannot be applied in Manifest V3, so everything from the first redirect on is skipped.
    let actions = result.actions;
    if (!isMainFrame) {
        const firstRedirect = actions.findIndex((action) => action.type === 'redirect');
        if (firstRedirect !== -1) actions = actions.slice(0, firstRedirect);
    }

    const chainKey = details.tabId + '|' + type + '|' + (result.cancel ? 'cancel:' : '') + result.url;
    const now = Date.now();
    pruneMap(recentChains, now - CHAIN_TTL_MS);
    const isChainContinuation = recentChains.has(chainKey);
    recentChains.set(chainKey, now);

    if (!isChainContinuation) {
        for (const action of actions) {
            recordAction(action, details);
        }
    }

    if (!isMainFrame || details.tabId < 0) return;

    if (result.cancel && actions.some((action) => action.type === 'cancel')) {
        rememberBlockedSource(details.tabId, details.url);
        await fixTab(details.tabId, chrome.runtime.getURL(BLOCK_PAGE_PATH.slice(1)) + '?source=' + encodeURIComponent(details.url));
        return;
    }

    if (result.url !== details.url && (result.redirect || !actionsCovered(actions, coverage))) {
        await fixTab(details.tabId, result.url);
    }
}

/**
 * Applies the side effects (log, statistics, badge) of one cleaning action.
 */
function recordAction(action, request) {
    switch (action.type) {
        case 'redirect':
            pushToLog(store, action.before, action.after, translate('log_redirect'));
            increaseTotalCounter(store, 1);
            break;
        case 'cancel':
            pushToLog(store, action.before, action.before, translate('log_domain_blocked'));
            increaseTotalCounter(store, 1);
            break;
        case 'ping':
            pushToLog(store, action.before, action.before, translate('log_ping_blocked'));
            increaseTotalCounter(store, 1);
            break;
        default:
            pushToLog(store, action.before, action.after, action.rule);
    }

    increaseBadged(request);
}

function pruneMap(map, olderThan) {
    for (const [key, timestamp] of map) {
        if (timestamp < olderThan) map.delete(key);
    }
}

/**
 * Navigates the tab to the given URL, with a loop guard.
 */
async function fixTab(tabId, url) {
    if (!allowFix(tabId)) return;
    try {
        await chrome.tabs.update(tabId, { url });
    } catch (error) {
        handleError(error);
    }
}

function allowFix(tabId) {
    const now = Date.now();
    const entry = fixHistory.get(tabId);

    if (!entry || now - entry.since > FIX_WINDOW_MS) {
        fixHistory.set(tabId, { since: now, count: 1 });
        return true;
    }

    entry.count++;
    if (entry.count > FIX_LIMIT_PER_TAB) {
        console.warn('[ScrubURLs]: too many fixes for tab ' + tabId + ', giving up to prevent a loop');
        return false;
    }
    return true;
}

function rememberBlockedSource(tabId, url) {
    blockedSources.set(tabId, url);
    persistSession('blockedSources', blockedSources);
}

function persistSession(key, map) {
    try {
        chrome.storage.session.set({ [key]: Object.fromEntries(map) }).catch(() => {});
    } catch (e) {
        // ignore
    }
}

/* ----------------------------------------------------------------------------
 * Navigation safety net & history listener
 * ------------------------------------------------------------------------- */

chrome.webNavigation.onCommitted.addListener((details) => {
    handleCommitted(details).catch(handleError);
});

/**
 * After a top level navigation committed, re-check the final URL: the DNR
 * rules may not cover everything (fragments, unsupported regexes, exceptions).
 */
async function handleCommitted(details) {
    await ready;
    if (details.frameId !== 0 || !store.data.globalStatus || !/^https?:/i.test(details.url)) return;

    const cleaned = engine.pureCleaning(details.url);
    if (cleaned === details.url) return;

    if (stripHash(cleaned) === stripHash(details.url)) {
        // Only the fragment differs: no reload necessary.
        await replaceState(details.tabId, details.frameId, cleaned);
    } else {
        await fixTab(details.tabId, cleaned);
    }
}

function stripHash(url) {
    const index = url.indexOf('#');
    return index === -1 ? url : url.slice(0, index);
}

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    historyCleaner(details).catch(handleError);
});

/**
 * Cleans links that were pushed to the history stack with history.replaceState /
 * pushState (a technique used to inject tracking code into the location bar).
 */
async function historyCleaner(details) {
    await ready;
    if (!store.data.historyListenerEnabled || !store.data.globalStatus) return;
    if (!/^https?:/i.test(details.url)) return;

    const urlAfter = engine.pureCleaning(details.url);
    if (urlAfter !== details.url) {
        await replaceState(details.tabId, details.frameId, urlAfter);
    }
}

async function replaceState(tabId, frameId, url) {
    if (!allowFix(tabId)) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            injectImmediately: true,
            func: (cleanUrl) => {
                history.replaceState(history.state, '', cleanUrl);
            },
            args: [url]
        });
    } catch (error) {
        console.log('[ScrubURLs] Error: ' + error.message);
    }
}

/* ----------------------------------------------------------------------------
 * Badge & icon
 * ------------------------------------------------------------------------- */

function increaseBadged(request) {
    increaseCleanedCounter(store);

    if (!request || request.tabId === undefined || request.tabId < 0) return;

    const tabId = request.tabId;
    const entry = badges.get(tabId);

    if (!entry) {
        badges.set(tabId, { counter: 1, lastURL: request.url });
    } else {
        entry.counter += 1;
    }

    const text = store.data.badgedStatus ? String(badges.get(tabId).counter) : '';
    chrome.action.setBadgeText({ text, tabId }).catch(() => {});
    persistSession('badges', badges);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tabInfo) => {
    const entry = badges.get(tabId);
    if (!entry || !changeInfo.url) return;

    if (entry.lastURL !== changeInfo.url) {
        badges.set(tabId, { counter: 0, lastURL: tabInfo.url });
        persistSession('badges', badges);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    badges.delete(tabId);
    blockedSources.delete(tabId);
    fixHistory.delete(tabId);
});

async function setIcon() {
    const enabled = store.data.globalStatus;
    const path = enabled
        ? { 16: '/img/scruburls_16x16.png', 32: '/img/scruburls_32x32.png', 48: '/img/scruburls_48x48.png', 128: '/img/scruburls_128x128.png' }
        : { 128: '/img/scruburls_gray_128x128.png' };
    try {
        await chrome.action.setIcon({ path });
    } catch (error) {
        handleError(error);
    }
}

async function setBadgeColor() {
    let color = String(store.data.badged_color || '#ffa500');
    if (color.charAt(0) !== '#') color = '#' + color;
    try {
        await chrome.action.setBadgeBackgroundColor({ color });
        await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
    } catch (error) {
        handleError(error);
    }
}

/* ----------------------------------------------------------------------------
 * Context menu
 * ------------------------------------------------------------------------- */

async function setupContextMenu() {
    try {
        await chrome.contextMenus.removeAll();
        if (store.data.contextMenuEnabled) {
            chrome.contextMenus.create({
                id: CONTEXT_MENU_ID,
                title: translate('clipboard_copy_link'),
                contexts: ['link']
            });
        }
    } catch (error) {
        handleError(error);
    }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab).catch(handleError);
});

async function handleContextMenuClick(info, tab) {
    await ready;
    if (info.menuItemId !== CONTEXT_MENU_ID || !info.linkUrl || !tab) return;

    const url = engine.pureCleaning(info.linkUrl);

    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [info.frameId || 0] },
            func: copyToClipboard,
            args: [url]
        });
    } catch (error) {
        console.error('Failed to copy text: ' + error.message);
    }
}

/**
 * Injected into the page: copies the text to the clipboard.
 * Based on https://github.com/mdn/webextensions-examples/tree/master/context-menu-copy-link-with-types
 */
function copyToClipboard(text) {
    function fallback() {
        function oncopy(event) {
            document.removeEventListener('copy', oncopy, true);
            event.stopImmediatePropagation();
            event.preventDefault();
            event.clipboardData.setData('text/plain', text);
        }
        document.addEventListener('copy', oncopy, true);
        document.execCommand('copy');
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(fallback);
    } else {
        fallback();
    }
}

/* ----------------------------------------------------------------------------
 * Rule updates & watchdog (alarms)
 * ------------------------------------------------------------------------- */

async function setupAlarms() {
    try {
        const [rulesAlarm, watchdogAlarm] = await Promise.all([chrome.alarms.get(RULES_ALARM), chrome.alarms.get(WATCHDOG_ALARM)]);
        if (!rulesAlarm) await chrome.alarms.create(RULES_ALARM, { periodInMinutes: RULES_CHECK_INTERVAL_MINUTES });
        if (!watchdogAlarm) await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_INTERVAL_MINUTES });
    } catch (error) {
        handleError(error);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    ready.then(() => {
        if (alarm.name === RULES_ALARM) return checkForRulesUpdate(true);
        if (alarm.name === WATCHDOG_ALARM) return watchdog();
        return undefined;
    }).catch(handleError);
});

/**
 * Get the hash for the rule file. If it differs from the local one, download the new rule file.
 * Port of getHash() / fetchFromURL().
 */
async function checkForRulesUpdate(force = false) {
    const settings = store.data;

    if (!force && Date.now() - (settings.lastRulesCheck || 0) < RULES_CHECK_MIN_AGE_MS) return settings.hashStatus;

    settings.lastRulesCheck = Date.now();
    settings.lastRulesError = '';
    await store.save(['lastRulesCheck', 'lastRulesError']);

    try {
        const hashResponse = await fetch(settings.hashURL, { cache: 'no-store' });
        if (hashResponse.status !== 200) throw new Error('hash download failed with status ' + hashResponse.status);
        const remoteHash = (await hashResponse.text()).trim();
        if (!remoteHash) throw new Error('the given hash was empty');

        if (remoteHash === String(settings.dataHash || '').trim() && hasRulesData()) {
            store.storeHashStatus(1);
            await store.save(['hashStatus']);
            return settings.hashStatus;
        }

        const rulesResponse = await fetch(settings.ruleURL, { cache: 'no-store' });
        if (rulesResponse.status !== 200) throw new Error('rules download failed with status ' + rulesResponse.status);
        const text = (await rulesResponse.text()).trim();
        if (!text) throw new Error('the given rules were empty');
        const hash = await sha256(text);

        if (hash !== remoteHash) {
            store.storeHashStatus(3);
            console.error('The hash does not match. Expected `' + remoteHash + '` got `' + hash + '`');
            await store.save(['hashStatus']);
            return settings.hashStatus;
        }

        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !parsed.providers) throw new Error('invalid rules file');

        settings.ClearURLsData = parsed;
        settings.dataHash = hash;
        store.storeHashStatus(2);
        engine.loadData(parsed);
        await store.save(['ClearURLsData', 'dataHash', 'hashStatus']);
        await ensureDynamicRules();
    } catch (error) {
        console.error('[ScrubURLs]: Could not download the rules from the given URL due to the following error: ', error);
        settings.lastRulesError = String(error && error.message ? error.message : error);
        if (!hasRulesData()) {
            await loadBundledRules();
            engine.loadData(settings.ClearURLsData);
            await ensureDynamicRules();
        }
        await store.save(['lastRulesError']);
    }

    return settings.hashStatus;
}

/**
 * Checks in fixed intervals that ClearURLs works properly (port of watchdog.js).
 */
async function watchdog() {
    const settings = store.data;
    if (!settings.globalStatus) return;

    let healthy = engine.hasProviders();

    if (healthy) {
        try {
            healthy = new URL(engine.pureCleaning(WATCHDOG_DIRTY_URL)).toString() === WATCHDOG_CLEAN_URL;
        } catch (e) {
            healthy = false;
        }
    }

    if (healthy) {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        if (!rules.length) {
            await ensureDynamicRules(true);
        }
        if (settings.watchDogErrorCount > 0) {
            settings.watchDogErrorCount = 0;
            await store.save(['watchDogErrorCount']);
        }
        return;
    }

    settings.watchDogErrorCount += 1;
    console.log(translate('watchdog', String(settings.watchDogErrorCount)));
    await store.save(['watchDogErrorCount']);

    if (settings.watchDogErrorCount < 3) {
        chrome.runtime.reload();
    }
}

/* ----------------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener((details) => {
    ready.then(async () => {
        await setupAlarms();
        await setupContextMenu();
        if (details.reason === 'install' || details.reason === 'update') {
            await ensureDynamicRules(true);
        }
    }).catch(handleError);
});

/* ----------------------------------------------------------------------------
 * Message API for the extension pages
 * ------------------------------------------------------------------------- */

const messageHandlers = {
    getData: ([key]) => store.get(key),
    setData: ([key, value]) => {
        store.set(key, value);
        return true;
    },
    saveOnDisk: async ([keys]) => {
        await store.save(keys || []);
        return true;
    },
    saveOnExit: async () => {
        await store.saveAll();
        await applySettings();
        return true;
    },
    applySettings: async () => {
        await store.saveAll();
        await applySettings();
        return true;
    },
    initSettings: async () => {
        store.initSettings();
        await loadBundledRules();
        engine.loadData(store.data.ClearURLsData);
        return true;
    },
    resetAll: async () => {
        await chrome.storage.local.clear();
        store.initSettings();
        await loadBundledRules();
        engine.loadData(store.data.ClearURLsData);
        await store.saveAll();
        await ensureDynamicRules(true);
        await applySettings();
        checkForRulesUpdate(true).catch(handleError);
        return true;
    },
    reload: () => {
        setTimeout(() => chrome.runtime.reload(), 100);
        return true;
    },
    changeIcon: () => setIcon(),
    setBadgedStatus: () => setBadgeColor(),
    storageAsJSON: () => store.asJSON(),
    pureCleaning: ([url]) => engine.pureCleaning(url),
    getBrowser: () => 'Chrome',
    getCurrentURL: () => '',
    checkForUpdates: () => checkForRulesUpdate(true),
    getDNRStatus: async () => {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        return {
            stats: store.data.dnrStats || null,
            activeRules: rules.length,
            providers: engine.providers.length,
            lastRulesCheck: store.data.lastRulesCheck,
            lastRulesError: store.data.lastRulesError
        };
    },
    getBlockedSource: (params, sender) => {
        const tabId = sender && sender.tab ? sender.tab.id : -1;
        return blockedSources.get(tabId) || '';
    }
};

async function applySettings() {
    await ensureDynamicRules();
    await Promise.all([setIcon(), setBadgeColor(), setupContextMenu()]);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request.function !== 'string') return false;

    (async () => {
        await ready;
        const handler = Object.prototype.hasOwnProperty.call(messageHandlers, request.function)
            ? messageHandlers[request.function]
            : null;
        if (!handler) throw new Error('Unknown function: ' + request.function);
        const response = await handler(Array.isArray(request.params) ? request.params : [], sender);
        sendResponse({ response });
    })().catch((error) => {
        handleError(error);
        sendResponse({ error: String(error && error.message ? error.message : error) });
    });

    return true;
});
