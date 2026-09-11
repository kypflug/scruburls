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
 *
 * Based on:
 *   Remove Google Redirection
 *   https://github.com/kodango/Remove-Google-Redirection/blob/master/extension/chrome/remove-google-redirection.user.js
 *   Copyright (c) 2017 kodango
 *   MIT License: https://github.com/kodango/Remove-Google-Redirection/blob/master/LICENSE
 */

/*
 * Main world part of the Google search fix (Manifest V3 `"world": "MAIN"`
 * content script, replaces the inline <script> injection of the original).
 * Neutralises `window.rwt`, the function Google uses to rewrite result links.
 */
(function () {
    'use strict';

    function hookRwtProperty() {
        try {
            Object.defineProperty(window, 'rwt', {
                configurable: false,
                writable: false,
                value: function () { return true; }
            });
        } catch (e) {
            console.debug('ScrubURLs: Failed to hook rwt property', e);
        }
    }

    const rwtDescriptor = Object.getOwnPropertyDescriptor(window, 'rwt');
    if (!('rwt' in window) || (rwtDescriptor && rwtDescriptor.configurable)) {
        hookRwtProperty();
    }
})();
