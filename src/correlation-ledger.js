'use strict';

const CREDENTIAL_NAME_RE = /^(?:user(name)?|email|password|passwd|pwd|login|account)$/i;
const STABLE_CONFIG_NAME_RE = /^(?:response_type|grant_type|client_id|client_secret|scope|redirect_uri|audience)$/i;
const SUPPORTED_ALGORITHMS = new Set(['uuid', 'timestamp', 'pkce-verifier', 'pkce-challenge', 'oauth-nonce']);
const TRANSPORT_HEADER_RE = /^(?:accept|accept-encoding|accept-language|cache-control|connection|content-length|content-type|host|origin|referer|sec-[\w-]+|user-agent|x-requested-with)$/i;
const PROTOCOL_CORRELATION_NAME_RE = /(?:csrf|xsrf|token|state|nonce|(?:auth|access|id)[_-]?code|verifier|challenge|session|saml|relaystate)/i;

function buildCorrelationLedger({ primaryEntries = [], secondaryEntries = [], candidates = [] } = {}) {
    const entries = Array.isArray(primaryEntries) ? primaryEntries : [];
    const secondary = Array.isArray(secondaryEntries) ? secondaryEntries : [];
    const normalizedCandidates = dedupeCandidates([...(candidates || []), ...inferCandidates(entries)]);
    const ledgerEntries = normalizedCandidates.map(candidate => reconstructValue(candidate, entries, secondary));
    const roleCounts = {};
    for (const item of ledgerEntries) roleCounts[item.role] = (roleCounts[item.role] || 0) + 1;
    const unresolvedSinks = ledgerEntries
        .filter(item => item.role === 'unresolved')
        .map(item => ({ name: item.name, value: item.value, sinkIndexes: item.consumerIndexes }));
    return { entries: ledgerEntries, roleCounts, unresolvedSinks };
}

function reconstructValue(candidate, entries, secondary) {
    const name = String(candidate.name || '');
    const value = String(candidate.value == null ? '' : candidate.value);
    const producers = findProducers(entries, value);
    const sinks = findSinks(entries, name, value);
    const consumerIndexes = [...new Set(sinks.map(sink => sink.entryIndex))];
    const consumerLinks = linkConsumersToProducers(sinks, producers);
    const precedingProducers = producers.filter(producer => consumerLinks.some(link => link.producerIndex === producer.entryIndex));
    const role = classifyRole({ name, value, candidate, producers, precedingProducers, sinks, entries, secondary });
    return {
        name,
        value,
        role: role.role,
        reason: role.reason,
        evidence: role.evidence,
        necessity: role.necessity,
        ...(role.algorithm ? { algorithm: role.algorithm } : {}),
        producerIndexes: producers.map(producer => producer.entryIndex),
        consumerIndexes,
        consumerLinks,
        producers,
        sinks,
    };
}

