'use strict';

/**
 * Local boundary for JMeter response-side recordings. The engine parser remains
 * a fallback only; pairing policy and evidence preservation live here so ingest
 * never depends on engine-specific pairing heuristics.
 */
const path = require('path');
const { jtlParser } = require('./engine');

function parseAndPair(entries, sidecarBuffer, sidecarPath = '') {
    const parsed = parseSidecarBuffer(sidecarBuffer);
    const paired = pairEntries(entries, parsed.samples);
    return {
        entries: paired.entries,
        coverage: {
            paired: paired.paired,
            unmatched: paired.unmatched,
            total: entries.length,
            ambiguous: paired.ambiguous,
            resolvedDuplicateOccurrences: paired.resolvedDuplicateOccurrences,
            lowCoverage: entries.length > 0 && paired.paired / entries.length < 0.8,
            sidecar: sidecarPath || null,
        },
        sidecar: {
            path: sidecarPath || null,
            name: sidecarPath ? path.basename(sidecarPath) : null,
            sampleCount: parsed.samples.length,
        },
    };
}

function parseSidecarBuffer(buffer) {
    const xml = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    const roots = parseSampleTree(xml);
    const samples = flattenHttpSamples(roots);
    if (samples.length) return { samples, roots };

    // Preserve compatibility with unconventional flat JTLs that the engine
    // already knows how to parse. Its method is deliberately not used for
    // pairing because it treats methodless samples as GET evidence.
    try {
        const fallback = jtlParser.parseJtlBuffer(Buffer.from(xml));
        const fallbackSamples = Object.values(fallback.byKey || {}).flat().map(sample => ({
            status: Number(sample.status || sample.responseCode || 0),
            statusText: sample.statusText || sample.responseMessage || '',
            url: sample.url || '',
            path: pathOf(sample.url || sample.label || ''),
            headers: normalizeHeaders(sample.headers || sample.responseHeaders || []),
            body: sample.body || sample.responseBody || '',
            redirects: [],
            label: sample.label || '',
        }));
        return { samples: fallbackSamples, roots: [] };
    } catch {
        return { samples: [], roots: [] };
    }
}

function flattenHttpSamples(nodes) {
    const out = [];
    const visit = (node) => {
        if (node.tag === 'httpSample') {
            out.push(sampleFromNode(node));
            return; // nested HTTP children are redirect subresults of this sampler.
        }
        for (const child of node.children || []) visit(child);
    };
    for (const node of nodes || []) visit(node);
    return out;
}

function pairEntries(entries, samples) {
    const used = new Set();
    let paired = 0;
    const ambiguous = 0;
    let resolvedDuplicateOccurrences = 0;
    const output = entries.map((entry, index) => {
        const requestUrl = String(entry?.request?.url || '');
        const exact = samples.map((sample, sampleIndex) => ({ sample, sampleIndex }))
            .filter(item => !used.has(item.sampleIndex) && item.sample.url === requestUrl);
        const candidates = exact.length ? exact : samples.map((sample, sampleIndex) => ({ sample, sampleIndex }))
            .filter(item => !used.has(item.sampleIndex) && item.sample.path && item.sample.path === pathOf(requestUrl));
        if (!candidates.length) return entry;
        // Same URL/path samples are recorded in execution order, so choosing
        // the next unused occurrence is deterministic evidence, not ambiguity.
        // Count each pairing decision that had multiple remaining occurrences;
        // never sum candidate counts, which would triangularly overcount 3+.
        if (candidates.length > 1) resolvedDuplicateOccurrences++;
        const { sample, sampleIndex } = candidates[0];
        used.add(sampleIndex);
        paired++;
        return withResponseEvidence(entry, sample, index);
    });
    return { entries: output, paired, unmatched: entries.length - paired, ambiguous, resolvedDuplicateOccurrences };
}

function withResponseEvidence(entry, sample) {
    const prior = entry.response || {};
    return {
        ...entry,
        response: {
            ...prior,
            status: sample.status || prior.status || 0,
            statusText: sample.statusText || prior.statusText || '',
            headers: sample.headers.length ? sample.headers : (prior.headers || []),
            content: {
                ...(prior.content || {}),
                text: sample.body || prior.content?.text || '',
            },
        },
        _recordingEvidence: {
            redirects: sample.redirects,
            sourceHeaders: sample.sourceHeaders,
            sidecarUrl: sample.url,
        },
    };
}

