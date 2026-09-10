import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, fitRules, actionsCovered, normalizeGroups, queryPrefix, orderProviders, mapResourceTypes, DNR_RESOURCE_TYPES } from '../core/dnr_compiler.js';
import { Engine } from '../core/engine.js';
import { loadRulesData, TEST_SETTINGS, fakeIsRegexSupported, simulateDNR } from './helpers.js';

const data = loadRulesData();
const settings = { ...TEST_SETTINGS };
const engine = new Engine(() => settings);
engine.loadData(data);

const built = await fitRules(compile({ data, settings }), { isRegexSupported: fakeIsRegexSupported });
const { rules, coverage, stats } = built;

test('normalizeGroups turns capturing groups into non-capturing ones', () => {
    assert.equal(normalizeGroups('git(lab)?\\.com'), 'git(?:lab)?\\.com');
    assert.equal(normalizeGroups('(?:a|b)(c)'), '(?:a|b)(?:c)');
    assert.equal(normalizeGroups('[(]x\\(y'), '[(]x\\(y');
});

test('queryPrefix strips trailing wildcards and literal question marks', () => {
    assert.equal(queryPrefix('.*'), '');
    assert.equal(queryPrefix('^https?:\\/\\/example\\.com\\/s\\?'), '^https?:\\/\\/example\\.com\\/s');
    assert.equal(queryPrefix('^https?:\\/\\/example\\.com\\/url\\?.*?'), '^https?:\\/\\/example\\.com\\/url');
    assert.equal(queryPrefix('^https?:\\/\\/example\\.com'), '^https?:\\/\\/example\\.com');
});

test('mapResourceTypes drops unknown types and never returns an empty list', () => {
    assert.deepEqual(mapResourceTypes(['main_frame', 'imageset', 'script']), ['main_frame', 'script']);
    assert.deepEqual(mapResourceTypes([]), DNR_RESOURCE_TYPES);
});

test('the global provider gets the lowest priority and providers with exceptions their own', () => {
    const ordered = orderProviders(data);
    assert.equal(ordered[0].name, 'globalRules');
    assert.equal(ordered[0].priority, 1);
    const withExceptions = ordered.filter((p) => (p.json.exceptions || []).length && p.name !== 'globalRules');
    const priorities = new Set(withExceptions.map((p) => p.priority));
    assert.equal(priorities.size, withExceptions.length);
    const without = ordered.filter((p) => !(p.json.exceptions || []).length);
    assert.ok(without.every((p) => p.priority > Math.max(...withExceptions.map((w) => w.priority))));
});

test('every provider of the current rules file compiles within the budget', () => {
    assert.equal(stats.dropped.length, 0, JSON.stringify(stats.dropped));
    assert.equal(stats.compiledProviders, stats.providers);
    assert.ok(stats.regexRules < 1000 - 20);
    assert.ok(stats.unsafeRules < 5000);
    assert.ok(rules.length > 100);
    const ids = new Set(rules.map((rule) => rule.id));
    assert.equal(ids.size, rules.length);
    assert.ok(rules.every((rule) => Number.isInteger(rule.id) && rule.id >= 1 && rule.priority >= 1));
});

test('generated rules only use valid DNR resource types and methods', () => {
    for (const rule of rules) {
        if (rule.condition.resourceTypes) {
            assert.ok(rule.condition.resourceTypes.length > 0);
            assert.ok(rule.condition.resourceTypes.every((type) => DNR_RESOURCE_TYPES.includes(type)), rule.id);
        }
        if (rule.condition.requestMethods) {
            assert.ok(rule.condition.requestMethods.every((method) => method === method.toLowerCase()));
        }
    }
});

test('ping blocking and etag filtering produce their global rules', () => {
    assert.ok(rules.some((rule) => rule.action.type === 'block' && rule.condition.resourceTypes.length === 1 && rule.condition.resourceTypes[0] === 'ping'));
    const etag = rules.find((rule) => rule.action.type === 'modifyHeaders');
    assert.ok(etag);
    assert.equal(etag.action.responseHeaders[0].header, 'etag');
    assert.equal(etag.action.responseHeaders[0].operation, 'remove');
});

test('domain blocking produces block and block-page rules', () => {
    const blocks = rules.filter((rule) => rule.action.type === 'block' && rule.condition.regexFilter);
    assert.ok(blocks.length >= 5);
    const pages = rules.filter((rule) => rule.action.redirect && rule.action.redirect.extensionPath === '/html/siteBlockedAlert.html');
    assert.equal(pages.length, blocks.length);
    assert.ok(pages.every((rule) => rule.condition.resourceTypes.length === 1 && rule.condition.resourceTypes[0] === 'main_frame'));
});

