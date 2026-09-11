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

import { translate, bg, handleError, writeVersion, injectText, bindSwitch } from './common.js';

let cleanedCounter = 0;
let totalCounter = 0;

/**
 * Get the cleanedCounter and totalCounter value from the storage.
 */
function changeStatistics() {
    let globalPercentage = ((cleanedCounter / totalCounter) * 100).toFixed(3);

    if (isNaN(Number(globalPercentage))) globalPercentage = 0;

    document.getElementById('statistics_value').textContent = cleanedCounter.toLocaleString();
    document.getElementById('statistics_value_global_percentage').textContent = globalPercentage + '%';
    document.getElementById('progress_blocked').style.width = globalPercentage + '%';
    document.getElementById('progress_non_blocked').style.width = (100 - globalPercentage) + '%';
    document.getElementById('statistics_total_elements').textContent = totalCounter.toLocaleString();
}

/**
 * Set the value for the hashStatus.
 */
function setHashStatus(hashStatus) {
    const element = document.getElementById('hashStatus');
    const text = hashStatus ? translate(hashStatus) : '';
    element.textContent = text !== '' ? text : translate('hash_status_code_5');
}

/**
 * Show/hide the sections that depend on a switch.
 */
function changeVisibility(sectionId, visible) {
    const element = document.getElementById(sectionId);
    if (element) element.style.display = visible ? '' : 'none';
}

/**
 * Reset the global statistic.
 */
async function resetGlobalCounter() {
    try {
        await bg('setData', 'cleanedCounter', 0);
        await bg('setData', 'totalCounter', 0);
        await bg('saveOnDisk', ['cleanedCounter', 'totalCounter']);
    } catch (error) {
        handleError(error);
    }

    cleanedCounter = 0;
    totalCounter = 0;
    changeStatistics();
}

async function showDNRStatus() {
    const element = document.getElementById('dnr_status');
    try {
        const status = await bg('getDNRStatus');
        const stats = status.stats || {};
        if (stats.disabled || !status.activeRules) {
            element.textContent = translate('popup_html_dnr_status_inactive');
        } else {
            element.textContent = translate('popup_html_dnr_status', String(status.activeRules), String(stats.compiledProviders || 0), String(status.providers || 0));
        }
        if (status.lastRulesError) {
            element.textContent += ' — ' + status.lastRulesError;
        }
    } catch (error) {
        element.textContent = '';
        handleError(error);
    }
}

async function checkForUpdates() {
    const button = document.getElementById('check_updates_btn');
    button.disabled = true;
    try {
        const status = await bg('checkForUpdates');
        setHashStatus(status);
        await showDNRStatus();
    } catch (error) {
        handleError(error);
    }
    button.disabled = false;
}

/**
 * Set the text for the UI.
 */
function setText() {
    injectText('loggingPage', 'popup_html_log_head');
    injectText('reset_counter_btn', 'popup_html_statistics_reset_button');
    injectText('rules_status_head', 'popup_html_rules_status_head');
    injectText('statistics_percentage', 'popup_html_statistics_percentage');
    injectText('statistics_blocked', 'popup_html_statistics_blocked');
    injectText('statistics_elements', 'popup_html_statistics_elements');
    injectText('statistics_head', 'popup_html_statistics_head');
    injectText('configs_switch_badges', 'popup_html_configs_switch_badges');
    injectText('configs_switch_log', 'popup_html_configs_switch_log');
    injectText('configs_switch_filter', 'popup_html_configs_switch_filter');
    injectText('configs_head', 'popup_html_configs_head');
    injectText('configs_switch_statistics', 'configs_switch_statistics');
    document.getElementById('donate').title = translate('donate_button');
    document.getElementById('settings').title = translate('settings_html_page_title');
    document.getElementById('cleaning_tools').title = translate('cleaning_tool_page_title');
}

(async function init() {
    writeVersion();
    setText();

    try {
        const [cleaned, total, globalStatus, badgedStatus, hashStatus, loggingStatus, statisticsStatus] = await Promise.all([
            bg('getData', 'cleanedCounter'), bg('getData', 'totalCounter'), bg('getData', 'globalStatus'),
            bg('getData', 'badgedStatus'), bg('getData', 'hashStatus'), bg('getData', 'loggingStatus'),
            bg('getData', 'statisticsStatus')
        ]);

        cleanedCounter = Number(cleaned) || 0;
        totalCounter = Number(total) || 0;

        bindSwitch('globalStatus', 'globalStatus', globalStatus, () => showDNRStatus());
        bindSwitch('tabcounter', 'badgedStatus', badgedStatus);
        bindSwitch('logging', 'loggingStatus', loggingStatus, (checked) => changeVisibility('log_section', checked));
        bindSwitch('statistics', 'statisticsStatus', statisticsStatus, (checked) => changeVisibility('statistic_section', checked));

        changeVisibility('log_section', loggingStatus);
        changeVisibility('statistic_section', statisticsStatus);
        setHashStatus(hashStatus);
        changeStatistics();
    } catch (error) {
        handleError(error);
    }

    document.getElementById('reset_counter_btn').onclick = resetGlobalCounter;
    document.getElementById('check_updates_btn').onclick = checkForUpdates;
    document.getElementById('loggingPage').href = chrome.runtime.getURL('html/log.html');
    document.getElementById('settings').href = chrome.runtime.getURL('html/settings.html');
    document.getElementById('cleaning_tools').href = chrome.runtime.getURL('html/cleaningTool.html');

    showDNRStatus();
})();
