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

import { translate, bg, handleError, writeVersion, injectRichText } from './common.js';

/**
 * Set the text for the UI.
 */
function setText() {
    document.title = translate('blocked_html_title').replace(/<[^>]+>/g, '');
    injectRichText('title', 'blocked_html_title');
    injectRichText('body', 'blocked_html_body');
    document.getElementById('page').textContent = translate('blocked_html_button');
}

/**
 * Returns the blocked URL: either from the `source` query parameter (set by the
 * service worker) or, when the declarativeNetRequest rule redirected here directly,
 * from the service worker's memory.
 */
async function getSource() {
    const search = window.location.search;
    const index = search.indexOf('source=');
    if (index !== -1) {
        try {
            return decodeURIComponent(search.slice(index + 'source='.length));
        } catch (e) {
            return search.slice(index + 'source='.length);
        }
    }

    try {
        return await bg('getBlockedSource');
    } catch (error) {
        handleError(error);
        return '';
    }
}

(async function init() {
    writeVersion();
    setText();

    const source = await getSource();
    const button = document.getElementById('page');

    if (source && /^https?:\/\//i.test(source)) {
        button.href = source;
        document.getElementById('source').textContent = source;
    } else {
        button.style.display = 'none';
    }
})();