function classifyRole({ name, value, candidate, producers, precedingProducers, sinks, entries, secondary }) {
    if (isTransportCandidate(candidate, sinks)) {
        return {
            role: 'static-config',
            necessity: 'keep-literal',
            reason: 'Standard transport/content header is request configuration, not correlation state.',
            evidence: `inferred ${candidate.sourceLocation || 'header'} sink`,
        };
    }
    const cookieOnly = sinks.length && sinks.every(sink => /^header:cookie$/i.test(sink.location));
    const setCookieProducer = precedingProducers.find(producer => /^response-header:set-cookie$/i.test(producer.location));
    if (setCookieProducer && cookieOnly) {
        return {
            role: 'native-managed-state',
            necessity: 'native-manager',
            reason: 'Set-Cookie is consumed only through Cookie headers.',
            evidence: `producer entry ${setCookieProducer.entryIndex}; Cookie sinks ${sinks.map(s => s.entryIndex).join(', ')}`,
        };
    }
    if (precedingProducers.length && sinks.length) {
        return {
            role: 'server-issued-correlation',
            necessity: 'required',
            reason: 'A recorded response produces this value before a non-native request sink.',
            evidence: `producer entries ${precedingProducers.map(p => p.entryIndex).join(', ')}; sinks ${sinks.map(s => `${s.entryIndex}:${s.location}`).join(', ')}`,
        };
    }
    if (CREDENTIAL_NAME_RE.test(name)) {
        return {
            role: 'user-test-input',
            necessity: 'parameterize',
            reason: 'Credential/business input has no recorded response producer.',
            evidence: `request sinks ${sinks.map(s => s.entryIndex).join(', ') || 'none'}`,
        };
    }
    if (candidate.inferred) {
        if (isCookieCandidate(candidate)) {
            return {
                role: 'native-managed-state',
                necessity: 'native-manager',
                reason: 'Cookie request state is owned by JMeter Cookie Manager.',
                evidence: `inferred ${candidate.sourceLocation || 'Cookie header'} sink`,
            };
        }
        if (isStableLiteral(candidate, name, value, entries, secondary)) {
            return {
                role: 'static-config',
                necessity: 'keep-literal',
                reason: 'Inferred literal is stable across the available recordings.',
                evidence: secondary.length ? 'primary and secondary recordings agree' : `inferred ${candidate.sourceLocation || 'request'} literal`,
            };
        }
        if (isOrdinaryInputCandidate(candidate, name)) {
            return {
                role: 'user-test-input',
                necessity: 'parameterize',
                reason: 'Inferred request body field is ordinary business/test input, not protocol state.',
                evidence: `inferred ${candidate.sourceLocation || 'request-body'} sink`,
            };
        }
        if (!isProtocolCandidate(candidate, name)) {
            return {
                role: 'static-config',
                necessity: 'keep-literal',
                reason: 'Producerless inferred literal has no protocol correlation semantics.',
                evidence: `inferred ${candidate.sourceLocation || 'request'} literal`,
            };
        }
    }
    if (isStableConfig(name, value, entries, secondary)) {
        return {
            role: 'static-config',
            necessity: 'keep-literal',
            reason: 'Known endpoint/config field is stable in the available recordings.',
            evidence: secondary.length ? 'primary and secondary recordings agree' : 'known stable config field in primary recording',
        };
    }
    const algorithm = clientAlgorithm(candidate);
    if (algorithm) {
        return {
            role: 'client-computed',
            necessity: 'synthesize',
            reason: 'Request-only value has a known generation algorithm.',
            evidence: `explicit algorithm: ${algorithm.id}`,
            algorithm,
        };
    }
    return {
        role: 'unresolved',
        necessity: 'investigate',
        reason: 'No recorded server producer and no known native, input, static, or client algorithm classification.',
        evidence: `request sinks ${sinks.map(s => s.entryIndex).join(', ') || 'none'}`,
    };
}

function isProtocolCandidate(candidate, name) {
    const field = String(name || '');
    if (/^(?:authorization|sid)$/i.test(field) || PROTOCOL_CORRELATION_NAME_RE.test(field)) return true;
    if (!/^code$/i.test(field)) return false;
    if (candidate.protocol === true || candidate.protocol === 'auth') return true;
    return /(?:oauth|oidc|authorize|callback|token|saml|login)/i.test(String(candidate.requestPath || candidate.requestUrl || ''));
}

function isCookieCandidate(candidate) {
    return String(candidate.source || '').toLowerCase() === 'header' && /^cookie$/i.test(String(candidate.name || ''));
}

function isTransportCandidate(candidate, sinks = []) {
    return TRANSPORT_HEADER_RE.test(String(candidate.name || '')) &&
        (String(candidate.source || '').toLowerCase() === 'header' || (sinks || []).some(sink => /^header:/i.test(sink.location)));
}

function isOrdinaryInputCandidate(candidate, name) {
    return ['json', 'form', 'post-data-param'].includes(String(candidate.source || '').toLowerCase()) &&
        !PROTOCOL_CORRELATION_NAME_RE.test(String(name || ''));
}

