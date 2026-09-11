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
 * Compiles ClearURLs providers into chrome.declarativeNetRequest (DNR) rules.
 *
 * Manifest V3 removed blocking webRequest listeners, so the network-level
 * cleaning has to be expressed declaratively. The mapping is:
 *
 *   provider.rules (parameter names)
 *     - literal names, or regexes with a small finite language  -> redirect + queryTransform.removeParams
 *     - unbounded regexes (e.g. `utm_[a-z_]*`)                    -> redirect + regexSubstitution (one parameter per redirect hop)
 *   provider.rawRules                                            -> redirect + regexSubstitution
 *   provider.completeProvider (domain blocking)                  -> block (sub resources) / redirect to the blocked page (main_frame)
 *   provider.exceptions                                          -> allow rules
 *   provider.redirections                                        -> NOT compiled (the target must be URL-decoded, DNR cannot do that);
 *                                                                   handled by the service worker for top level navigations
 *   ping blocking                                                -> block rule for the "ping" resource type
 *   ETag filtering                                               -> modifyHeaders rule removing the ETag response header
 *
 * Priorities: DNR "allow" rules suppress every block/redirect rule with a lower
 * or equal priority. To keep the semantics of provider exceptions as local as
 * possible, the global provider (`.*`) gets the lowest priority, providers
 * with exceptions come next (each with its own priority), providers without
 * exceptions sit above them. Every rule of a provider carries a guard which
 * guarantees that it only matches when it will actually change the URL, so a
 * "no-op redirect" can never shadow another provider's rule.
 */
import { expandRegex, isLiteralRule } from './regex_expand.js';
import { escapeRegExp } from './tools.js';

export const DNR_RESOURCE_TYPES = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
    'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'
];

/**
 * Well known tracking parameters. They are matched against the unbounded regex
 * rules of every provider; every hit becomes a cheap literal `removeParams`
 * entry so that the common case is cleaned in a single redirect hop.
 */
export const COMMON_TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_cid',
    'utm_reader', 'utm_referrer', 'utm_social', 'utm_social-type', 'utm_brand', 'utm_place', 'utm_keyword',
    'utm_creative', 'utm_pubreferrer', 'utm_swu', 'utm_viz_id', 'utm_campaign_id', 'utm_source_platform',
    'utm_creative_format', 'utm_marketing_tactic', 'utm',
    'mtm_source', 'mtm_medium', 'mtm_campaign', 'mtm_keyword', 'mtm_content', 'mtm_cid', 'mtm_group', 'mtm_placement', 'mtm',
    'ga_source', 'ga_medium', 'ga_term', 'ga_content', 'ga_campaign', 'ga_place',
    'otm_source', 'otm_medium', 'otm_campaign', 'otm_term', 'otm_content',
    'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'twclid', 'srsltid', 'wickedid', 'rb_clickid',
    '_ga', '_gl', 'mc_eid', 'mc_cid', 'mc_tc', 'mkt_tok', 'spm', 's_cid', 'cmpid', 'wt_mc', 'wt_zmc', 'wtrid',
    '_openstat', 'gs_l', 'tracking_source', 'ceneo_spo', 'os_ehash', '__twitter_impression',
    'itm_source', 'itm_medium', 'itm_campaign', 'hmb_campaign', 'hmb_medium', 'hmb_source',
    'vero_conv', 'vero_id', 'oly_anon_id', 'oly_enc_id', '__hsfp', '__hssc', '__hstc', '_hsenc', '__s',
    'hsCtaTracking', 'ml_subscriber', 'ml_subscriber_hash',
    'action_object_map', 'action_type_map', 'action_ref_map', 'fb_action_types', 'fb_action_ids', 'fb_source', 'fb_ref',
    'ref', 'ref_', 'referrer', 'ref_src', 'refsrc', 'src', 'pd_rd_i', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p', 'pf_rd_r',
    'pf_rd_i', 'pf_rd_m', 'pf_rd_s', 'pf_rd_t', 'sr', 'srs', 'gws_rd', 'gs_lcp', 'gs_ssp', 'gfe_rd', 'ei', 'sxsrf', 'ved',
    'cid', 'lid', 'pid', 'iid', 'colid', 'coliid', 'mc', 'cmc', 'emc', 'xtor'
];

