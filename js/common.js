/*
 * ClearURLs (Manifest V3 port)
 * Copyright (c) 2017-2025 Kevin Röbert (original ClearURLs)
 * Copyright (c) 2026 ClearURLs MV3 port contributors
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
 * Helpers shared by the extension pages.
 */

/**
 * Translate a string with the i18n API.
 */
export function translate(key, ...placeholders) {
    return chrome.i18n.getMessage(key, placeholders.map(String));
}

/**
 * Calls a function of the background service worker.
 */
export async function bg(fn, ...params) {
    const reply = await chrome.runtime.sendMessage({ function: fn, params });
    if (reply && reply.error) {
        throw new Error(reply.error);
    }
    return reply ? reply.response : undefined;
}

export function handleError(error) {
    console.log('Error: ' + (error && error.message ? error.message : error));
}

/**
 * Writes the extension version into the element with id `version`.
 */
export function writeVersion() {
    const element = document.getElementById('version');
    if (element) element.textContent = chrome.runtime.getManifest().version;
}

/**
 * Sets the translated text (and, if a `<key>_title` message exists, the tooltip) of an element.
 */
export function injectText(id, key) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = translate(key);

    const tooltip = translate(key + '_title');
    if (tooltip !== '') {
        element.setAttribute('title', tooltip);
    }
}

const ALLOWED_TAGS = new Set(['A', 'B', 'I', 'EM', 'STRONG', 'BR', 'CODE']);

/**
 * Sets a translated message that contains simple markup (links, bold text).
 * Only a small allow list of tags is kept, everything else is rendered as text.
 */
export function injectRichText(id, key) {
    const element = document.getElementById(id);
    if (!element) return;

    const parsed = new DOMParser().parseFromString(translate(key), 'text/html');
    element.replaceChildren(...sanitizeNodes(parsed.body.childNodes));

    const tooltip = translate(key + '_title');
    if (tooltip !== '') {
        element.setAttribute('title', tooltip);
    }
}

function sanitizeNodes(nodes) {
    const out = [];
    for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            out.push(document.createTextNode(node.textContent));
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (!ALLOWED_TAGS.has(node.tagName)) {
            out.push(...sanitizeNodes(node.childNodes));
            continue;
        }

        const clean = document.createElement(node.tagName.toLowerCase());
        if (node.tagName === 'A') {
            const href = node.getAttribute('href') || '';
            if (/^https?:\/\//i.test(href)) {
                clean.setAttribute('href', href);
                clean.setAttribute('target', '_blank');
                clean.setAttribute('rel', 'noopener noreferrer');
            }
        }
        clean.append(...sanitizeNodes(node.childNodes));
        out.push(clean);
    }
    return out;
}

/**
 * Localises every element carrying a `data-i18n`, `data-i18n-title` or `data-i18n-html` attribute.
 */
export function localizeDocument() {
    for (const element of document.querySelectorAll('[data-i18n]')) {
        element.textContent = translate(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll('[data-i18n-html]')) {
        injectRichText(element.id, element.dataset.i18nHtml);
    }
    for (const element of document.querySelectorAll('[data-i18n-title]')) {
        const tooltip = translate(element.dataset.i18nTitle);
        if (tooltip !== '') element.setAttribute('title', tooltip);
    }
}

/**
 * Offers a text file for download.
 */
export function downloadText(filename, text, type = 'application/json') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Reads the selected file of a file input as text.
 */
export function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}

/**
 * Wires a switch (checkbox) to a boolean setting of the background storage.
 */
export function bindSwitch(id, storageKey, initialValue, onChange) {
    const element = document.getElementById(id);
    if (!element) return;
    element.checked = Boolean(initialValue);

    element.addEventListener('change', async () => {
        try {
            await bg('setData', storageKey, element.checked);
            if (storageKey === 'globalStatus') {
                await bg('changeIcon');
            }
            await bg('saveOnExit');
            if (onChange) onChange(element.checked);
        } catch (error) {
            handleError(error);
        }
    });
}
