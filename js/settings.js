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

import { translate, bg, handleError, writeVersion, injectText, injectRichText, downloadText, readFileAsText, bindSwitch } from './common.js';

const SWITCHES = ['localHostsSkipping', 'historyListenerEnabled', 'contextMenuEnabled', 'referralMarketing', 'domainBlocking', 'pingBlocking', 'eTagFiltering'];

/**
 * Reset everything to the default values.
 */
async function reset() {
    try {
        await bg('resetAll');
        location.reload();
    } catch (error) {
        handleError(error);
    }
}

/**
 * Saves the settings.
 */
async function save() {
    const status = document.getElementById('save_status');
    try {
        await bg('setData', 'badged_color', document.getElementById('badged_color').value);
        await bg('setData', 'ruleURL', document.getElementById('ruleURL').value);
        await bg('setData', 'hashURL', document.getElementById('hashURL').value);
        await bg('setData', 'types', document.getElementById('types').value);
        await bg('setData', 'logLimit', Math.max(0, Math.min(5000, Number(document.getElementById('logLimit').value) || 0)));
        await bg('setBadgedStatus');
        await bg('applySettings');
        status.textContent = translate('settings_html_saved');
        await showDNRStatus();
        await loadLogLimitLabel();
    } catch (error) {
        status.textContent = 'Error: ' + error.message;
        handleError(error);
    }
}

async function loadLogLimitLabel() {
    const logLimit = await bg('getData', 'logLimit');
    document.getElementById('logLimit_label').textContent = translate('setting_log_limit_label', logLimit === undefined ? '0' : String(logLimit));
    document.getElementById('logLimit').value = logLimit === undefined ? 0 : logLimit;
}

/**
 * Loads the data into the form.
 */
async function getData() {
    try {
        const [badgedColor, ruleURL, hashURL, types] = await Promise.all([
            bg('getData', 'badged_color'), bg('getData', 'ruleURL'), bg('getData', 'hashURL'), bg('getData', 'types')
        ]);

        let color = String(badgedColor || '#ffa500');
        if (color.charAt(0) !== '#') color = '#' + color;
        document.getElementById('badged_color').value = color.length === 9 ? color.slice(0, 7) : color;
        document.getElementById('ruleURL').value = ruleURL || '';
        document.getElementById('hashURL').value = hashURL || '';
        document.getElementById('types').value = Array.isArray(types) ? types.join(',') : (types || '');
        await loadLogLimitLabel();

        const values = await Promise.all(SWITCHES.map((key) => bg('getData', key)));
        SWITCHES.forEach((key, index) => bindSwitch(key, key, values[index], () => showDNRStatus()));
    } catch (error) {
        handleError(error);
    }
}

/**
 * Set the text for the UI.
 */
function setText() {
    document.title = translate('settings_html_page_title');
    document.getElementById('page_title').textContent = translate('settings_html_page_title');
    document.getElementById('badged_color_label').textContent = translate('badged_color_label');
    document.getElementById('reset_settings_btn').textContent = translate('setting_html_reset_button');
    document.getElementById('reset_settings_btn').setAttribute('title', translate('setting_html_reset_button_title'));
    document.getElementById('rule_url_label').textContent = translate('setting_rule_url_label');
    document.getElementById('hash_url_label').textContent = translate('setting_hash_url_label');
    injectRichText('types_label', 'setting_types_label');
    document.getElementById('save_settings_btn').textContent = translate('settings_html_save_button');
    document.getElementById('save_settings_btn').setAttribute('title', translate('settings_html_save_button_title'));
    injectText('context_menu_enabled', 'context_menu_enabled');
    injectRichText('history_listener_enabled', 'history_listener_enabled');
    injectText('local_hosts_skipping', 'local_hosts_skipping');
    document.getElementById('export_settings_btn_text').textContent = translate('setting_html_export_button');
    document.getElementById('export_settings_btn').setAttribute('title', translate('setting_html_export_button_title'));
    document.getElementById('import_settings_btn_text').textContent = translate('setting_html_import_button');
    document.getElementById('importSettings').setAttribute('title', translate('setting_html_import_button_title'));
    injectText('referral_marketing_enabled', 'referral_marketing_enabled');
    injectText('domain_blocking_enabled', 'domain_blocking_enabled');
    injectRichText('ping_blocking_enabled', 'ping_blocking_enabled');
    injectRichText('eTag_filtering_enabled', 'eTag_filtering_enabled');
    document.getElementById('dnr_head').textContent = translate('settings_html_dnr_head');
}

/**
 * Exports all settings with statistics and rules (ClearURLs.conf format).
 */
async function exportSettings() {
    try {
        const data = await bg('storageAsJSON');
        downloadText('ClearURLs.conf', JSON.stringify(data));
    } catch (error) {
        handleError(error);
    }
}

/**
 * Imports an exported ClearURLs settings file and overwrites the current one.
 */
async function importSettings(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const data = JSON.parse(await readFileAsText(file));
        for (const [key, value] of Object.entries(data)) {
            await bg('setData', key, value);
        }
        await bg('applySettings');
        location.reload();
    } catch (error) {
        document.getElementById('save_status').textContent = 'Error: ' + error.message;
        handleError(error);
    }
}

async function showDNRStatus() {
    const element = document.getElementById('dnr_status');
    try {
        const status = await bg('getDNRStatus');
        const stats = status.stats || {};
        const lines = [];

        if (stats.disabled || !status.activeRules) {
            lines.push(translate('popup_html_dnr_status_inactive'));
        } else {
            lines.push(translate('popup_html_dnr_status', String(status.activeRules), String(stats.compiledProviders || 0), String(status.providers || 0)));
            if (stats.regexRules !== undefined) lines.push('regex rules: ' + stats.regexRules + ', unsafe rules: ' + stats.unsafeRules);
            if (stats.failedRules) lines.push('rules rejected by the browser: ' + stats.failedRules);
            if (stats.dropped && stats.dropped.length) {
                lines.push('providers handled only by the fallback: ' + stats.dropped.map((d) => d.provider + ' (' + d.reason + ')').join(', '));
            }
            if (stats.compiledAt) lines.push('compiled: ' + new Date(stats.compiledAt).toLocaleString());
        }
        if (status.lastRulesCheck) lines.push('last rule update check: ' + new Date(status.lastRulesCheck).toLocaleString());
        if (status.lastRulesError) lines.push('last rule update error: ' + status.lastRulesError);

        element.replaceChildren(...lines.map((line) => {
            const div = document.createElement('div');
            div.textContent = line;
            return div;
        }));
    } catch (error) {
        handleError(error);
    }
}

(function init() {
    writeVersion();
    setText();
    getData();
    showDNRStatus();
    document.getElementById('reset_settings_btn').onclick = reset;
    document.getElementById('export_settings_btn').onclick = exportSettings;
    document.getElementById('importSettings').onchange = importSettings;
    document.getElementById('save_settings_btn').onclick = save;
})();