const PING_PRIORITY = 90000;
const ETAG_PRIORITY = 90001;

/** Chunk sizes for the alternations inside generated regexes (kept small because of the RE2 2KB limit). */
const LITERAL_CHUNK = 20;
const REGEX_CHUNK = 6;
const EXCEPTION_CHUNK = 4;

function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) {
        out.push(list.slice(i, i + size));
    }
    return out;
}

function unique(list) {
    return [...new Set(list)];
}

/**
 * Converts every capturing group of a RegExp source into a non-capturing group,
 * so that the generated rules can rely on their own group numbering.
 */
export function normalizeGroups(source) {
    let out = '';
    let inClass = false;

    for (let i = 0; i < source.length; i++) {
        const c = source[i];

        if (c === '\\') {
            out += c + (source[i + 1] === undefined ? '' : source[i + 1]);
            i++;
            continue;
        }

        if (inClass) {
            if (c === ']') inClass = false;
            out += c;
            continue;
        }

        if (c === '[') {
            inClass = true;
            out += c;
            continue;
        }

        if (c === '(' && source[i + 1] !== '?') {
            out += '(?:';
            continue;
        }

        out += c;
    }

    return out;
}

/**
 * Returns true if the given provider URL pattern matches everything.
 */
export function isGlobalPattern(urlPattern) {
    return urlPattern === '' || urlPattern === '.*' || urlPattern === '^.*' || urlPattern === '.*?' || urlPattern === '^.*?';
}

/**
 * Turns a provider URL pattern into the prefix used inside the generated
 * "query" regexes: capturing groups are neutralised and trailing wildcards or a
 * trailing literal `?` (e.g. `\/s\?`) are dropped, because the generated regex
 * appends its own `[^#]*?[?&]` separator matcher.
 */
export function queryPrefix(urlPattern) {
    if (isGlobalPattern(urlPattern)) return '';

    let prefix = normalizeGroups(urlPattern);
    prefix = prefix.replace(/(?:\.\*\??)+$/, '');
    prefix = prefix.replace(/\\\?$/, '');
    prefix = prefix.replace(/(?:\.\*\??)+$/, '');
    return prefix;
}

/**
 * Maps the ClearURLs `types` setting onto valid DNR resource types.
 */
export function mapResourceTypes(types) {
    const mapped = unique((types || []).filter((type) => DNR_RESOURCE_TYPES.includes(type)));
    return mapped.length ? mapped : DNR_RESOURCE_TYPES.slice();
}

/**
 * Prefix used instead of the (empty) global URL pattern when local hosts are skipped:
 * it requires at least one letter inside the authority part of the URL, which rules
 * out plain IPv4 hosts. `localhost` is excluded via `excludedRequestDomains`.
 */
function localHostGuardPrefix(caseSensitive) {
    return caseSensitive ? '^[a-z]+://[^/?#]*[a-zA-Z]' : '^[a-z]+://[^/?#]*[a-z]';
}

/**
 * Builds the compile context for one provider.
 */
function providerContext(name, json, settings, priority) {
    const urlPattern = json.urlPattern || '';
    const isGlobal = isGlobalPattern(urlPattern);
    const prefix = queryPrefix(urlPattern);
    const methods = (json.methods || []).map((method) => method.toLowerCase());
    const condition = {};

    if (methods.length) condition.requestMethods = methods;
    if (settings.localHostsSkipping) condition.excludedRequestDomains = ['localhost'];

    return { name, json, settings, priority, urlPattern, isGlobal, prefix, baseCondition: condition };
}

function prefixFor(ctx, caseSensitive) {
    if (ctx.prefix === '' && ctx.settings.localHostsSkipping) {
        return localHostGuardPrefix(caseSensitive);
    }
    return ctx.prefix;
}

/**
 * Generates the entries (rule + metadata) for one provider.
 *
 * Entry shape: { kind, items, build(items) -> DNR rule (without id) }
 * Items carry `from` (the original ClearURLs rule they cover) so that the
 * coverage information can be computed after fitting/splitting.
 */
