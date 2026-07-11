'use strict';

const fs = require('fs');
const peNaming = require('./pe-naming');

function buildRunEvidence({ entries = [], jtlPath = '', samples = [] } = {}) {
    const observedSamples = samples.length ? samples.map(normalizeSample) : summarizeJtlFast(jtlPath);
    const rows = alignRecordingSamples(entries, observedSamples).map(pair => {
        const entry = entries[pair.entryIndex] || {};
        const sample = pair.sample || {};
        const recordedBody = entry.response && entry.response.content && entry.response.content.text || '';
        const observedBody = sample.responseBody || sample.body || '';
        const recordedUrl = entry.request && entry.request.url || '';
        const finalUrl = sample.finalUrl || sample.url || (sample.urls && sample.urls.length ? sample.urls[sample.urls.length - 1] : '');
        const observedResponseHeaders = sample.responseHeaders || [];
        const observedHeaderValues = headerValuesByName(observedResponseHeaders);
        return {
            entryIndex: pair.entryIndex,
            sampleIndex: pair.sampleIndex,
            label: sample.label || sample.name || samplerLabel(entry, pair.entryIndex),
            method: String(entry.request && entry.request.method || '').toUpperCase(),
            recordedUrl,
            finalUrl,
            subUrls: sample.urls || [],
            recordedStatus: Number(entry.response && entry.response.status || 0),
            observedStatus: Number(sample.responseCode || sample.code || sample.status || 0),
            observedResponseHeaders,
            observedHeaderValues,
            observedLocation: firstHeaderValue(observedResponseHeaders, 'location'),
            recordedBody,
            observedBody,
            recordedBodyLength: String(recordedBody || '').length,
            observedBodyLength: String(observedBody || '').length,
            assertionFailure: sample.failureMessage || '',
            isTransaction: !!sample.isTransaction,
            success: sample.success !== false,
            sample,
            entry,
        };
    });
    return { rows, samples: observedSamples, jtlPath: jtlPath || null };
}

function summarizeJtlFast(jtlPath) {
    if (!jtlPath || !fs.existsSync(jtlPath)) return [];
    const xml = fs.readFileSync(jtlPath, 'utf8');
    return summarizeJtlXml(xml);
}

