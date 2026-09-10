import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = loadManifest();

test('manifest is version 3 with a module service worker', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.equal(manifest.background.type, 'module');
    assert.ok(!manifest.permissions.includes('webRequestBlocking'));
    assert.ok(manifest.permissions.includes('declarativeNetRequest'));
    assert.ok(manifest.host_permissions.includes('<all_urls>'));
});

test('every file referenced by the manifest exists', () => {
    const files = [
        manifest.background.service_worker,
        manifest.action.default_popup,
        manifest.options_ui.page,
        ...Object.values(manifest.icons),
        ...Object.values(manifest.action.default_icon),
        ...manifest.content_scripts.flatMap((cs) => cs.js),
        ...manifest.web_accessible_resources.flatMap((war) => war.resources)
    ];
    for (const file of files) {
        assert.ok(fs.existsSync(path.join(root, file)), file + ' is missing');
    }
});

test('every locale has the default messages', () => {
    const localesDir = path.join(root, '_locales');
    const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));
    for (const key of ['extension_description', 'popup_html_dnr_status', 'popup_html_dnr_status_inactive', 'log_html_table_empty', 'settings_html_saved', 'settings_html_dnr_head']) {
        assert.ok(en[key], key);
    }
    for (const locale of fs.readdirSync(localesDir)) {
        const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
        assert.ok(messages.extension_description, locale);
    }
});