export function compileProvider(name, json, settings, priority, options = {}) {
    const ctx = providerContext(name, json, settings, priority);
    const resourceTypes = mapResourceTypes(settings.types);
    const hints = options.hintParams || COMMON_TRACKING_PARAMS;
    const blockPagePath = options.blockPagePath || '/html/siteBlockedAlert.html';
    const essential = [];
    const optional = [];
    const itemCount = new Map();
    const covers = { rules: new Set(), rawRules: new Set() };

    const cond = (extra) => Object.assign({}, ctx.baseCondition, extra);

    // ---------------------------------------------------------------- exceptions -> allow
    for (const exceptions of chunk(json.exceptions || [], EXCEPTION_CHUNK)) {
        essential.push({
            kind: 'exception',
            items: exceptions.map((exception) => ({ key: exception, from: null })),
            build: (items) => ({
                priority,
                action: { type: 'allow' },
                condition: cond({
                    regexFilter: '(?:' + items.map((item) => normalizeGroups(item.key)).join('|') + ')',
                    isUrlFilterCaseSensitive: false,
                    resourceTypes: DNR_RESOURCE_TYPES.slice()
                })
            })
        });
    }

    // ---------------------------------------------------------------- domain blocking
    if (json.completeProvider === true) {
        if (settings.domainBlocking) {
            const regexFilter = normalizeGroups(ctx.urlPattern);
            const subResourceTypes = resourceTypes.filter((type) => type !== 'main_frame');

            if (subResourceTypes.length) {
                optional.push({
                    kind: 'block',
                    items: null,
                    build: () => ({
                        priority,
                        action: { type: 'block' },
                        condition: cond({ regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: subResourceTypes })
                    })
                });
            }

            if (resourceTypes.includes('main_frame')) {
                optional.push({
                    kind: 'blockPage',
                    items: null,
                    build: () => ({
                        priority,
                        action: { type: 'redirect', redirect: { extensionPath: blockPagePath } },
                        condition: cond({ regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] })
                    })
                });
            }
        }

        // Complete providers have the single rule ".*" which is meaningless as a query rule.
        return finishProvider(ctx, essential, optional, itemCount, covers);
    }

    // ---------------------------------------------------------------- raw rules
    for (const rawRule of json.rawRules || []) {
        const prefix = prefixFor(ctx, false);
        optional.push({
            kind: 'rawRule',
            items: [{ key: rawRule, from: 'raw:' + rawRule }],
            build: () => ({
                priority,
                action: { type: 'redirect', redirect: { regexSubstitution: '\\1' } },
                condition: cond({
                    regexFilter: '(' + prefix + '.*?)(?:' + normalizeGroups(rawRule) + ')',
                    isUrlFilterCaseSensitive: false,
                    resourceTypes
                })
            })
        });
        itemCount.set('raw:' + rawRule, 1);
    }

    // ---------------------------------------------------------------- parameter rules
    const rules = [...(json.rules || [])];
    if (!settings.referralMarketing) {
        rules.push(...(json.referralMarketing || []));
    }

    const literalItems = [];
    const regexRules = [];

    for (const rule of unique(rules)) {
        if (isLiteralRule(rule)) {
            literalItems.push({ key: rule, from: rule });
            itemCount.set(rule, 1);
            continue;
        }

        const expanded = expandRegex(rule);
        if (expanded !== null) {
            for (const key of expanded) {
                literalItems.push({ key, from: rule });
            }
            itemCount.set(rule, expanded.length);
            continue;
        }

        regexRules.push(rule);
        itemCount.set(rule, 2); // form A + form B

        // Cheap literal fast path for the well known parameters covered by this regex.
        let ruleRegExp;
        try {
            ruleRegExp = new RegExp('^' + rule + '$', 'i');
        } catch (e) {
            continue;
        }
        for (const hint of hints) {
            for (const candidate of [hint, '%3F' + hint]) {
                if (ruleRegExp.test(candidate)) {
                    literalItems.push({ key: candidate, from: null });
                }
            }
        }
    }

    // Deduplicate literal keys (keep the first "from" so coverage stays intact).
    const seenKeys = new Set();
    const literals = literalItems.filter((item) => {
        if (seenKeys.has(item.key)) return false;
        seenKeys.add(item.key);
        return true;
    });

    for (const items of chunk(literals, LITERAL_CHUNK)) {
        optional.push({
            kind: 'removeParams',
            items,
            build: (chunkItems) => {
                const prefix = prefixFor(ctx, true);
                const keys = chunkItems.map((item) => item.key);
                return {
                    priority,
                    action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: keys } } } },
                    condition: cond({
                        regexFilter: prefix + '[^#]*?[?&](?:' + keys.map(escapeRegExp).join('|') + ')(?:=|&|$)',
                        isUrlFilterCaseSensitive: true,
                        resourceTypes
                    })
                };
            }
        });
    }

    for (const items of chunk(regexRules.map((rule) => ({ key: rule, from: rule })), REGEX_CHUNK)) {
        const prefix = prefixFor(ctx, false);
        const alternation = (chunkItems) => '(?:' + chunkItems.map((item) => normalizeGroups(item.key)).join('|') + ')';

        // Form A: the parameter is followed by another parameter.
        optional.push({
            kind: 'regexParamA',
            items,
            build: (chunkItems) => ({
                priority,
                action: { type: 'redirect', redirect: { regexSubstitution: '\\1' } },
                condition: cond({
                    regexFilter: '(' + prefix + '[^#]*?[?&])' + alternation(chunkItems) + '(?:=[^&#]*)?&',
                    isUrlFilterCaseSensitive: false,
                    resourceTypes
                })
            })
        });

        // Form B: the parameter is the last one.
        optional.push({
            kind: 'regexParamB',
            items,
            build: (chunkItems) => ({
                priority,
                action: { type: 'redirect', redirect: { regexSubstitution: '\\1\\2' } },
                condition: cond({
                    regexFilter: '(' + prefix + '[^#]*?)[?&]' + alternation(chunkItems) + '(?:=[^&#]*)?(#.*)?$',
                    isUrlFilterCaseSensitive: false,
                    resourceTypes
                })
            })
        });
    }

    return finishProvider(ctx, essential, optional, itemCount, covers);
}

