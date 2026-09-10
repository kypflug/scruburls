import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore, replaceOldURLs, DEFAULT_RULE_URL, hashStatusKey } from '../core/storage.js';
import { pushToLog, increaseTotalCounter, increaseCleanedCounter } from '../core/log.js';

class FakeArea {
    constructor(initial = {}) {
        this.items = { ...initial };
        this.removed = [];
    }
    async get() { return { ...this.items }; }
    async set(values) { Object.assign(this.items, values); }
    async remove(key) { delete this.items[key]; this.removed.push(key); }
}

test('defaults are applied and persisted values parsed', async () => {
    const area = new FakeArea({
        ClearURLsData: JSON.stringify({ providers: { x: { urlPattern: '.*' } } }),
        log: JSON.stringify({ log: [{ before: 'a', after: 'b', rule: 'r', timestamp: 1 }] }),
        types: 'main_frame,script',
        logLimit: '250',
        loggingStatus: 'true',
        globalurlcounter: 42,
        hashURL: 'https://kevinroebert.gitlab.io/ClearUrls/data/rules.minify.hash'
    });
    const store = new SettingsStore(area);
    await store.load();

    assert.deepEqual(store.data.ClearURLsData, { providers: { x: { urlPattern: '.*' } } });
    assert.equal(store.data.log.log.length, 1);
    assert.deepEqual(store.data.types, ['main_frame', 'script']);
    assert.equal(store.data.logLimit, 250);
    assert.equal(store.data.loggingStatus, true);
    assert.equal(store.data.totalCounter, 42);
    assert.equal(store.data.globalurlcounter, undefined);
    assert.ok(area.removed.includes('globalurlcounter'));
    assert.equal(store.data.hashURL, 'https://rules2.clearurls.xyz/rules.minify.hash');
    assert.equal(store.data.badgedStatus, true);
});

test('export format matches the original add-on', async () => {
    const store = new SettingsStore(new FakeArea());
    await store.load();
    store.data.dnrSignature = 'internal';
    const json = store.asJSON();
    assert.equal(typeof json.ClearURLsData, 'string');
    assert.equal(typeof json.log, 'string');
    assert.equal(json.types, store.data.types.join(','));
    assert.equal(json.ruleURL, DEFAULT_RULE_URL);
    assert.equal(json.dnrSignature, undefined);
});

test('save writes the string representation', async () => {
    const area = new FakeArea();
    const store = new SettingsStore(area);
    await store.load();
    store.data.log = { log: [] };
    await store.save(['log', 'types', 'globalStatus']);
    assert.equal(area.items.log, '{"log":[]}');
    assert.equal(typeof area.items.types, 'string');
    assert.equal(area.items.globalStatus, true);
});

test('log respects the limit and counters respect the statistics switch', async () => {
    const area = new FakeArea();
    const store = new SettingsStore(area);
    await store.load();
    store.deferSave = () => {};

    store.data.loggingStatus = false;
    pushToLog(store, 'a', 'b', 'rule');
    assert.equal(store.data.log.log.length, 0);

    store.data.loggingStatus = true;
    store.data.logLimit = 3;
    for (let i = 0; i < 5; i++) pushToLog(store, 'a' + i, 'b', 'rule');
    assert.equal(store.data.log.log.length, 3);
    assert.equal(store.data.log.log[0].before, 'a2');

    store.data.statisticsStatus = false;
    increaseTotalCounter(store, 5);
    increaseCleanedCounter(store);
    assert.equal(store.data.totalCounter, 0);
    assert.equal(store.data.cleanedCounter, 0);

    store.data.statisticsStatus = true;
    increaseTotalCounter(store, 5);
    increaseCleanedCounter(store);
    assert.equal(store.data.totalCounter, 5);
    assert.equal(store.data.cleanedCounter, 1);
});

test('helpers', () => {
    assert.equal(replaceOldURLs('https://example.com/x'), 'https://example.com/x');
    assert.equal(hashStatusKey(2), 'hash_status_code_2');
    assert.equal(hashStatusKey(99), 'hash_status_code_4');
});
