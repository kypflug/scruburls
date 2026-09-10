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
 * Expands "small" regular expressions into the finite list of strings they match.
 *
 * ClearURLs rules are RegExp sources matched against query parameter *names*
 * (e.g. `colii?d`, `[cilp]id`, `(?:%3F)?fbclid`). declarativeNetRequest can only
 * remove query parameters by literal name, so whenever a rule describes a small,
 * finite language we enumerate it and emit literal `removeParams` entries instead
 * of a (much more expensive) regex substitution rule.
 *
 * Returns `null` if the expression is unbounded, too large, or uses syntax we
 * don't handle (dot, anchors, unbounded quantifiers, negated classes, ...).
 */

const DIGITS = '0123456789'.split('');

function product(left, right, limit) {
    const out = [];
    for (const a of left) {
        for (const b of right) {
            out.push(a + b);
            if (out.length > limit) return null;
        }
    }
    return out;
}

function unique(list) {
    return [...new Set(list)];
}

export function expandRegex(source, limit = 64) {
    let i = 0;

    function parseAlternation() {
        const branches = [];
        let branch = parseSequence();
        if (branch === null) return null;
        branches.push(...branch);
        while (i < source.length && source[i] === '|') {
            i++;
            branch = parseSequence();
            if (branch === null) return null;
            branches.push(...branch);
            if (branches.length > limit) return null;
        }
        return unique(branches);
    }

    function parseSequence() {
        let result = [''];
        while (i < source.length && source[i] !== '|' && source[i] !== ')') {
            const atom = parseAtom();
            if (atom === null) return null;
            const quant = parseQuantifier();
            if (quant === null) return null;

            let alternatives = [];
            for (let n = quant.min; n <= quant.max; n++) {
                let repeated = [''];
                for (let k = 0; k < n; k++) {
                    repeated = product(repeated, atom, limit);
                    if (repeated === null) return null;
                }
                alternatives.push(...repeated);
                if (alternatives.length > limit) return null;
            }
            alternatives = unique(alternatives);
            result = product(result, alternatives, limit);
            if (result === null) return null;
        }
        return result;
    }

    function parseClass() {
        // source[i] === '['
        i++;
        if (source[i] === '^') return null;
        const items = [];
        while (i < source.length && source[i] !== ']') {
            let ch;
            if (source[i] === '\\') {
                const esc = source[i + 1];
                if (esc === undefined) return null;
                i += 2;
                if (esc === 'd') {
                    items.push(...DIGITS);
                    continue;
                }
                if (/[wWsSDbB]/.test(esc)) return null;
                ch = esc;
            } else {
                ch = source[i];
                i++;
            }

            if (source[i] === '-' && source[i + 1] !== undefined && source[i + 1] !== ']') {
                let to = source[i + 1];
                i += 2;
                if (to === '\\') {
                    to = source[i];
                    i++;
                }
                const from = ch.charCodeAt(0);
                const toCode = to.charCodeAt(0);
                if (toCode < from || toCode - from > limit) return null;
                for (let c = from; c <= toCode; c++) {
                    items.push(String.fromCharCode(c));
                }
            } else {
                items.push(ch);
            }
            if (items.length > limit) return null;
        }
        if (source[i] !== ']') return null;
        i++;
        return unique(items);
    }

    function parseAtom() {
        const c = source[i];
        if (c === '(') {
            i++;
            if (source[i] === '?') {
                if (source[i + 1] !== ':') return null;
                i += 2;
            }
            const inner = parseAlternation();
            if (inner === null || source[i] !== ')') return null;
            i++;
            return inner;
        }
        if (c === '[') {
            return parseClass();
        }
        if (c === '\\') {
            const esc = source[i + 1];
            if (esc === undefined) return null;
            i += 2;
            if (esc === 'd') return DIGITS.slice();
            if (/[wWsSDbBnrtf0-9]/.test(esc)) return null;
            return [esc];
        }
        if (c === '.' || c === '^' || c === '$' || c === '*' || c === '+' || c === '?' || c === '{' || c === ')' || c === ']') {
            return null;
        }
        i++;
        return [c];
    }

    function parseQuantifier() {
        const c = source[i];
        if (c === '?') {
            i++;
            if (source[i] === '?') i++;
            return { min: 0, max: 1 };
        }
        if (c === '*' || c === '+') return null;
        if (c === '{') {
            const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i));
            if (!m) return null;
            i += m[0].length;
            const min = Number(m[1]);
            let max = min;
            if (m[2] !== undefined) {
                if (m[3] === '') return null;
                max = Number(m[3]);
            }
            if (max > 4 || max < min) return null;
            if (source[i] === '?') i++;
            return { min, max };
        }
        return { min: 1, max: 1 };
    }

    let result;
    try {
        result = parseAlternation();
    } catch (e) {
        return null;
    }
    if (result === null || i !== source.length || result.length === 0) return null;

    // Safety net: every produced string must really be matched by the original rule.
    let regexp;
    try {
        regexp = new RegExp('^' + source + '$', 'i');
    } catch (e) {
        return null;
    }
    if (!result.every((text) => regexp.test(text))) return null;

    return result;
}

/**
 * Returns true if the given rule contains no RegExp metacharacters at all,
 * i.e. it is a plain parameter name.
 */
export function isLiteralRule(rule) {
    return !/[\\^$.|?*+()[\]{}]/.test(rule);
}