function finishProvider(ctx, essential, optional, itemCount, covers) {
    return {
        provider: ctx.name,
        priority: ctx.priority,
        isGlobal: ctx.isGlobal,
        essential,
        optional,
        itemCount,
        covers,
        hasRedirections: (ctx.json.redirections || []).length > 0
    };
}

/**
 * Orders providers and assigns priorities.
 * @return {Array<{name: string, json: object, priority: number}>}
 */
export function orderProviders(data) {
    const names = Object.keys(data.providers || {});
    const withExceptions = [];
    const withoutExceptions = [];
    let globalName = null;

    for (const name of names) {
        const json = data.providers[name];
        if (isGlobalPattern(json.urlPattern || '')) {
            globalName = globalName === null ? name : globalName;
            continue;
        }
        if ((json.exceptions || []).length) {
            withExceptions.push(name);
        } else {
            withoutExceptions.push(name);
        }
    }

    withExceptions.sort();
    withoutExceptions.sort();

    const ordered = [];
    let priority = 1;
    if (globalName !== null) {
        ordered.push({ name: globalName, json: data.providers[globalName], priority: priority++ });
    }
    for (const name of withExceptions) {
        ordered.push({ name, json: data.providers[name], priority: priority++ });
    }
    const sharedPriority = priority;
    for (const name of withoutExceptions) {
        ordered.push({ name, json: data.providers[name], priority: sharedPriority });
    }
    return ordered;
}

/**
 * Compiles the whole data set. Returns the provider groups in "importance"
 * order (the order in which they are fitted into the rule budget) plus the
 * global rules (ping blocking, ETag filtering).
 */
