import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRegex, isLiteralRule } from '../core/regex_expand.js';

test('expands finite regexes', () => {
    assert.deepEqual(expandRegex('(?:%3F)?fbclid').sort(), ['%3Ffbclid', 'fbclid']);
    assert.deepEqual(expandRegex('colii?d').sort(), ['colid', 'coliid']);
    assert.deepEqual(expandRegex('[cilp]id').sort(), ['cid', 'iid', 'lid', 'pid']);
    assert.deepEqual(expandRegex('srs?').sort(), ['sr', 'srs']);
    assert.deepEqual(expandRegex('fb_(?:source|ref)').sort(), ['fb_ref', 'fb_source']);
    assert.deepEqual(expandRegex('p\\[\\]'), ['p[]']);
    assert.deepEqual(expandRegex('\\$3p'), ['$3p']);
    assert.deepEqual(expandRegex('a{2}'), ['aa']);
    assert.deepEqual(expandRegex('a{1,2}').sort(), ['a', 'aa']);
    assert.deepEqual(expandRegex('npv[0-9]').length, 10);
});

test('rejects unbounded or oversized regexes', () => {
    assert.equal(expandRegex('(?:%3F)?utm(?:_[a-z_]*)?'), null);
    assert.equal(expandRegex('p[fd]_rd_[a-z]*'), null);
    assert.equal(expandRegex('__mk_[a-z]{1,3}_[a-z]{1,3}'), null);
    assert.equal(expandRegex('li[a-z]{2}'), null);
    assert.equal(expandRegex('[^a-z]id'), null);
    assert.equal(expandRegex('a.b'), null);
    assert.equal(expandRegex('a+'), null);
    assert.equal(expandRegex('(a)\\1'), null);
});

test('detects literal rules', () => {
    assert.equal(isLiteralRule('utm_source'), true);
    assert.equal(isLiteralRule('field-lbr_brands_browse-bin'), true);
    assert.equal(isLiteralRule('utm_[a-z]*'), false);
    assert.equal(isLiteralRule('ref_?'), false);
});
