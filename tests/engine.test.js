import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine.js';
import { loadRulesData, TEST_SETTINGS } from './helpers.js';

const data = loadRulesData();
const settings = { ...TEST_SETTINGS };
const engine = new Engine(() => settings);
engine.loadData(data);

test('loads every provider of the rules file', () => {
    assert.equal(engine.providers.length, Object.keys(data.providers).length);
    assert.ok(engine.providers.length > 100);
});

test('removes global tracking parameters', () => {
    const result = engine.cleanRequest('https://example.com/page?utm_source=newsletter1&utm_medium=email&utm_campaign=sale&id=5', { type: 'main_frame', method: 'GET' });
    assert.equal(result.url, 'https://example.com/page?id=5');
    assert.equal(result.cancel, false);
    assert.ok(result.actions.every((action) => action.type === 'rule' && action.provider === 'globalRules'));
});

test('cleans the amazon example from the README', () => {
    const dirty = 'https://www.amazon.com/dp/exampleProduct/ref=sxin_0_pb?__mk_de_DE=%C3%85M%C3%85%C5%BD%C3%95%C3%91&keywords=tea&pd_rd_i=exampleProduct&pd_rd_r=8d39e4cd-1e4f-43db-b6e7-72e969a84aa5&pd_rd_w=1pcKM&pd_rd_wg=hYrNl&pf_rd_p=50bbfd25-5ef7-41a2-68d6-74d854b30e30&pf_rd_r=0GMWD0YYKA7XFGX55ADP&qid=1517757263&rnid=2914120011';
    assert.equal(engine.pureCleaning(dirty), 'https://www.amazon.com/dp/exampleProduct');
    assert.equal(engine.cleanRequest(dirty, { type: 'main_frame' }).url, 'https://www.amazon.com/dp/exampleProduct');
});

test('removes tracking parameters from the fragment', () => {
    assert.equal(engine.pureCleaning('https://example.com/a#utm_source=x&section=2'), 'https://example.com/a#section=2');
});

test('follows redirections and decodes the target', () => {
    const result = engine.cleanRequest('https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1%26utm_source%3Dx&sa=D', { type: 'main_frame' });
    assert.equal(result.redirect, true);
    assert.equal(result.url, 'https://example.org/a?b=1');
    assert.equal(result.actions[0].type, 'redirect');
    assert.equal(result.actions[0].provider, 'google');
});

test('cancels requests to blocked providers when domain blocking is enabled', () => {
    const url = 'https://googleads.g.doubleclick.net/pagead/ads?client=x';
    const blocked = engine.cleanRequest('https://fls-na.amazon.com/1/batch/1/OP/x', { type: 'script' });
    assert.equal(blocked.cancel, true);
    assert.equal(blocked.actions[0].type, 'cancel');

    settings.domainBlocking = false;
    assert.equal(engine.cleanRequest('https://fls-na.amazon.com/1/batch/1/OP/x', { type: 'script' }).cancel, false);
    settings.domainBlocking = true;

    // pureCleaning never cancels
    assert.equal(engine.pureCleaning(url), url);
});

test('blocks ping requests', () => {
    const result = engine.cleanRequest('https://example.com/track', { type: 'ping' });
    assert.equal(result.cancel, true);
    assert.equal(result.actions[0].type, 'ping');
    settings.pingBlocking = false;
    assert.equal(engine.cleanRequest('https://example.com/track', { type: 'ping' }).cancel, false);
    settings.pingBlocking = true;
});

test('skips local hosts when configured', () => {
    assert.equal(engine.pureCleaning('http://192.168.1.1/?utm_source=x'), 'http://192.168.1.1/?utm_source=x');
    assert.equal(engine.pureCleaning('http://localhost:8080/?utm_source=x'), 'http://localhost:8080/?utm_source=x');
    settings.localHostsSkipping = false;
    assert.equal(engine.pureCleaning('http://192.168.1.1/?utm_source=x'), 'http://192.168.1.1/');
    settings.localHostsSkipping = true;
    assert.equal(engine.pureCleaning('http://8.8.8.8/?utm_source=x'), 'http://8.8.8.8/');
});

test('referral marketing parameters are only removed when the protection is disabled', () => {
    const url = 'https://www.amazon.com/dp/B000?tag=affiliate-20';
    assert.equal(engine.pureCleaning(url), url);
    settings.referralMarketing = false;
    assert.equal(engine.pureCleaning(url), 'https://www.amazon.com/dp/B000');
    settings.referralMarketing = true;
});

test('respects provider exceptions', () => {
    const url = 'https://gitlab.com/foo/bar/-/refs/switch?destination=tree&ref_=main';
    assert.equal(engine.pureCleaning(url), url);
});

test('is idempotent and leaves clean URLs alone', () => {
    for (const url of ['https://example.com/', 'https://example.com/path?id=5&page=2', 'https://en.wikipedia.org/wiki/URL#Syntax']) {
        assert.equal(engine.pureCleaning(url), url);
        assert.equal(engine.cleanRequest(url, { type: 'main_frame' }).actions.length, 0);
    }
});

test('ignores data URLs and unparsable URLs', () => {
    assert.equal(engine.cleanRequest('data:text/plain,utm_source', { type: 'image' }).actions.length, 0);
    assert.equal(engine.pureCleaning('not a url'), 'not a url');
});

test('watchdog self test passes', () => {
    assert.equal(new URL(engine.pureCleaning('https://clearurls.roebert.eu?utm_source=addon')).toString(), new URL('https://clearurls.roebert.eu').toString());
});
