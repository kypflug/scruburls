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

/*
 * Pure helper functions shared by the service worker, the extension pages and
 * the unit tests. Nothing in here touches a chrome.* API.
 */
import { URLHashParams } from './url_hash_params.js';

const enc = new TextEncoder();

/** Private / link-local IPv4 ranges that count as "local hosts". */
const LOCAL_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8'];

/**
 * Check if an object is empty.
 */
export function isEmpty(obj) {
    return Object.getOwnPropertyNames(obj).length === 0;
}

/**
 * Parses a dotted-quad IPv4 address into an unsigned 32-bit integer, or null.
 */
export function ipv4ToInt(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    let value = 0;
    for (let i = 1; i <= 4; i++) {
        const octet = Number(m[i]);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

/**
 * Returns true if the IPv4 address is inside one of the given CIDR ranges.
 * Minimal replacement for the `ip-range-check` library bundled with the original add-on.
 */
export function ipRangeCheck(host, ranges) {
    const ip = ipv4ToInt(host);
    if (ip === null) return false;

    return ranges.some((range) => {
        const [base, bitsText] = range.split('/');
        const baseInt = ipv4ToInt(base);
        if (baseInt === null) return false;
        const bits = bitsText === undefined ? 32 : Number(bitsText);
        if (bits === 0) return true;
        const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
        return ((ip & mask) >>> 0) === ((baseInt & mask) >>> 0);
    });
}

/**
 * Extract the host without port from an url.
 */
export function extractHost(url) {
    return url.hostname;
}

/**
 * Returns true if the url has a local host (localhost or a private IPv4 range).
 * @param {URL} url
 */
export function checkLocalURL(url) {
    const host = extractHost(url);

    if (!host.match(/^\d/) && host !== 'localhost') {
        return false;
    }

    return host === 'localhost' || ipRangeCheck(host, LOCAL_RANGES);
}

/**
 * Return the number of query string parameters.
 * @param {string} url
 */
export function countFields(url) {
    try {
        return [...new URL(url).searchParams].length;
    } catch (e) {
        return 0;
    }
}

/**
 * Extract the fragments from an url.
 * @param {URL} url
 * @return {URLHashParams}
 */
export function extractFragments(url) {
    return new URLHashParams(url);
}

/**
 * Returns the given URL without searchParams and hash.
 * @param {URL} url
 * @return {URL}
 */
export function urlWithoutParamsAndHash(url) {
    let newURL = url.toString();

    if (url.search) {
        newURL = newURL.replace(url.search, '');
    }

    if (url.hash) {
        newURL = newURL.replace(url.hash, '');
    }

    return new URL(newURL);
}

/**
 * Returns true, iff the given URI is encoded.
 * @see https://stackoverflow.com/a/38265168
 */
export function isEncodedURI(uri) {
    try {
        return uri !== decodeURIComponent(uri || '');
    } catch (e) {
        return false;
    }
}

/**
 * Decodes an URL, also one that is encoded multiple times.
 * @see https://stackoverflow.com/a/38265168
 */
export function decodeURL(url) {
    let rtn = url;
    try {
        rtn = decodeURIComponent(url);
        while (isEncodedURI(rtn)) {
            rtn = decodeURIComponent(rtn);
        }
    } catch (e) {
        // malformed percent-encoding: keep what we have
    }

    // Required (e.g., to fix https://github.com/ClearURLs/Addon/issues/71)
    if (!rtn.startsWith('http')) {
        rtn = 'http://' + rtn;
    }

    return rtn;
}

/**
 * Gets the value at `key` of an object, or `defaultValue` if it is undefined.
 */
export function getOrDefault(obj, key, defaultValue) {
    return obj[key] === undefined ? defaultValue : obj[key];
}

/**
 * SHA-256 of the given message as lower-case hex string.
 */
export async function sha256(message) {
    const msgUint8 = enc.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates a non-secure random ASCII string of length {@code len}.
 */
export function randomASCII(len) {
    return [...Array(len)].map(() => (~~(Math.random() * 36)).toString(36)).join('');
}

/**
 * Returns an URLSearchParams as string. Does handle spaces correctly.
 */
export function urlSearchParamsToString(searchParams) {
    const rtn = [];

    searchParams.forEach((value, key) => {
        if (value) {
            rtn.push(key + '=' + encodeURIComponent(value));
        } else {
            rtn.push(key);
        }
    });

    return rtn.join('&');
}

/**
 * Escapes a string so it can be used literally inside a RegExp.
 */
export function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
}

/**
 * Returns true if the URL is a data: URL (those are skipped, they can be huge).
 */
export function isDataURL(url) {
    return url.substring(0, 5) === 'data:';
}
