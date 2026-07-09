'use strict';

const { _internal: { samplerLabel } } = require('./value-flow-decisions');
const { knownDefinedVars } = require('./extractors');

const MIN_VALUE_LEN = 8;
const TOKEN_RE = /[A-Za-z0-9._~+/=-]{8,}/g;

function proposeCorrelationHypotheses({ xml = '', entries = [], failures = [] } = {}) {
    const failure = firstFailure(failures);
    if (!failure || !Array.isArray(entries) || !entries.length) {
        return { fixes: [], attempts: [], rejected: [] };
    }

    const consumerIndex = resolveConsumerIndex(failure, entries);
    const consumer = entries[consumerIndex];
    if (!consumer) return { fixes: [], attempts: [], rejected: [] };

    const samplerName = failure.samplerName || samplerLabel(consumer, consumerIndex);
    const defined = knownDefinedVars(xml);
    const usedNames = new Set(defined);
    const candidates = collectConsumedValues(consumer);
    const fixes = [];
    const attempts = [];
    const rejected = [];
    const seenValues = new Set();

    for (const candidate of candidates) {
        if (seenValues.has(candidate.value)) continue;
        seenValues.add(candidate.value);
        const producer = findVerifiedProducer(candidate, entries, consumerIndex);
        if (!producer) {
            rejected.push({
                value: candidate.value,
                sink: candidate.sink,
                sampler: samplerName,
                reason: 'no_verified_producer',
            });
            continue;
        }

        const variable = uniqueVarName(producer.variable || candidate.name || 'correlated_value', usedNames);
        const addExtractor = toAddExtractorFix(producer, variable);
        const replaceValue = {
            kind: 'replaceValueWithVar',
            sampler: samplerName,
            value: candidate.value,
            variable,
        };
        fixes.push(addExtractor, replaceValue);
        attempts.push({
            value: candidate.value,
            sink: candidate.sink,
            consumerIndex,
            consumerSampler: samplerName,
            producerIndex: producer.index,
            producerSampler: producer.sampler,
            proof: {
                verified: true,
                source: producer.source,
                extractorType: producer.type,
                variable,
            },
            fixes: [addExtractor, replaceValue],
        });
    }

    return { fixes, attempts, rejected };
}

function firstFailure(failures) {
    return (failures || []).find(f => f && (f.samplerName || f.samplerLabel || f.samplerIndex != null || f.index != null)) || null;
}

function resolveConsumerIndex(failure, entries) {
    if (failure.samplerIndex != null && entries[failure.samplerIndex]) return failure.samplerIndex;
    if (failure.index != null && entries[failure.index]) return failure.index;
    const name = String(failure.samplerName || failure.samplerLabel || '').trim();
    if (!name) return 0;
    const idx = entries.findIndex((entry, i) => samplerLabel(entry, i) === name || entry._samplerLabel === name);
    return idx >= 0 ? idx : 0;
}

function collectConsumedValues(entry) {
    const out = [];
    const add = (name, value, sink) => {
        for (const token of valueTokens(value)) {
            out.push({ name: sanitizeName(name), value: token, sink });
        }
    };
    const req = entry.request || {};
    for (const h of req.headers || []) {
        if (isIgnoredRequestHeader(h.name)) continue;
        add(h.name, h.value, `header:${h.name}`);
    }
    try {
        const u = new URL(req.url || '');
        for (const [name, value] of u.searchParams) add(name, value, `query:${name}`);
    } catch { /* ignore unparseable URL */ }
    const text = req.postData && typeof req.postData.text === 'string' ? req.postData.text : '';
    if (text) {
        for (const item of jsonStringValues(text)) add(item.name, item.value, `body:${item.name}`);
        for (const m of text.matchAll(/(?:^|[?&])([A-Za-z_][A-Za-z0-9_.-]*)=([^&\s]+)/g)) {
            let value = m[2];
            try { value = decodeURIComponent(value); } catch { /* keep raw */ }
            add(m[1], value, `body:${m[1]}`);
        }
    }
    return out.filter(c => c.value && c.value.length >= MIN_VALUE_LEN && !/^\$\{[^}]+\}$/.test(c.value));
}

function valueTokens(value) {
    const s = String(value == null ? '' : value);
    if (!s) return [];
    const tokens = [];
    if (isUsefulValue(s)) tokens.push(s);
    for (const m of s.matchAll(TOKEN_RE)) {
        if (isUsefulValue(m[0]) && !tokens.includes(m[0])) tokens.push(m[0]);
    }
    return tokens;
}

function isUsefulValue(value) {
    const s = String(value || '');
    return s.length >= MIN_VALUE_LEN && /[A-Za-z]/.test(s) && /[0-9]/.test(s);
}

function jsonStringValues(text) {
    try {
        const parsed = JSON.parse(text);
        const out = [];
        walkJson(parsed, [], (path, value) => {
            if (typeof value === 'string') out.push({ name: path[path.length - 1] || 'value', value });
        });
        return out;
    } catch {
        return [];
    }
}

