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

/**
 * A ClearURLs rule provider. Port of the `Provider` "supertype" from clearurls.js,
 * without the implicit dependency on the global `storage` object.
 */
export class Provider {
    /**
     * @param {string} name                 Provider name
     * @param {boolean} completeProvider    Block the whole provider (domain blocking)
     * @param {boolean} forceRedirection    Whether redirects should be enforced via a "tabs.update"
     */
    constructor(name, completeProvider = false, forceRedirection = false) {
        this.name = name;
        this.completeProvider = completeProvider;
        this.forceRedirection = forceRedirection;
        this.urlPattern = new RegExp('', 'i');
        this.urlPatternSource = '';
        this.rules = new Set();
        this.rawRules = new Set();
        this.referralMarketing = new Set();
        this.exceptions = [];
        this.redirections = [];
        this.methods = [];
        this._exceptionRegexps = [];
        this._redirectionRegexps = [];

        if (completeProvider) {
            this.rules.add('.*');
        }
    }

    /**
     * Builds a provider from one entry of the ClearURLs data.min.json file.
     * @param {string} name
     * @param {object} json
     */
    static fromJSON(name, json) {
        const provider = new Provider(name, json.completeProvider === true, json.forceRedirection === true);
        provider.setURLPattern(json.urlPattern || '');
        (json.rules || []).forEach((rule) => provider.addRule(rule));
        (json.rawRules || []).forEach((rule) => provider.addRawRule(rule));
        (json.referralMarketing || []).forEach((rule) => provider.addReferralMarketing(rule));
        (json.exceptions || []).forEach((exception) => provider.addException(exception));
        (json.redirections || []).forEach((redirection) => provider.addRedirection(redirection));
        (json.methods || []).forEach((method) => provider.addMethod(method));
        return provider;
    }

    getName() {
        return this.name;
    }

    shouldForceRedirect() {
        return this.forceRedirection;
    }

    /**
     * Return if requests to this provider are canceled (domain blocking).
     */
    isCanceling() {
        return this.completeProvider;
    }

    setURLPattern(urlPattern) {
        this.urlPatternSource = urlPattern;
        this.urlPattern = new RegExp(urlPattern, 'i');
    }

    /**
     * Check if the url matches the provider URL pattern and none of its exceptions.
     */
    matchURL(url) {
        return this.urlPattern.test(url) && !this.matchException(url);
    }

    addRule(rule) {
        this.rules.add(rule);
    }

    /**
     * Return all active rules (RegExp sources). When referral marketing protection
     * is disabled the referral marketing parameters are treated as normal rules.
     * @param {boolean} referralMarketingAllowed the `referralMarketing` setting
     */
    getRules(referralMarketingAllowed = true) {
        if (!referralMarketingAllowed) {
            return [...this.rules, ...this.referralMarketing];
        }
        return [...this.rules];
    }

    addRawRule(rule) {
        this.rawRules.add(rule);
    }

    getRawRules() {
        return [...this.rawRules];
    }

    addReferralMarketing(rule) {
        this.referralMarketing.add(rule);
    }

    getReferralMarketingRules() {
        return [...this.referralMarketing];
    }

    addException(exception) {
        this.exceptions.push(exception);
        this._exceptionRegexps.push(new RegExp(exception, 'i'));
    }

    getExceptions() {
        return [...this.exceptions];
    }

    addMethod(method) {
        if (this.methods.indexOf(method) === -1) {
            this.methods.push(method);
        }
    }

    getMethods() {
        return [...this.methods];
    }

    /**
     * Check the request's method.
     * @param {{method?: string}} details request details
     */
    matchMethod(details) {
        if (!this.methods.length || !details) return true;
        return this.methods.indexOf(details.method) > -1;
    }

    /**
     * Check if the url matches one of the exceptions.
     */
    matchException(url) {
        return this._exceptionRegexps.some((regexp) => regexp.test(url));
    }

    addRedirection(redirection) {
        this.redirections.push(redirection);
        this._redirectionRegexps.push(new RegExp(redirection, 'i'));
    }

    getRedirections() {
        return [...this.redirections];
    }

    /**
     * Return the redirection target (first capture group) or null.
     */
    getRedirection(url) {
        for (const regexp of this._redirectionRegexps) {
            const result = regexp.exec(url);
            if (result && result.length > 1 && result[1] !== undefined) {
                return result[1];
            }
        }
        return null;
    }
}
