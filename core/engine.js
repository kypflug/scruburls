/*
 * ClearURLs (Manifest V3 port)
 * Copyright (c) 2017-2025 Kevin Röbert (original ClearURLs)
 * Copyright (c) 2026 ClearURLs MV3 port contributors
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
 * The ClearURLs cleaning engine: a side-effect free port of clearurls.js
 * (removeFieldsFormURL / clearUrl) and pureCleaning.js.
 *
 * The engine never talks to chrome.* APIs and never logs or counts on its own.
 * Instead every cleaning step is reported as an "action" so that the caller
 * (the service worker, the cleaning tool, the tests) can decide what to do with it.
 *
 * Action shape:
 *   { type: 'redirect'|'cancel'|'ping'|'rawRule'|'rule', provider, rule, before, after }
 */
import { Provider } from './provider.js';
import {
    checkLocalURL, countFields, decodeURL, extractFragments,
    urlWithoutParamsAndHash, urlSearchParamsToString, isDataURL
} from './tools.js';

export const DEFAULT_SETTINGS_FOR_ENGINE = {
    localHostsSkipping: true,
    referralMarketing: true,
    domainBlocking: true,
    pingBlocking: true,
    pingRequestTypes: ['ping'],
    types: []
};

/** Maximum number of cleaning passes before we give up (guards against rule ping-pong). */
const MAX_PASSES = 25;

export class Engine {
    /**
     * @param {() => object} getSettings returns the current settings object (see DEFAULT_SETTINGS_FOR_ENGINE)
     */
    constructor(getSettings = () => DEFAULT_SETTINGS_FOR_ENGINE) {
        this.getSettings = getSettings;
        this.providers = [];
        this.providerNames = [];
    }

    /**
     * (Re)creates the providers from a ClearURLs data.min.json object.
     * @param {{providers: object}} data
     */
    loadData(data) {
        this.providers = [];
        this.providerNames = [];
        if (!data || !data.providers) return;

        for (const name of Object.keys(data.providers)) {
            try {
                this.providers.push(Provider.fromJSON(name, data.providers[name]));
                this.providerNames.push(name);
            } catch (e) {
                console.error('[ClearURLs]: could not load provider ' + name, e);
            }
        }
    }

    hasProviders() {
        return this.providers.length > 0;
    }

    /**
     * Helper function which removes the tracking fields for the given provider.
     * Port of `removeFieldsFormURL`.
     *
     * @param {Provider} provider
     * @param {string} pureUrl
     * @return {{changes: boolean, url: string, redirect?: boolean, cancel?: boolean, actions: object[]}}
     */
    removeFieldsFromURL(provider, pureUrl) {
        const settings = this.getSettings();
        const actions = [];
        let url = pureUrl;
        let urlObject;

        try {
            urlObject = new URL(url);
        } catch (e) {
            return { changes: false, url, cancel: false, actions };
        }

        if (settings.localHostsSkipping && checkLocalURL(urlObject)) {
            return { changes: false, url, cancel: false, actions };
        }

        /*
         * Expand the url by provider redirections. So no tracking on
         * url redirections form sites to sites.
         */
        const re = provider.getRedirection(url);
        if (re !== null) {
            url = decodeURL(re);
            actions.push({ type: 'redirect', provider: provider.getName(), rule: 'redirect', before: pureUrl, after: url });
            return { changes: true, redirect: true, url, actions };
        }

        if (provider.isCanceling() && settings.domainBlocking) {
            actions.push({ type: 'cancel', provider: provider.getName(), rule: 'cancel', before: pureUrl, after: pureUrl });
            return { changes: false, cancel: true, url, actions };
        }

        let changes = false;

        /*
         * Apply raw rules to the URL.
         */
        for (const rawRule of provider.getRawRules()) {
            const beforeReplace = url;
            url = url.replace(new RegExp(rawRule, 'gi'), '');

            if (beforeReplace !== url) {
                actions.push({ type: 'rawRule', provider: provider.getName(), rule: rawRule, before: beforeReplace, after: url });
                changes = true;
            }
        }

        try {
            urlObject = new URL(url);
        } catch (e) {
            return { changes, url, cancel: false, actions };
        }

        const fields = urlObject.searchParams;
        const fragments = extractFragments(urlObject);
        const domain = urlWithoutParamsAndHash(urlObject).toString();

        /*
         * Only test for matches, if there are fields or fragments that can be cleaned.
         */
        if (fields.toString() !== '' || fragments.toString() !== '') {
            for (const rule of provider.getRules(settings.referralMarketing)) {
                const beforeFields = fields.toString();
                const beforeFragments = fragments.toString();
                let localChange = false;
                let ruleRegExp;

                try {
                    ruleRegExp = new RegExp('^' + rule + '$', 'i');
                } catch (e) {
                    continue;
                }

                for (const field of [...fields.keys()]) {
                    if (ruleRegExp.test(field)) {
                        fields.delete(field);
                        changes = true;
                        localChange = true;
                    }
                }

                for (const fragment of [...fragments.keys()]) {
                    if (ruleRegExp.test(fragment)) {
                        fragments.delete(fragment);
                        changes = true;
                        localChange = true;
                    }
                }

                if (localChange) {
                    let tempURL = domain;
                    let tempBeforeURL = domain;

                    if (fields.toString() !== '') tempURL += '?' + fields.toString();
                    if (fragments.toString() !== '') tempURL += '#' + fragments.toString();
                    if (beforeFields !== '') tempBeforeURL += '?' + beforeFields;
                    if (beforeFragments !== '') tempBeforeURL += '#' + beforeFragments;

                    actions.push({ type: 'rule', provider: provider.getName(), rule, before: tempBeforeURL, after: tempURL });
                }
            }

            let finalURL = domain;

            if (fields.toString() !== '') finalURL += '?' + urlSearchParamsToString(fields);
            if (fragments.toString() !== '') finalURL += '#' + fragments.toString();

            url = finalURL.replace(new RegExp('\\?&'), '?').replace(new RegExp('#&'), '#');
        }

        return { changes, url, actions };
    }