export function compile({ data, settings, blockPagePath, hintParams }) {
    const groups = [];
    for (const { name, json, priority } of orderProviders(data)) {
        groups.push(compileProvider(name, json, settings, priority, { blockPagePath, hintParams }));
    }

    const weight = (group) => {
        if (group.isGlobal) return Number.MAX_SAFE_INTEGER;
        const isBlock = group.optional.some((entry) => entry.kind === 'block' || entry.kind === 'blockPage');
        return (isBlock ? 100000 : 0) + group.optional.length * 10 + group.essential.length;
    };
    groups.sort((a, b) => weight(b) - weight(a));

    const globalRules = [];

    if (settings.pingBlocking) {
        globalRules.push({
            kind: 'ping',
            items: null,
            build: () => ({
                priority: PING_PRIORITY,
                action: { type: 'block' },
                condition: { resourceTypes: ['ping'] }
            })
        });
    }

    if (settings.eTagFiltering) {
        const condition = { resourceTypes: DNR_RESOURCE_TYPES.slice() };
        if (settings.localHostsSkipping) {
            condition.regexFilter = localHostGuardPrefix(true);
            condition.isUrlFilterCaseSensitive = true;
            condition.excludedRequestDomains = ['localhost'];
        }
        globalRules.push({
            kind: 'etag',
            items: null,
            build: () => ({
                priority: ETAG_PRIORITY,
                action: { type: 'modifyHeaders', responseHeaders: [{ header: 'etag', operation: 'remove' }] },
                condition
            })
        });
    }

    return { groups, globalRules };
}

const DEFAULT_LIMITS = {
    maxRules: 30000,
    maxUnsafeRules: 5000,
    maxRegexRules: 1000,
    regexMargin: 20
};

function isRegexRule(rule) {
    return rule.condition && typeof rule.condition.regexFilter === 'string';
}

function isUnsafeRule(rule) {
    return rule.action.type === 'redirect' || rule.action.type === 'modifyHeaders';
}

/**
 * Validates one entry with `isRegexSupported`, splitting alternations that hit
 * the RE2 memory limit. Returns the list of (rule, items) pairs or null on failure.
 */
async function validateEntry(entry, items, isRegexSupported) {
    const rule = entry.build(items);

    if (!isRegexRule(rule)) {
        return [{ rule, items, entry }];
    }

    let verdict;
    try {
        verdict = await isRegexSupported({
            regex: rule.condition.regexFilter,
            isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
            requireCapturing: rule.action.type === 'redirect' && !!rule.action.redirect.regexSubstitution
        });
    } catch (e) {
        verdict = { isSupported: false, reason: 'error' };
    }

    if (verdict && verdict.isSupported) {
        return [{ rule, items, entry }];
    }

    if (verdict && verdict.reason === 'memoryLimitExceeded' && items && items.length > 1) {
        const middle = Math.ceil(items.length / 2);
        const left = await validateEntry(entry, items.slice(0, middle), isRegexSupported);
        const right = await validateEntry(entry, items.slice(middle), isRegexSupported);
        if (left === null || right === null) return null;
        return left.concat(right);
    }

    return null;
}

/**
 * Validates all entries and fits them into the DNR rule budget.
 *
 * @param {{groups: object[], globalRules: object[]}} compiled result of {@link compile}
 * @param {object} env
 * @param {(request: {regex: string, isCaseSensitive: boolean, requireCapturing: boolean}) => Promise<{isSupported: boolean, reason?: string}>} env.isRegexSupported
 * @param {object} [env.limits]
 * @return {Promise<{rules: object[], coverage: object, stats: object}>}
 */
