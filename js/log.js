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

import { translate, bg, handleError, writeVersion, downloadText, readFileAsText } from './common.js';

let entries = [];
let filtered = [];
let page = 0;
let pageLength = 10;
let sortDescending = true;

/**
 * Reset the global log.
 */
async function resetGlobalLog() {
    try {
        await bg('setData', 'log', JSON.stringify({ log: [] }));
        await bg('saveOnDisk', ['log']);
        location.reload();
    } catch (error) {
        handleError(error);
    }
}

/**
 * Get the log from the background and display it.
 */
async function getLog() {
    try {
        const log = await bg('getData', 'log');
        entries = (log && Array.isArray(log.log)) ? log.log.slice() : [];
        applyFilter();
    } catch (error) {
        handleError(error);
    }
}

function applyFilter() {
    const query = document.getElementById('search').value.trim().toLowerCase();
    filtered = query === ''
        ? entries.slice()
        : entries.filter((entry) => [entry.before, entry.after, entry.rule, toDate(entry.timestamp)].join(' ').toLowerCase().includes(query));

    filtered.sort((a, b) => sortDescending ? b.timestamp - a.timestamp : a.timestamp - b.timestamp);
    page = 0;
    render();
}

/**
 * Convert timestamp to date.
 */
function toDate(time) {
    return new Date(time).toLocaleString();
}

function render() {
    const tbody = document.getElementById('tbody');
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageLength));
    page = Math.min(page, pageCount - 1);
    const start = page * pageLength;
    const rows = filtered.slice(start, start + pageLength);

    tbody.replaceChildren(...rows.map((entry) => {
        const tr = document.createElement('tr');
        for (const [value, className] of [[entry.before, 'url-cell'], [entry.after, 'url-cell'], [entry.rule, ''], [toDate(entry.timestamp), 'time-cell']]) {
            const td = document.createElement('td');
            td.textContent = value;
            if (className) td.className = className;
            tr.appendChild(td);
        }
        return tr;
    }));

    document.getElementById('table_info').textContent = filtered.length === 0
        ? translate('log_html_table_empty')
        : (start + 1) + ' - ' + Math.min(start + pageLength, filtered.length) + ' / ' + filtered.length;

    renderPagination(pageCount);
    document.getElementById('head_4').textContent = translate('log_html_table_head_4') + (sortDescending ? ' ▼' : ' ▲');
}

function renderPagination(pageCount) {
    const container = document.getElementById('pagination');
    const buttons = [];

    const makeButton = (label, target, options = {}) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (options.active) button.classList.add('active');
        button.disabled = options.disabled === true;
        button.onclick = () => {
            page = target;
            render();
        };
        return button;
    };

    buttons.push(makeButton('‹', page - 1, { disabled: page === 0 }));

    const windowStart = Math.max(0, page - 3);
    const windowEnd = Math.min(pageCount, windowStart + 7);
    for (let i = windowStart; i < windowEnd; i++) {
        buttons.push(makeButton(String(i + 1), i, { active: i === page }));
    }

    buttons.push(makeButton('›', page + 1, { disabled: page >= pageCount - 1 }));
    container.replaceChildren(...buttons);
}

/**
 * Export the global log as json file.
 */
async function exportGlobalLog() {
    try {
        const log = await bg('getData', 'log');
        downloadText('ClearURLsLogExport.json', JSON.stringify(log));
    } catch (error) {
        handleError(error);
    }
}

/**
 * Imports an exported global log and overwrites the current one.
 */
async function importGlobalLog(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await readFileAsText(file);
        JSON.parse(text); // validate
        await bg('setData', 'log', text);
        await bg('saveOnDisk', ['log']);
        location.reload();
    } catch (error) {
        handleError(error);
    }
}

/**
 * Set the text for the UI.
 */
function setText() {
    document.title = translate('log_html_page_title');
    document.getElementById('page_title').textContent = translate('log_html_page_title');
    document.getElementById('reset_log_btn').textContent = translate('log_html_reset_button');
    document.getElementById('reset_log_btn').setAttribute('title', translate('log_html_reset_button_title'));
    document.getElementById('head_1').textContent = translate('log_html_table_head_1');
    document.getElementById('head_2').textContent = translate('log_html_table_head_2');
    document.getElementById('head_3').textContent = translate('log_html_table_head_3');
    document.getElementById('head_4').textContent = translate('log_html_table_head_4');
    document.getElementById('export_log_btn_text').textContent = translate('log_html_export_button');
    document.getElementById('export_log_btn').setAttribute('title', translate('log_html_export_button_title'));
    document.getElementById('import_log_btn_text').textContent = translate('log_html_import_button');
    document.getElementById('importLog').setAttribute('title', translate('log_html_import_button_title'));
    document.getElementById('page_length_label').textContent = translate('log_html_page_length');
    document.getElementById('search_label').textContent = translate('log_html_search');
}

(function init() {
    writeVersion();
    setText();
    getLog();
    document.getElementById('reset_log_btn').onclick = resetGlobalLog;
    document.getElementById('export_log_btn').onclick = exportGlobalLog;
    document.getElementById('importLog').onchange = importGlobalLog;
    document.getElementById('search').oninput = applyFilter;
    document.getElementById('pageLength').onchange = (event) => {
        pageLength = Number(event.target.value) || 10;
        page = 0;
        render();
    };
    document.getElementById('head_4').onclick = () => {
        sortDescending = !sortDescending;
        applyFilter();
    };
})();
