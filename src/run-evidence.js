'use strict';

const fs = require('fs');
const peNaming = require('./pe-naming');
const { parseSidecarBuffer } = require('./recording-evidence-adapter');

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
            redirects: sample.redirects || [],
            renderedRequest: sample.renderedRequest || null,
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

/**
 * Body capture defaults to ON-ERROR, so a sampler that "succeeds" stores no
 * response body in the SimpleDataWriter JTL — exactly backwards for the checks
 * that matter, because an auth wall or a soft business failure IS a 200. The
 * engine's per-iteration JTL does carry bodies, so fill the empty rows from it
 * by label (last occurrence wins, as elsewhere). Every consumer of evidence
 * must go through here: a gate that silently had no bodies passes everything
 * for the wrong reason.
 * @returns {number} how many rows were filled
 */
function backfillObservedBodies({ evidence, sourceJtlPath = '' } = {}) {
    const rows = (evidence && evidence.rows) || [];
    if (!rows.length || !sourceJtlPath || !fs.existsSync(sourceJtlPath)) return 0;
    if (!rows.some(r => !r.isTransaction && !String(r.observedBody || ''))) return 0;
    const bodyByLabel = new Map();
    for (const s of summarizeJtlXml(fs.readFileSync(sourceJtlPath, 'utf8')) || []) {
        if (s && s.label && s.responseBody) bodyByLabel.set(String(s.label).trim(), s.responseBody);
    }
    if (!bodyByLabel.size) return 0;
    let filled = 0;
    for (const r of rows) {
        if (r.isTransaction || String(r.observedBody || '')) continue;
        const body = bodyByLabel.get(String(r.label || '').trim());
        if (!body) continue;
        r.observedBody = body;
        r.observedBodyLength = String(body).length;
        r.observedBodyBackfilled = true;
        filled++;
    }
    if (filled) evidence.observedBodiesBackfilled = (evidence.observedBodiesBackfilled || 0) + filled;
    return filled;
}

function summarizeJtlFast(jtlPath) {
    if (!jtlPath || !fs.existsSync(jtlPath)) return [];
    const xml = fs.readFileSync(jtlPath, 'utf8');
    return summarizeJtlXml(xml);
}

function summarizeJtlXml(xml) {
    const parsedSidecar = parseSidecarBuffer(xml).samples;
    const evidenceByLabel = new Map();
    for (const sample of parsedSidecar) {
        const label = String(sample.label || '');
        if (!evidenceByLabel.has(label)) evidenceByLabel.set(label, []);
        evidenceByLabel.get(label).push(sample);
    }
    const evidenceOccurrences = new Map();
    const nextEvidence = label => {
        const index = evidenceOccurrences.get(label) || 0;
        evidenceOccurrences.set(label, index + 1);
        return (evidenceByLabel.get(label) || [])[index] || null;
    };
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
        raw.push({
            tag, label, responseCode, responseMessage, success, body, failureMessage, urls, responseBody, responseHeaders,
            directEvidence: nextEvidence(label),
        });
        labels.add(label);
    }

    return raw
        .filter(sample => {
            if (sample.tag === 'sample' && /<httpSample\b/i.test(sample.body)) return false;
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
            responseBody: sample.directEvidence ? sample.directEvidence.body : sample.responseBody,
            responseHeaders: sample.directEvidence ? sample.directEvidence.directHeaders : sample.responseHeaders,
            redirects: sample.directEvidence ? sample.directEvidence.redirects : [],
            directUrl: sample.directEvidence ? sample.directEvidence.directUrl : '',
            renderedRequest: sample.directEvidence ? renderedRequestFromEvidence(sample.directEvidence) : null,
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
        redirects: sample.redirects || [],
        renderedRequest: sample.renderedRequest || null,
        failureMessage: sample.failureMessage || '',
    };
}

function renderedRequestFromEvidence(sample = {}) {
    const provenance = {
        samplerData: !!sample.hasSamplerData,
        requestData: !!sample.hasRequestData,
        requestHeaders: Array.isArray(sample.requestHeaders) && sample.requestHeaders.length > 0,
        cookies: Array.isArray(sample.cookies) && sample.cookies.length > 0,
    };
    if (!provenance.samplerData && !provenance.requestData && !provenance.requestHeaders && !provenance.cookies) return null;
    const samplerData = String(sample.samplerData || '');
    const parsedSamplerData = parseSamplerData(samplerData);
    const method = parsedSamplerData.method;
    const samplerUrl = parsedSamplerData.url;
    // A JTL URL may supply only the origin needed to resolve a direct
    // samplerData request target. It never becomes request evidence by itself.
    const baseUrl = sample.directUrl || (sample.urls || []).find(isAbsoluteUrl) || '';
    const url = samplerUrl ? resolveRenderedUrl(samplerUrl, baseUrl) : '';
    const headers = normalizeHeaders(sample.requestHeaders || []);
    const cookies = [
        ...headers.filter(header => String(header.name).toLowerCase() === 'cookie')
            .flatMap(header => parseCookies(header.value)),
        ...(sample.cookies || []).flatMap(value => String(value).split(/\r?\n/).flatMap(parseCookies)),
    ];
    return {
        method,
        url,
        query: queryValues(url),
        headers,
        cookies,
        body: sample.hasRequestData ? sample.requestData : parsedSamplerData.body,
        evidenceProvenance: provenance,
    };
}