export async function fitRules(compiled, env) {
    const limits = Object.assign({}, DEFAULT_LIMITS, env.limits || {});
    const isRegexSupported = env.isRegexSupported;
    const accepted = [];
    const coverage = {};
    const stats = { providers: compiled.groups.length, compiledProviders: 0, dropped: [], droppedEntries: 0, regexRules: 0, unsafeRules: 0, rules: 0 };
    let regexCount = 0;
    let unsafeCount = 0;

    const fits = (rules) => {
        const regex = rules.filter(isRegexRule).length;
        const unsafe = rules.filter(isUnsafeRule).length;
        return accepted.length + rules.length <= limits.maxRules
            && regexCount + regex <= limits.maxRegexRules - limits.regexMargin
            && unsafeCount + unsafe <= limits.maxUnsafeRules;
    };

    const commit = (rules) => {
        for (const rule of rules) {
            if (isRegexRule(rule)) regexCount++;
            if (isUnsafeRule(rule)) unsafeCount++;
            accepted.push(rule);
        }
    };

    // Global rules first: they are cheap and important.
    for (const entry of compiled.globalRules) {
        const validated = await validateEntry(entry, entry.items, isRegexSupported);
        if (validated === null) {
            stats.dropped.push({ provider: '(global:' + entry.kind + ')', reason: 'unsupported' });
            continue;
        }
        const rules = validated.map((v) => v.rule);
        if (!fits(rules)) {
            stats.dropped.push({ provider: '(global:' + entry.kind + ')', reason: 'budget' });
            continue;
        }
        commit(rules);
    }

    for (const group of compiled.groups) {
        const providerRules = [];
        const acceptedItems = new Map();
        let essentialFailed = false;

        for (const entry of group.essential) {
            const validated = await validateEntry(entry, entry.items, isRegexSupported);
            if (validated === null) {
                essentialFailed = true;
                break;
            }
            providerRules.push(...validated.map((v) => v.rule));
        }

        if (essentialFailed) {
            stats.dropped.push({ provider: group.provider, reason: 'exception-unsupported' });
            coverage[group.provider] = emptyCoverage(group);
            continue;
        }

        for (const entry of group.optional) {
            const validated = await validateEntry(entry, entry.items, isRegexSupported);
            if (validated === null) {
                stats.droppedEntries++;
                continue;
            }
            for (const { rule, items } of validated) {
                providerRules.push(rule);
                for (const item of items || []) {
                    if (item.from === null) continue;
                    acceptedItems.set(item.from, (acceptedItems.get(item.from) || 0) + 1);
                }
                if (entry.kind === 'block' || entry.kind === 'blockPage') {
                    acceptedItems.set('block:' + entry.kind, 1);
                }
            }
        }

        if (!fits(providerRules)) {
            stats.dropped.push({ provider: group.provider, reason: 'budget' });
            coverage[group.provider] = emptyCoverage(group);
            continue;
        }

        commit(providerRules);
        stats.compiledProviders++;

        const cov = emptyCoverage(group);
        cov.compiled = true;
        for (const [from, total] of group.itemCount) {
            if ((acceptedItems.get(from) || 0) >= total) {
                if (from.startsWith('raw:')) {
                    cov.rawRules.push(from.slice(4));
                } else {
                    cov.rules.push(from);
                }
            }
        }
        cov.block = acceptedItems.has('block:block');
        cov.blockPage = acceptedItems.has('block:blockPage');
        coverage[group.provider] = cov;
    }

    accepted.forEach((rule, index) => {
        rule.id = index + 1;
    });

    stats.rules = accepted.length;
    stats.regexRules = regexCount;
    stats.unsafeRules = unsafeCount;

    return { rules: accepted, coverage, stats };
}

function emptyCoverage(group) {
    return { compiled: false, rules: [], rawRules: [], block: false, blockPage: false, priority: group.priority };
}

/**
 * Convenience wrapper: compile + fit.
 */
export async function buildRules(options, env) {
    return fitRules(compile(options), env);
}

/**
 * Returns true if every action reported by the engine for a request is handled
 * by the compiled DNR rules, i.e. no fallback (tabs.update) is necessary.
 */
export function actionsCovered(actions, coverage) {
    if (!coverage) return false;

    for (const action of actions) {
        if (action.type === 'ping') continue;
        if (action.type === 'redirect') return false;

        const cov = coverage[action.provider];
        if (!cov || !cov.compiled) return false;

        switch (action.type) {
            case 'cancel':
                if (!cov.block || !cov.blockPage) return false;
                break;
            case 'rawRule':
                if (!cov.rawRules.includes(action.rule)) return false;
                break;
            case 'rule':
                if (!cov.rules.includes(action.rule)) return false;
                break;
            default:
                return false;
        }
    }

    return true;
}