test('simulated DNR evaluation agrees with the engine on query parameters', () => {
    const samples = [
        'https://example.com/page?utm_source=newsletter1&utm_medium=email&utm_campaign=sale&id=5',
        'https://example.com/?fbclid=abc',
        'https://example.com/?a=1&gclid=x&b=2',
        'https://example.com/?a=1&utm_content=x',
        'https://www.amazon.com/dp/exampleProduct/ref=sxin_0_pb?__mk_de_DE=x&keywords=tea&pd_rd_i=exampleProduct&pd_rd_r=8d39e4cd&pd_rd_w=1pcKM&pd_rd_wg=hYrNl&pf_rd_p=50bbfd25&pf_rd_r=0GMWD0YY&qid=1517757263&rnid=2914120011',
        'https://www.amazon.de/s?k=tea&qid=123&crid=ABC',
        'https://twitter.com/foo/status/1?s=20&t=abc',
        'https://www.youtube.com/watch?v=abc&feature=youtu.be&si=xyz',
        'https://www.bing.com/search?q=test&cvid=abc&form=QBLH',
        'https://example.com/clean?id=5'
    ];

    for (const sample of samples) {
        const expected = engine.cleanRequest(sample, { type: 'main_frame', method: 'GET' });
        const simulated = simulateDNR(rules, sample);
        assert.equal(simulated.stuck, undefined, 'rule ' + simulated.stuck + ' produced a no-op redirect for ' + sample);
        assert.equal(simulated.tooManyHops, undefined, sample);
        assert.equal(new URL(simulated.url).toString(), new URL(expected.url).toString(), sample);
    }
});

test('simulated DNR evaluation blocks and redirects to the blocked page', () => {
    assert.equal(simulateDNR(rules, 'https://fls-na.amazon.com/1/batch/1/OP/x', 'script').blocked, true);
    assert.equal(simulateDNR(rules, 'https://fls-na.amazon.com/1/batch/1/OP/x', 'main_frame').blockPage, true);
    assert.equal(simulateDNR(rules, 'https://example.com/ping', 'ping').blocked, true);
});

test('simulated DNR evaluation respects exceptions and local hosts', () => {
    const excepted = 'https://accounts.google.com/signin?utm_source=x';
    assert.equal(simulateDNR(rules, excepted).url, excepted);
    assert.equal(simulateDNR(rules, 'http://192.168.0.5/?utm_source=x').url, 'http://192.168.0.5/?utm_source=x');
    assert.equal(simulateDNR(rules, 'http://localhost/?utm_source=x').url, 'http://localhost/?utm_source=x');
});

test('redirections are left to the service worker fallback', () => {
    const url = 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F&h=AT0';
    assert.equal(simulateDNR(rules, url).url, url);
    const result = engine.cleanRequest(url, { type: 'main_frame' });
    assert.equal(result.redirect, true);
    assert.equal(actionsCovered(result.actions, coverage), false);
});

test('coverage reports what the DNR rules handle', () => {
    assert.equal(coverage.globalRules.compiled, true);
    assert.ok(coverage.globalRules.rules.includes('(?:%3F)?utm(?:_[a-z_]*)?'));
    assert.ok(coverage.amazon.rawRules.includes('\\/ref=[^/?]*'));

    const covered = engine.cleanRequest('https://example.com/?utm_source=a&id=1', { type: 'main_frame' });
    assert.equal(actionsCovered(covered.actions, coverage), true);
    assert.equal(actionsCovered([{ type: 'rule', provider: 'does-not-exist', rule: 'x' }], coverage), false);
    assert.equal(actionsCovered([{ type: 'ping' }], coverage), true);
    assert.equal(actionsCovered([], null), false);
});

test('disabling features removes their rules', async () => {
    const off = { ...settings, pingBlocking: false, eTagFiltering: false, domainBlocking: false };
    const result = await fitRules(compile({ data, settings: off }), { isRegexSupported: fakeIsRegexSupported });
    assert.ok(!result.rules.some((rule) => rule.action.type === 'modifyHeaders'));
    assert.ok(!result.rules.some((rule) => rule.action.type === 'block'));
    assert.ok(!result.rules.some((rule) => rule.action.redirect && rule.action.redirect.extensionPath));
});

test('rules that hit the memory limit are split instead of dropped', async () => {
    const strict = async (request) => {
        const verdict = await fakeIsRegexSupported(request);
        if (verdict.isSupported && request.regex.length > 250) return { isSupported: false, reason: 'memoryLimitExceeded' };
        return verdict;
    };
    const result = await fitRules(compile({ data, settings }), { isRegexSupported: strict });
    assert.equal(result.stats.dropped.length, 0);
    assert.ok(result.rules.every((rule) => !rule.condition.regexFilter || rule.condition.regexFilter.length <= 250));
    assert.ok(result.rules.length > rules.length);
    assert.equal(simulateDNR(result.rules, 'https://example.com/page?utm_source=a&utm_medium=b&id=5').url, 'https://example.com/page?id=5');
});

test('providers with unsupported exceptions fall back to the service worker entirely', async () => {
    const custom = {
        providers: {
            weird: { urlPattern: '^https?:\\/\\/weird\\.example', rules: ['foo'], exceptions: ['^https?:\\/\\/weird\\.example\\/(?!keep)'] },
            fine: { urlPattern: '^https?:\\/\\/fine\\.example', rules: ['bar'] }
        }
    };
    const result = await fitRules(compile({ data: custom, settings }), { isRegexSupported: fakeIsRegexSupported });
    assert.deepEqual(result.stats.dropped, [{ provider: 'weird', reason: 'exception-unsupported' }]);
    assert.equal(result.coverage.weird.compiled, false);
    assert.equal(result.coverage.fine.compiled, true);
    assert.equal(simulateDNR(result.rules, 'https://weird.example/?foo=1').url, 'https://weird.example/?foo=1');
    assert.equal(simulateDNR(result.rules, 'https://fine.example/?bar=1&x=2').url, 'https://fine.example/?x=2');
});
