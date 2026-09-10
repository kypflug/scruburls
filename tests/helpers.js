import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadRulesData() {
    return JSON.parse(fs.readFileSync(path.join(root, 'data', 'data.minify.json'), 'utf8'));
}

export function loadManifest() {
    return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
}

export const TEST_SETTINGS = {
    localHostsSkipping: true,
    referralMarketing: true,
    domainBlocking: true,
    pingBlocking: true,
    eTagFiltering: true,
    pingRequestTypes: ['ping'],
    types: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
};

/**
 * Stand-in for chrome.declarativeNetRequest.isRegexSupported: accepts every
 * regex the JavaScript engine accepts, and rejects the RE2-incompatible
 * constructs we know about (look-arounds, back references).
 */
export async function fakeIsRegexSupported({ regex, isCaseSensitive }) {
    if (/\(\?[=!<]|\\[1-9]/.test(regex)) {
        return { isSupported: false, reason: 'syntaxError' };
    }
    try {
        new RegExp(regex, isCaseSensitive ? '' : 'i');
    } catch (e) {
        return { isSupported: false, reason: 'syntaxError' };
    }
    if (regex.length > 1500) {
        return { isSupported: false, reason: 'memoryLimitExceeded' };
    }
    return { isSupported: true };
}

/**
 * Simulates how Chrome evaluates the compiled rules for one request:
 * highest priority wins, allow beats block beats redirect on ties, redirects are re-evaluated.
 */
export function simulateDNR(rules, url, type = 'main_frame', method = 'get') {
    const actionRank = { allow: 3, block: 2, redirect: 1 };
    let current = url;

    for (let hop = 0; hop < 30; hop++) {
        let best = null;

        for (const rule of rules) {
            if (rule.action.type === 'modifyHeaders') continue;
            const cond = rule.condition;
            if (cond.resourceTypes && !cond.resourceTypes.includes(type)) continue;
            if (cond.requestMethods && !cond.requestMethods.includes(method)) continue;
            if (cond.excludedRequestDomains && cond.excludedRequestDomains.includes(new URL(current).hostname)) continue;

            let match = null;
            if (cond.regexFilter !== undefined) {
                match = new RegExp(cond.regexFilter, cond.isUrlFilterCaseSensitive ? '' : 'i').exec(current);
                if (!match) continue;
            }

            if (!best || rule.priority > best.rule.priority
                || (rule.priority === best.rule.priority && actionRank[rule.action.type] > actionRank[best.rule.action.type])) {
                best = { rule, match };
            }
        }

        if (!best) return { url: current, hops: hop };
        const { rule, match } = best;

        if (rule.action.type === 'allow') return { url: current, hops: hop, allowed: true };
        if (rule.action.type === 'block') return { url: current, hops: hop, blocked: true };

        let next;
        if (rule.action.redirect.extensionPath) {
            return { url: 'chrome-extension://id' + rule.action.redirect.extensionPath, hops: hop + 1, blockPage: true };
        } else if (rule.action.redirect.transform) {
            const parsed = new URL(current);
            for (const key of rule.action.redirect.transform.queryTransform.removeParams) parsed.searchParams.delete(key);
            next = parsed.toString();
        } else {
            const substitution = rule.action.redirect.regexSubstitution.replace(/\\(\d)/g, (_, n) => match[Number(n)] || '');
            next = current.slice(0, match.index) + substitution + current.slice(match.index + match[0].length);
        }

        if (next === current) return { url: current, hops: hop, stuck: rule.id };
        current = next;
    }

    return { url: current, hops: 30, tooManyHops: true };
}