function parseSamplerData(value) {
    const samplerData = String(value || '').replace(/\r\n/g, '\n');
    const urlFirst = /^(\w+:\/\/[^\n]+)\nPOST data:\n([\s\S]*)$/i.exec(samplerData);
    if (urlFirst) {
        const separator = urlFirst[2].indexOf('\n\n');
        return {
            method: 'POST',
            url: urlFirst[1].trim(),
            body: separator >= 0 ? urlFirst[2].slice(separator + 2) : '',
        };
    }
    const requestLine = /^([A-Z]+)\s+([^\n]+)(?:\n|$)/.exec(samplerData);
    if (!requestLine) return { method: '', url: '', body: samplerData };
    const method = requestLine[1];
    const target = requestLine[2].trim();
    const remainder = samplerData.slice(requestLine[0].length);
    if (/^data:$/i.test(target)) {
        const separator = remainder.indexOf('\n\n');
        return { method, url: '', body: separator >= 0 ? remainder.slice(separator + 2) : '' };
    }
    if (method === 'GET' || method === 'HEAD') return { method, url: target, body: '' };
    return { method, url: target, body: remainder };
}

function isAbsoluteUrl(value) {
    try { new URL(value); return true; } catch { return false; }
}

function resolveRenderedUrl(value, baseUrl) {
    if (!value) return '';
    try {
        return new URL(value, isAbsoluteUrl(baseUrl) ? baseUrl : undefined).toString();
    } catch {
        return value;
    }
}

function queryValues(url) {
    try {
        const parsed = new URL(url);
        const grouped = new Map();
        for (const [name, value] of parsed.searchParams) {
            if (!grouped.has(name)) grouped.set(name, []);
            grouped.get(name).push(value);
        }
        return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([name, values]) => [name, values.length === 1 ? values[0] : values]));
    } catch {
        return {};
    }
}

function parseCookies(value) {
    return String(value || '').split(/;\s*/).map(part => {
        const index = part.indexOf('=');
        return index > 0 ? { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() } : null;
    }).filter(Boolean);
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

    const fallbackIndexes = [];
    const lastFallbackByKey = new Map();
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        if (usedSampleIndexes.has(sampleIndex)) continue;
        const sample = samples[sampleIndex] || {};
        const key = fallbackSampleKey(sample);
        if (key) lastFallbackByKey.set(key, sampleIndex);
        else fallbackIndexes.push(sampleIndex);
    }
    const collapsedFallbackIndexes = [...fallbackIndexes, ...lastFallbackByKey.values()].sort((a, b) => a - b);
    let fallbackEntryIndex = 0;
    for (const sampleIndex of collapsedFallbackIndexes) {
        while (fallbackEntryIndex < entries.length && usedEntryIndexes.has(fallbackEntryIndex)) fallbackEntryIndex++;
        if (fallbackEntryIndex >= entries.length) break;
        pairs.push({ entryIndex: fallbackEntryIndex, sampleIndex, sample: samples[sampleIndex] || {} });
        usedEntryIndexes.add(fallbackEntryIndex);
        fallbackEntryIndex++;
    }

    return pairs.sort((a, b) => a.entryIndex - b.entryIndex || a.sampleIndex - b.sampleIndex);
}

function fallbackSampleKey(sample = {}) {
    const label = String(sample.label || sample.name || '').trim();
    const url = String(sample.finalUrl || sample.url || (sample.urls || []).at(-1) || '').split('?')[0];
    return label || url ? `${label}|${url}` : '';
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
    backfillObservedBodies,
    summarizeJtlFast,
    summarizeJtlXml,
    _internal: {
        alignRecordingSamples,
        fallbackSampleKey,
        stepNumberFromLabel,
        extractTagBody,
        firstAssertionFailure,
        urlsFromSampleBody,
        responseDataFromSampleBody,
        responseHeadersFromSampleBody,
        parseHttpHeaderBlock,
        headerValuesByName,
        unescapeXml,
        renderedRequestFromEvidence,
        parseSamplerData,
        queryValues,
        parseCookies,
    },
};