function parseSampleTree(xml) {
    const roots = [];
    const stack = [];
    const re = /<(\/?)(httpSample|sample)\b([^>]*)>/gi;
    let cursor = 0;
    let match;
    while ((match = re.exec(xml)) !== null) {
        if (stack.length) stack[stack.length - 1].directText += xml.slice(cursor, match.index);
        cursor = re.lastIndex;
        if (match[1]) {
            const node = stack.pop();
            if (!node) continue;
            if (stack.length) stack[stack.length - 1].children.push(node);
            else roots.push(node);
            continue;
        }
        const node = { tag: match[2], attrs: attributes(match[3]), directText: '', children: [] };
        if (/\/\s*$/.test(match[3])) {
            if (stack.length) stack[stack.length - 1].children.push(node);
            else roots.push(node);
            continue;
        }
        stack.push(node);
    }
    if (stack.length) stack[stack.length - 1].directText += xml.slice(cursor);
    if (stack.length) {
        // Malformed sidecars are still best-effort evidence; do not make module
        // loading or generation fail merely because one capture is incomplete.
        while (stack.length) {
            const node = stack.pop();
            if (stack.length) stack[stack.length - 1].children.push(node);
            else roots.push(node);
        }
    }
    return roots;
}

function sampleFromNode(node) {
    const hasDirectHeaders = hasTag(node.directText, 'responseHeader');
    const hasDirectBody = hasTag(node.directText, 'responseData');
    const directHeaders = headersFromText(node.directText);
    const children = node.children.map(sampleFromNode);
    const directUrl = firstTag(node.directText, 'java\\.net\\.URL');
    const url = directUrl || children.find(child => child.url)?.url || '';
    const redirects = children.flatMap(child => [
        ...(isRedirect(child) ? [{
            status: child.status,
            url: child.url,
            location: firstHeader(child.directHeaders, 'location'),
            setCookies: headerValues(child.directHeaders, 'set-cookie'),
            responseBody: child.body || '',
            responseHeaders: child.directHeaders || [],
        }] : []),
        ...(child.redirects || []),
    ]);
    return {
        label: node.attrs.lb || '',
        status: Number(node.attrs.rc || 0),
        statusText: node.attrs.rm || '',
        success: node.attrs.s !== 'false',
        isTransaction: node.tag === 'sample',
        url,
        path: pathOf(url || node.attrs.lb || ''),
        urls: [url, ...children.flatMap(child => child.urls || [])].filter(Boolean),
        hasDirectHeaders,
        directHeaders,
        headers: directHeaders,
        sourceHeaders: [...directHeaders, ...children.flatMap(child => child.sourceHeaders || [])],
        hasDirectBody,
        body: firstTag(node.directText, 'responseData'),
        redirects,
        directUrl,
        hasRequestData: hasTag(node.directText, 'requestData'),
        requestData: firstTag(node.directText, 'requestData'),
        hasSamplerData: hasTag(node.directText, 'samplerData'),
        samplerData: firstTag(node.directText, 'samplerData'),
        requestHeaders: headersFromTag(node.directText, 'requestHeader'),
        cookies: cookiesFromText(node.directText),
    };
}

function attributes(source) {
    const out = {};
    for (const match of String(source || '').matchAll(/([:\w.-]+)\s*=\s*"([^"]*)"/g)) out[match[1]] = unescapeXml(match[2]);
    return out;
}

function firstTag(source, name) {
    const match = String(source || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return match ? unescapeXml(match[1].trim()) : '';
}

function hasTag(source, name) {
    return new RegExp(`<${name}\\b[^>]*>`, 'i').test(String(source || ''));
}

function headersFromText(source) {
    return headersFromTag(source, 'responseHeader');
}

function headersFromTag(source, name) {
    const headers = [];
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi');
    for (const match of String(source || '').matchAll(re)) headers.push(...parseHeaderBlock(unescapeXml(match[1])));
    return headers;
}

function cookiesFromText(source) {
    const values = [];
    const re = /<cookies\b[^>]*>([\s\S]*?)<\/cookies>/gi;
    for (const match of String(source || '').matchAll(re)) values.push(unescapeXml(match[1]));
    return values;
}

function parseHeaderBlock(value) {
    return String(value || '').split(/\r?\n/).map(line => {
        const colon = line.indexOf(':');
        return colon > 0 ? { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() } : null;
    }).filter(Boolean);
}

function normalizeHeaders(headers) {
    if (!Array.isArray(headers)) return [];
    return headers.map(header => ({ name: String(header.name || ''), value: String(header.value || '') })).filter(header => header.name);
}

function firstHeader(headers, name) {
    return (headers || []).find(header => header.name.toLowerCase() === name)?.value || '';
}

function headerValues(headers, name) {
    return (headers || []).filter(header => header.name.toLowerCase() === name).map(header => header.value);
}

function isRedirect(sample) {
    return sample.status >= 300 && sample.status < 400;
}

function pathOf(value) {
    try { return new URL(value).pathname || '/'; } catch { /* label/path fallback */ }
    return String(value || '').split('?')[0].match(/\/[^\s]*/) ? String(value).split('?')[0].match(/\/[^\s]*/)[0] : '';
}

function unescapeXml(value) {
    return String(value || '').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = { parseAndPair, parseSidecarBuffer, _internal: { parseSampleTree, pairEntries, sampleFromNode, flattenHttpSamples } };
