'use strict';

const crypto = require('crypto');
const { buildLinks } = require('./replay-correlate');

function classifySamplerDisableDecisions({ entries = [], failures = [], protectedCalls = [] } = {}) {
    const base = buildLinks(entries);
    const cookieLinks = buildCookieLinks(entries);
    const links = [
        ...(base.links || []).map(l => ({ ...l, type: 'value' })),
        ...cookieLinks,
    ];
    const consumersByProducer = new Map();
    for (const link of links) {
        if (!consumersByProducer.has(link.producer)) consumersByProducer.set(link.producer, []);
        consumersByProducer.get(link.producer).push(link);
    }

    const failureIndexes = new Set((failures || []).map(f => Number(f.index ?? f.samplerIndex)).filter(Number.isFinite));
    const failureLabels = new Set((failures || []).map(f => String(f.samplerLabel || f.samplerName || f.label || '').trim()).filter(Boolean));
    const byIndex = [];
    const bySampler = {};

    for (let i = 0; i < entries.length; i++) {
        const sampler = samplerLabel(entries[i], i);
        const produced = consumersByProducer.get(i) || [];
        const explicitProtected = matchesAny(sampler, protectedCalls);
        const failed = failureIndexes.has(i) || failureLabels.has(sampler);
        const consumedOutputCount = produced.length;
        let decision = 'unknown';
        let reason = 'no failure evidence';

        if (explicitProtected) {
            decision = 'must_fix';
            reason = 'explicitly protected by operator config';
        } else if (consumedOutputCount > 0) {
            decision = 'must_fix';
            reason = 'downstream request consumes output from this sampler';
        } else if (failed) {
            decision = 'disposable_plumbing';
            reason = 'failing sampler has no downstream consumed outputs';
        }

        const summary = {
            index: i,
            sampler,
            decision,
            reason,
            failed,
            consumedOutputCount,
            consumerIndexes: [...new Set(produced.map(l => l.consumer))].sort((a, b) => a - b),
            outputs: produced.map(safeLinkSummary),
        };
        byIndex[i] = summary;
        bySampler[sampler] = summary;
    }

    return {
        byIndex,
        bySampler,
        links: links.map(safeLinkSummary),
        orphans: (base.orphans || []).map(o => ({ consumer: o.consumer, valueHash: hashValue(o.value) })),
    };
}

function buildCookieLinks(entries) {
    const producers = [];
    const links = [];
    for (let i = 0; i < entries.length; i++) {
        const setCookies = responseSetCookies(entries[i]);
        for (const cookie of setCookies) producers.push({ ...cookie, producer: i });
        const cookieHeader = requestCookieHeader(entries[i]);
        if (!cookieHeader) continue;
        for (const cookie of producers) {
            if (cookie.producer >= i) continue;
            if (cookieHeader.includes(`${cookie.name}=`) || (cookie.value && cookieHeader.includes(cookie.value))) {
                links.push({
                    type: 'cookie',
                    producer: cookie.producer,
                    consumer: i,
                    name: cookie.name,
                    value: cookie.value,
                });
            }
        }
    }
    return links;
}

function responseSetCookies(entry) {
    const headers = entry && entry.response && entry.response.headers || [];
    const out = [];
    for (const h of headers) {
        if (!/^set-cookie$/i.test(String(h.name || ''))) continue;
        const pair = String(h.value || '').split(';')[0];
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        out.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() });
    }
    return out;
}

function requestCookieHeader(entry) {
    const headers = entry && entry.request && entry.request.headers || [];
    const h = headers.find(x => /^cookie$/i.test(String(x.name || '')));
    return h ? String(h.value || '') : '';
}

function safeLinkSummary(link) {
    const out = {
        type: link.type || 'value',
        producer: link.producer,
        consumer: link.consumer,
    };
    if (link.varName) out.varName = link.varName;
    if (link.name) out.name = link.name;
    if (link.value) out.valueHash = hashValue(link.value);
    return out;
}

function samplerLabel(entry, index) {
    const method = String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
    let path = '/';
    try {
        path = new URL(entry.request.url).pathname || '/';
    } catch { /* keep default */ }
    return `Step ${String(index + 1).padStart(2, '0')} - ${method} ${path}`;
}

function matchesAny(sampler, patterns) {
    if (!Array.isArray(patterns)) return false;
    return patterns.some(p => p && sampler.includes(String(p)));
}

function hashValue(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

module.exports = {
    classifySamplerDisableDecisions,
    _internal: { buildCookieLinks, samplerLabel, hashValue },
};
