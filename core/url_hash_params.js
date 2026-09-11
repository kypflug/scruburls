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

/**
 * Models a multimap backed by a {@link Set}. Port of core_js/utils/Multimap.js.
 */
export class Multimap {
    constructor() {
        this._map = new Map();
        this._size = 0;
    }

    get size() {
        return this._size;
    }

    get(key) {
        const values = this._map.get(key);
        return values ? new Set(values) : new Set();
    }

    put(key, value) {
        let values = this._map.get(key);
        if (!values) {
            values = new Set();
        }
        const count = values.size;
        values.add(value);
        if (values.size === count) {
            return false;
        }
        this._map.set(key, values);
        this._size++;
        return true;
    }

    has(key) {
        return this._map.has(key);
    }

    delete(key) {
        const values = this._map.get(key);
        if (values && this._map.delete(key)) {
            this._size -= values.size;
            return true;
        }
        return false;
    }

    keys() {
        return this._map.keys();
    }

    forEach(callback) {
        for (const [key, values] of this._map) {
            for (const value of values) {
                callback(key, value);
            }
        }
    }
}

/**
 * Models the "parameters" inside the hash/fragment of a {@link URL}, e.g.
 * `https://example.com/#utm_source=a&foo=b`. Port of core_js/utils/URLHashParams.js.
 */
export class URLHashParams {
    constructor(url) {
        this._params = new Multimap();
        const hash = url.hash.slice(1);
        for (const p of hash.split('&')) {
            const param = p.split('=');
            if (!param[0]) continue;
            const key = param[0];
            let value = null;
            if (param.length === 2 && param[1]) {
                value = param[1];
            }
            this._params.put(key, value);
        }
    }

    append(name, value = null) {
        this._params.put(name, value);
    }

    delete(name) {
        this._params.delete(name);
    }

    get(name) {
        const [first] = this._params.get(name);
        return first || null;
    }

    getAll(name) {
        return this._params.get(name);
    }

    keys() {
        return this._params.keys();
    }

    toString() {
        const rtn = [];
        this._params.forEach((key, value) => {
            rtn.push(value ? key + '=' + value : key);
        });
        return rtn.join('&');
    }
}