function summarizeJtlXml(xml) {
    const re = /<(httpSample|sample)\b([^>]*)>/g;
    const raw = [];
    const labels = new Set();
    let match;
    while ((match = re.exec(xml || '')) !== null) {
        const tag = match[1];
        const attrs = match[2] || '';
        const label = unescapeXml((attrs.match(/\blb="([^"]*)"/) || [])[1] || '');
        if (!label) continue;
        const responseCode = unescapeXml((attrs.match(/\brc="([^"]*)"/) || [])[1] || '');
        const responseMessage = unescapeXml((attrs.match(/\brm="([^"]*)"/) || [])[1] || '');
        const success = /\bs="true"/.test(attrs);
        const body = extractTagBody(xml, re.lastIndex, tag);
        const failureMessage = firstAssertionFailure(body);
        const urls = urlsFromSampleBody(body);
        const responseBody = responseDataFromSampleBody(body);
        const responseHeaders = responseHeadersFromSampleBody(body);
        raw.push({ tag, label, responseCode, responseMessage, success, failureMessage, urls, responseBody, responseHeaders });
        labels.add(label);
    }

    return raw
        .filter(sample => {
            const sub = /^(.+)-\d+$/.exec(sample.label);
            return !(sub && labels.has(sub[1]));
        })
        .map(sample => normalizeSample({
            label: sample.label,
            code: sample.responseCode,
            responseCode: sample.responseCode,
            success: sample.success,
            isTransaction: sample.tag === 'sample',
            responseMessage: sample.failureMessage ? `JMeter assertion failed: ${sample.failureMessage}` : sample.responseMessage,
            failureMessage: sample.failureMessage,
            finalUrl: sample.urls.length ? sample.urls[sample.urls.length - 1] : '',
            urls: sample.urls,
            responseBody: sample.responseBody,
            responseHeaders: sample.responseHeaders,
        }));
}

function normalizeSample(sample = {}) {
    const urls = Array.isArray(sample.urls) ? sample.urls : [];
    return {
        ...sample,
        label: sample.label || sample.name || '',
        code: sample.code || sample.responseCode || sample.status || '',
        responseCode: sample.responseCode || sample.code || sample.status || '',
        success: sample.success !== false,
        isTransaction: !!sample.isTransaction,
        finalUrl: sample.finalUrl || sample.url || (urls.length ? urls[urls.length - 1] : ''),
        urls,
        responseBody: sample.responseBody || sample.body || '',
        responseHeaders: normalizeHeaders(sample.responseHeaders || sample.headers || []),
        failureMessage: sample.failureMessage || '',
    };
}

function alignRecordingSamples(entries, samples) {
    const pairs = [];
    const usedSampleIndexes = new Set();
    const usedEntryIndexes = new Set();

    // final.jtl (SimpleDataWriter) APPENDS every engine iteration, so a step
    // can appear multiple times. The FINAL iteration is what ships — pair each
    // step against its LAST occurrence, not its first, or a stale iteration-1
    // failure masquerades as the result on an otherwise-green re-run. Mark ALL
    // occurrences of a paired step as used so the positional fallback below can
    // never re-pair an earlier-iteration duplicate.
    const lastByEntryIndex = new Map(); // entryIndex -> { sampleIndex, sample }
    const occurrencesByEntryIndex = new Map(); // entryIndex -> sampleIndex[]
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        const sample = samples[sampleIndex] || {};
        const stepNumber = stepNumberFromLabel(sample.label || sample.name);
        if (!stepNumber) continue;
        const entryIndex = stepNumber - 1;
        if (entryIndex < 0 || entryIndex >= entries.length) continue;
        lastByEntryIndex.set(entryIndex, { sampleIndex, sample });
        if (!occurrencesByEntryIndex.has(entryIndex)) occurrencesByEntryIndex.set(entryIndex, []);
        occurrencesByEntryIndex.get(entryIndex).push(sampleIndex);
    }
    for (const [entryIndex, { sampleIndex, sample }] of lastByEntryIndex) {
        pairs.push({ entryIndex, sampleIndex, sample });
        usedEntryIndexes.add(entryIndex);
    }
    for (const indexes of occurrencesByEntryIndex.values()) {
        for (const sampleIndex of indexes) usedSampleIndexes.add(sampleIndex);
    }

    let fallbackEntryIndex = 0;
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        if (usedSampleIndexes.has(sampleIndex)) continue;
        while (fallbackEntryIndex < entries.length && usedEntryIndexes.has(fallbackEntryIndex)) fallbackEntryIndex++;
        if (fallbackEntryIndex >= entries.length) break;
        pairs.push({ entryIndex: fallbackEntryIndex, sampleIndex, sample: samples[sampleIndex] || {} });
        usedEntryIndexes.add(fallbackEntryIndex);
        fallbackEntryIndex++;
    }

    return pairs.sort((a, b) => a.entryIndex - b.entryIndex || a.sampleIndex - b.sampleIndex);
}

function stepNumberFromLabel(label) {
    return peNaming.stepNumberFromLabel(label);
}

function samplerLabel(entry, index) {
    const method = String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
    let path = '/';
    try { path = new URL(entry.request.url).pathname || '/'; } catch { /* keep / */ }
    return `Step ${String(index + 1).padStart(2, '0')} - ${method} ${path}`;
}

function extractTagBody(xml, offset, tag) {
    const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
    token.lastIndex = offset;
    let depth = 1;
    let match;
    while ((match = token.exec(xml)) !== null) {
        if (match[1]) {
            depth--;
            if (depth === 0) return xml.slice(offset, match.index);
        } else if (!/\/>$/.test(match[0])) {
            depth++;
        }
    }
    return '';
}

function firstAssertionFailure(body) {
    const assertionRe = /<assertionResult\b[^>]*>([\s\S]*?)<\/assertionResult>/g;
    let match;
    while ((match = assertionRe.exec(body || '')) !== null) {
        const block = match[1] || '';
        if (!/<(?:failure|error)>\s*true\s*<\/(?:failure|error)>/i.test(block)) continue;
        const message = (block.match(/<failureMessage>([\s\S]*?)<\/failureMessage>/i) || [])[1] || '';
        return unescapeXml(message.trim());
    }
    return '';
}

function urlsFromSampleBody(body) {
    const urls = [];
    const re = /<java\.net\.URL>([\s\S]*?)<\/java\.net\.URL>/g;
    let match;
    while ((match = re.exec(body || '')) !== null) {
        const url = unescapeXml((match[1] || '').trim());
        if (url) urls.push(url);
    }
    return urls;
}

function responseDataFromSampleBody(body) {
    const values = [];
    const re = /<responseData\b[^>]*>([\s\S]*?)<\/responseData>/g;
    let match;
    while ((match = re.exec(body || '')) !== null) {
        const value = unescapeXml(match[1] || '');
        if (value.trim()) values.push(value);
    }
    return values.length ? values[values.length - 1] : '';
}

function responseHeadersFromSampleBody(body) {
    const values = [];
    const re = /<responseHeader\b[^>]*>([\s\S]*?)<\/responseHeader>/g;
    let match;
    while ((match = re.exec(body || '')) !== null) {
        const value = unescapeXml(match[1] || '');
        if (value.trim()) values.push(value);
    }
    return values.length ? parseHttpHeaderBlock(values[values.length - 1]) : [];
}

function parseHttpHeaderBlock(block) {
    const headers = [];
    for (const line of String(block || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || /^HTTP\/\d(?:\.\d)?\s+/i.test(trimmed)) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        const name = trimmed.slice(0, colon).trim();
        const value = trimmed.slice(colon + 1).trim();
        if (name) headers.push({ name, value });
    }
    return headers;
}

function normalizeHeaders(headers) {
    if (Array.isArray(headers)) {
        return headers
            .map(header => {
                if (Array.isArray(header)) return { name: String(header[0] || ''), value: String(header[1] || '') };
                return { name: String(header && header.name || ''), value: String(header && header.value || '') };
            })
            .filter(header => header.name);
    }
    if (typeof headers === 'string') return parseHttpHeaderBlock(headers);
    return [];
}

function headerValuesByName(headers) {
    const values = {};
    for (const header of headers || []) {
        const key = String(header.name || '').toLowerCase();
        if (!key) continue;
        if (!values[key]) values[key] = [];
        values[key].push(String(header.value || ''));
    }
    return values;
}

function firstHeaderValue(headers, name) {
    const key = String(name || '').toLowerCase();
    for (const header of headers || []) {
        if (String(header.name || '').toLowerCase() === key) return String(header.value || '');
    }
    return '';
}

function unescapeXml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

module.exports = {
    buildRunEvidence,
    summarizeJtlFast,
    summarizeJtlXml,
    _internal: {
        alignRecordingSamples,
        stepNumberFromLabel,
        extractTagBody,
        firstAssertionFailure,
        urlsFromSampleBody,
        responseDataFromSampleBody,
        responseHeadersFromSampleBody,
        parseHttpHeaderBlock,
        headerValuesByName,
        unescapeXml,
    },
};