function isStableLiteral(candidate, name, value, entries, secondary) {
    if (!secondary.length) return false;
    return findSinks(entries, name, value).length > 0 && findSinks(secondary, name, value).length > 0;
}

function findProducers(entries, value) {
    if (!value) return [];
    const producers = [];
    entries.forEach((entry, entryIndex) => {
        const response = entry && entry.response || {};
        const body = String(response.content && response.content.text || '');
        if (body.includes(value)) producers.push({ entryIndex, location: 'response-body', value });
        for (const header of response.headers || []) {
            if (String(header.value || '').includes(value)) {
                producers.push({ entryIndex, location: `response-header:${header.name}`, headerName: header.name, value });
            }
        }
    });
    return producers;
}

function findSinks(entries, name, value) {
    if (!value) return [];
    const sinks = [];
    entries.forEach((entry, entryIndex) => {
        const request = entry && entry.request || {};
        for (const pair of rawUrlQuery(String(request.url || ''))) {
            if (pair.value === value) sinks.push(sink(entryIndex, `url-query:${pair.name}`, pair.name, value, pair.rawValue));
        }
        for (const pair of request.queryString || []) {
            const rawValue = String(pair.value || '');
            if (decode(rawValue) === value) sinks.push(sink(entryIndex, `query-string:${pair.name}`, pair.name, value, rawValue));
        }
        for (const pair of request.postData && request.postData.params || []) {
            const rawValue = String(pair.value || '');
            if (decode(rawValue) === value) sinks.push(sink(entryIndex, `post-data-param:${pair.name}`, pair.name, value, rawValue));
        }
        for (const header of request.headers || []) {
            if (String(header.value || '').includes(value)) {
                sinks.push({ entryIndex, location: `header:${header.name}`, name: header.name, value });
            }
        }
        const body = String(request.postData && request.postData.text || '');
        collectBodySinks(body, entryIndex, value, sinks);
    });
    return dedupeSinks(sinks);
}

function sink(entryIndex, location, name, value, rawValue) {
    return { entryIndex, location, name, value, rawValue, encoding: rawValue === value ? 'plain' : 'percent-encoded' };
}

function rawUrlQuery(url) {
    const query = String(url).split('?')[1] || '';
    return query.split('#')[0].split('&').filter(Boolean).map(segment => {
        const index = segment.indexOf('=');
        const rawName = index < 0 ? segment : segment.slice(0, index);
        const rawValue = index < 0 ? '' : segment.slice(index + 1);
        return { name: decode(rawName), value: decode(rawValue), rawValue };
    });
}

function collectBodySinks(body, entryIndex, value, sinks) {
    const text = String(body || '').trim();
    if (!text) return;
    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            collectJsonSinks(JSON.parse(text), entryIndex, value, sinks);
            return;
        } catch { /* form parsing below */ }
    }
    for (const segment of text.split('&')) {
        const index = segment.indexOf('=');
        if (index <= 0) continue;
        const rawName = segment.slice(0, index);
        const rawValue = segment.slice(index + 1);
        if (decode(rawValue) === value) sinks.push(sink(entryIndex, `form:${decode(rawName)}`, decode(rawName), value, rawValue));
    }
}

function collectJsonSinks(node, entryIndex, value, sinks, path = '') {
    if (!node || typeof node !== 'object') return;
    for (const [name, item] of Object.entries(node)) {
        const segment = Array.isArray(node) ? `[${name}]` : (path ? `.${name}` : name);
        const fullPath = Array.isArray(node) ? `${path}${segment}` : `${path}${segment}`;
        if (item && typeof item === 'object') collectJsonSinks(item, entryIndex, value, sinks, fullPath);
        else if (String(item) === value) sinks.push(sink(entryIndex, `json:${fullPath}`, fullPath, value, String(item)));
    }
}

