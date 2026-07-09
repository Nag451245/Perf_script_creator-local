'use strict';

function compareRecordedRequestToObserved({ entry = {}, observedRequest = {}, index = null, sampler = '' } = {}) {
    const issues = [];
    const recordedRequest = entry.request || {};
    const recordedUrl = parseUrl(recordedRequest.url);
    const observedUrl = parseUrl(observedRequest.url);

    if (recordedUrl && observedUrl) {
        for (const [name, recordedValue] of recordedUrl.searchParams.entries()) {
            const observedValue = observedUrl.searchParams.get(name);
            if (observedValue != null && observedValue !== recordedValue) {
                issues.push({ kind: 'queryValueDiff', name, recorded: recordedValue, observed: observedValue });
            }
        }
    }

    const recordedHeaders = normalizeRecordedHeaders(recordedRequest.headers || []);
    const observedHeaders = normalizeHeaderObject(observedRequest.headers || {});
    for (const [name, recordedValue] of Object.entries(recordedHeaders)) {
        const observedValue = observedHeaders[name];
        if (observedValue == null) {
            issues.push({ kind: 'headerMissing', name, recorded: recordedValue });
        } else if (observedValue === recordedValue && isLikelyDynamicHeader(name, recordedValue)) {
            issues.push({ kind: 'headerStillRecorded', name, recorded: recordedValue, observed: observedValue });
        } else if (observedValue !== recordedValue && !isExpectedHeaderDrift(name)) {
            issues.push({ kind: 'headerValueDiff', name, recorded: recordedValue, observed: observedValue });
        }
    }

    const recordedBody = bodyText(recordedRequest);
    const observedBody = String(observedRequest.body || '');
    if (recordedBody && observedBody) {
        issues.push(...compareJsonBodies(recordedBody, observedBody));
    }

    return { ok: issues.length === 0, index, sampler, issues };
}

function compareRedirectResponse({ recorded = {}, observed = {}, index = null, sampler = '' } = {}) {
    const issues = [];
    const recordedLocation = headerValue(recorded.headers, 'location');
    const observedLocation = headerValue(observed.headers, 'location');
    if (!recordedLocation || !observedLocation) return { ok: true, index, sampler, issues };

    const recordedUrl = parseUrl(recordedLocation, 'https://redirect.local');
    const observedUrl = parseUrl(observedLocation, 'https://redirect.local');
    if (!recordedUrl || !observedUrl) return { ok: true, index, sampler, issues };

    if (recordedUrl.pathname !== observedUrl.pathname) {
        issues.push({ kind: 'locationPathDiff', recorded: recordedUrl.pathname, observed: observedUrl.pathname });
    }
    for (const [name, recordedValue] of recordedUrl.searchParams.entries()) {
        const observedValue = observedUrl.searchParams.get(name);
        if (observedValue != null && observedValue !== recordedValue) {
            issues.push({ kind: 'locationParamDiff', name, recorded: recordedValue, observed: observedValue });
        }
    }
    return { ok: issues.length === 0, index, sampler, issues };
}

function normalizeRecordedHeaders(headers) {
    const out = {};
    for (const h of headers || []) {
        const name = String(h.name || '').toLowerCase();
        if (!name || isIgnoredHeader(name)) continue;
        out[name] = String(h.value || '');
    }
    return out;
}

function normalizeHeaderObject(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        const name = String(k || '').toLowerCase();
        if (!name || isIgnoredHeader(name)) continue;
        out[name] = Array.isArray(v) ? v.join(', ') : String(v || '');
    }
    return out;
}

function isIgnoredHeader(name) {
    return /^(host|content-length|connection|accept-encoding|user-agent)$/i.test(name);
}

function isExpectedHeaderDrift(name) {
    return /^(cookie|date|origin|referer)$/i.test(name);
}

function isLikelyDynamicHeader(name, value) {
    return /csrf|xsrf|token|authorization|session|request-id|traceparent/i.test(`${name} ${value}`);
}

function compareJsonBodies(recordedBody, observedBody) {
    try {
        const recorded = JSON.parse(recordedBody);
        const observed = JSON.parse(observedBody);
        return compareJsonValues(recorded, observed, '$');
    } catch {
        return recordedBody === observedBody ? [] : [{ kind: 'bodyTextDiff' }];
    }
}

function compareJsonValues(recorded, observed, path) {
    const issues = [];
    if (recorded == null || observed == null || typeof recorded !== 'object' || typeof observed !== 'object') {
        if (recorded !== observed) issues.push({ kind: 'bodyValueDiff', path, recorded, observed });
        return issues;
    }
    const keys = new Set([...Object.keys(recorded), ...Object.keys(observed)]);
    for (const key of keys) {
        if (!(key in observed)) issues.push({ kind: 'bodyFieldMissing', path: `${path}.${key}`, recorded: recorded[key] });
        else if (!(key in recorded)) issues.push({ kind: 'bodyFieldAdded', path: `${path}.${key}`, observed: observed[key] });
        else issues.push(...compareJsonValues(recorded[key], observed[key], `${path}.${key}`));
    }
    return issues;
}

function bodyText(request) {
    return request && request.postData && typeof request.postData.text === 'string' ? request.postData.text : '';
}

function parseUrl(url, base) {
    try { return new URL(String(url || ''), base); } catch { return null; }
}

function headerValue(headers, name) {
    const wanted = String(name || '').toLowerCase();
    if (Array.isArray(headers)) {
        const found = headers.find(h => String(h.name || '').toLowerCase() === wanted);
        return found ? String(found.value || '') : '';
    }
    for (const [k, v] of Object.entries(headers || {})) {
        if (String(k || '').toLowerCase() === wanted) return Array.isArray(v) ? v.join(', ') : String(v || '');
    }
    return '';
}

module.exports = {
    compareRecordedRequestToObserved,
    compareRedirectResponse,
};