    /**
     * One cleaning pass in "request" mode: port of `clearUrl` from clearurls.js.
     * Returns after the first provider that changed something (the original
     * add-on re-entered the listener through the redirect it produced).
     *
     * @param {string} url
     * @param {{type?: string, method?: string}|null} request webRequest-like details
     */
    cleanOnce(url, request = null) {
        const settings = this.getSettings();
        const empty = { changes: false, url, redirect: false, cancel: false, actions: [] };

        if (isDataURL(url)) return empty;

        if (request && settings.pingBlocking && (settings.pingRequestTypes || []).includes(request.type)) {
            return {
                changes: false, url, redirect: false, cancel: true,
                actions: [{ type: 'ping', provider: '', rule: 'ping', before: url, after: url }]
            };
        }

        for (const provider of this.providers) {
            if (!provider.matchMethod(request)) continue;
            if (!provider.matchURL(url)) continue;

            const result = this.removeFieldsFromURL(provider, url);

            if (result.redirect) {
                return { changes: true, url: result.url, redirect: true, cancel: false, actions: result.actions };
            }

            if (result.cancel) {
                return { changes: false, url, redirect: false, cancel: true, actions: result.actions };
            }

            if (result.changes) {
                return { changes: true, url: result.url, redirect: false, cancel: false, actions: result.actions };
            }
        }

        return empty;
    }

    /**
     * Cleans a request URL completely, i.e. repeats `cleanOnce` until nothing
     * changes anymore, following redirections and stopping on a cancel.
     *
     * @param {string} url
     * @param {object|null} request
     * @return {{url: string, changes: boolean, redirect: boolean, cancel: boolean, actions: object[], fieldsBefore: number}}
     */
    cleanRequest(url, request = null) {
        const actions = [];
        const fieldsBefore = countFields(url);
        let current = url;
        let redirect = false;

        for (let pass = 0; pass < MAX_PASSES; pass++) {
            const result = this.cleanOnce(current, request);
            actions.push(...result.actions);

            if (result.cancel) {
                return { url: current, changes: current !== url, redirect, cancel: true, actions, fieldsBefore };
            }
            if (result.redirect) redirect = true;
            if (result.url === current) break;
            current = result.url;
        }

        return { url: current, changes: current !== url, redirect, cancel: false, actions, fieldsBefore };
    }

    /**
     * Internal function to clean the given URL (one pass over all providers).
     * Port of `_cleaning` from pureCleaning.js.
     */
    _cleaning(url, actions) {
        let cleanURL = url;

        for (const provider of this.providers) {
            if (!provider.matchURL(cleanURL)) continue;

            const result = this.removeFieldsFromURL(provider, cleanURL);
            actions.push(...result.actions.filter((action) => action.type !== 'cancel'));
            cleanURL = result.url;

            if (result.redirect) {
                return result.url;
            }
        }

        return cleanURL;
    }

    /**
     * Cleans the given URL. Also does automatic redirection. Port of `pureCleaning`.
     *
     * @param {string} url
     * @return {string} cleaned URL
     */
    pureCleaning(url) {
        return this.pureCleaningWithActions(url).url;
    }

    /**
     * Like {@link pureCleaning} but also returns the applied actions.
     */
    pureCleaningWithActions(url) {
        const actions = [];
        let before = url;
        let after = url;
        let passes = 0;

        do {
            before = after;
            after = this._cleaning(before, actions);
        } while (after !== before && ++passes < MAX_PASSES); // do recursive cleaning

        return { url: after, actions };
    }
}