function walkJson(node, path, visit) {
    if (node == null) return;
    if (Array.isArray(node)) {
        node.forEach((item, i) => walkJson(item, [...path, String(i)], visit));
        return;
    }
    if (typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) walkJson(value, [...path, key], visit);
        return;
    }
    visit(path, node);
}

function findVerifiedProducer(candidate, entries, consumerIndex) {
    for (let i = 0; i < consumerIndex; i++) {
        const entry = entries[i];
        const producer = findProducerInEntry(candidate, entry, i);
        if (producer) return producer;
    }
    return null;
}

function findProducerInEntry(candidate, entry, index) {
    const resp = entry.response || {};
    const body = (resp.content && resp.content.text) || '';
    const jsonProducer = findJsonProducer(body, candidate.value);
    if (jsonProducer) return withProducerMeta(jsonProducer, entry, index);

    for (const h of resp.headers || []) {
        const hv = String(h.value || '');
        if (!hv.includes(candidate.value)) continue;
        const name = String(h.name || '');
        if (/^set-cookie$/i.test(name)) {
            const cookie = cookieNameForValue(hv, candidate.value);
            if (!cookie) continue;
            return withProducerMeta({
                type: 'regex',
                regex: `${escapeRegex(cookie)}=([^;\\s]+)`,
                useHeaders: true,
                variable: candidate.name || cookie,
                source: `set-cookie:${cookie}`,
            }, entry, index);
        }
        return withProducerMeta({
            type: 'regex',
            regex: `(?im)^${escapeRegex(name)}:\\s*([^\\r\\n;]+)`,
            useHeaders: true,
            variable: candidate.name || name,
            source: `header:${name}`,
        }, entry, index);
    }

    const hidden = findHiddenInputProducer(body, candidate.value);
    if (hidden) return withProducerMeta(hidden, entry, index);
    return null;
}

function findJsonProducer(body, value) {
    if (!body || !body.includes(value)) return null;
    try {
        const parsed = JSON.parse(body);
        let found = null;
        walkJson(parsed, [], (path, nodeValue) => {
            if (found || nodeValue !== value) return;
            found = {
                type: 'json',
                path: jsonPath(path),
                variable: sanitizeName(path[path.length - 1] || 'value'),
                source: 'json',
            };
        });
        return found;
    } catch {
        return null;
    }
}

function findHiddenInputProducer(body, value) {
    if (!body || !body.includes(value)) return null;
    const escaped = escapeRegex(value);
    const match = body.match(new RegExp(`<input[^>]*name=["']([^"']+)["'][^>]*value=["']${escaped}["']`, 'i'))
        || body.match(new RegExp(`<input[^>]*value=["']${escaped}["'][^>]*name=["']([^"']+)["']`, 'i'));
    if (!match) return null;
    return {
        type: 'css',
        selector: `input[name="${match[1]}"]`,
        attribute: 'value',
        variable: sanitizeName(match[1]),
        source: `hidden-input:${match[1]}`,
    };
}

function withProducerMeta(producer, entry, index) {
    return {
        ...producer,
        index,
        sampler: entry._samplerLabel || samplerLabel(entry, index),
        url: entry.request && entry.request.url,
    };
}

function toAddExtractorFix(producer, variable) {
    if (producer.type === 'json') {
        return { kind: 'addExtractor', sampler: producer.sampler, variable, type: 'json', path: producer.path };
    }
    if (producer.type === 'css') {
        return { kind: 'addExtractor', sampler: producer.sampler, variable, type: 'css', selector: producer.selector, attribute: producer.attribute || 'value' };
    }
    return {
        kind: 'addExtractor',
        sampler: producer.sampler,
        variable,
        type: 'regex',
        regex: producer.regex,
        template: '$1$',
        useHeaders: !!producer.useHeaders,
    };
}

function isIgnoredRequestHeader(name) {
    return /^(host|content-length|connection|user-agent|accept|accept-encoding|accept-language|content-type|origin|referer|sec-|cache-control|pragma)$/i.test(String(name || ''));
}

function sanitizeName(name) {
    const clean = String(name || 'value').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    const safe = /^[A-Za-z_]/.test(clean) ? clean : `v_${clean}`;
    return safe || 'value';
}

function uniqueVarName(base, used) {
    let name = sanitizeName(base);
    let i = 2;
    while (used.has(name)) name = `${sanitizeName(base)}_${i++}`;
    used.add(name);
    return name;
}

function jsonPath(path) {
    if (!path.length) return '$';
    return '$' + path.map(part => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`).join('');
}

function cookieNameForValue(line, value) {
    const pair = String(line || '').split(';')[0] || '';
    const eq = pair.indexOf('=');
    if (eq < 0) return '';
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    return val === value ? name : '';
}

function escapeRegex(value) {
    return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    proposeCorrelationHypotheses,
    _internal: {
        collectConsumedValues,
        findVerifiedProducer,
        findJsonProducer,
        valueTokens,
    },
};