function decode(value) {
    try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); } catch { return String(value || ''); }
}

function isStableConfig(name, value, entries, secondary) {
    if (!STABLE_CONFIG_NAME_RE.test(name)) return false;
    if (!secondary.length) return true;
    return findSinks(entries, name, value).length > 0 && findSinks(secondary, name, value).length > 0;
}

function clientAlgorithm(candidate) {
    const id = String(candidate && candidate.algorithm || '').toLowerCase();
    return SUPPORTED_ALGORITHMS.has(id) ? { id, evidence: 'candidate.algorithm' } : null;
}

function inferCandidates(entries) {
    const candidates = [];
    entries.forEach(entry => {
        const request = entry && entry.request || {};
        const context = { requestUrl: String(request.url || ''), requestPath: pathOfRequest(request.url) };
        for (const pair of request.queryString || []) candidates.push(inferred(pair, 'query-string', `query-string:${pair.name}`, context));
        try {
            const parsed = new URL(String(request.url || ''));
            for (const [name, value] of parsed.searchParams) candidates.push(inferred({ name, value }, 'url-query', `url-query:${name}`, context));
        } catch { /* ignore malformed recording URL */ }
        for (const header of request.headers || []) candidates.push(inferred(header, 'header', `header:${header.name}`, context));
        for (const pair of request.postData && request.postData.params || []) candidates.push(inferred(pair, 'post-data-param', `post-data-param:${pair.name}`, context));
        collectBodyCandidates(String(request.postData && request.postData.text || ''), candidates, context);
    });
    return candidates;
}

function inferred(candidate, source, sourceLocation, context = {}) {
    return { ...candidate, inferred: true, source, sourceLocation, ...context };
}

function collectBodyCandidates(body, candidates, context = {}) {
    const text = String(body || '').trim();
    if (!text) return;
    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            collectJsonCandidates(JSON.parse(text), candidates, '', context);
            return;
        } catch { /* fall through to form fields */ }
    }
    for (const segment of text.split('&')) {
        const index = segment.indexOf('=');
        if (index <= 0) continue;
        const name = decode(segment.slice(0, index));
        candidates.push(inferred({ name, value: decode(segment.slice(index + 1)) }, 'form', `form:${name}`, context));
    }
}

function collectJsonCandidates(node, candidates, prefix = '', context = {}) {
    if (!node || typeof node !== 'object') return;
    for (const [name, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${name}` : name;
        if (value && typeof value === 'object') collectJsonCandidates(value, candidates, path, context);
        else candidates.push(inferred({ name, value: String(value) }, 'json', `json:${path}`, context));
    }
}

function pathOfRequest(url) {
    try { return new URL(String(url || '')).pathname; } catch { return String(url || ''); }
}

function dedupeCandidates(candidates) {
    const seen = new Set();
    return (candidates || []).filter(candidate => {
        const key = `${candidate.name}\n${candidate.value}`;
        if (!candidate.name || candidate.value == null || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function dedupeSinks(sinks) {
    const seen = new Set();
    return sinks.filter(sink => {
        const key = `${sink.entryIndex}\n${sink.location}\n${sink.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function linkConsumersToProducers(sinks, producers) {
    const links = [];
    const seen = new Set();
    for (const sink of sinks) {
        const prior = producers.filter(producer => producer.entryIndex < sink.entryIndex).pop();
        if (!prior) continue;
        const key = `${sink.entryIndex}\n${prior.entryIndex}\n${sink.location}\n${sink.name}\n${sink.encoding || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
            consumerIndex: sink.entryIndex, producerIndex: prior.entryIndex,
            location: sink.location, name: sink.name, encoding: sink.encoding || 'plain',
        });
    }
    return links;
}

module.exports = {
    buildCorrelationLedger,
    _internal: { findProducers, findSinks, classifyRole, isStableConfig, clientAlgorithm, linkConsumersToProducers, inferCandidates, isProtocolCandidate },
};
