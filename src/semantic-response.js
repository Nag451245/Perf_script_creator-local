'use strict';

function compareRecordedLiveResponse({ recorded = {}, observed = {}, sampler = '', index = null } = {}) {
    const issues = [];
    const recordedBody = String(recorded.body || '');
    const observedBody = String(observed.body || '');
    const recordedJson = parseJson(recordedBody);
    const observedJson = parseJson(observedBody);
    const observedContentType = headerValue(observed.headers, 'content-type') || observed.contentType || '';

    if (recordedJson.ok && looksLikeHtmlLogin(observedBody, observedContentType)) {
        issues.push({
            kind: 'htmlLoginInsteadOfRecordedJson',
            severity: 'critical',
            message: 'Replay returned an HTML login page where the recording had JSON.',
        });
    }

    if (observedJson.ok && Array.isArray(observedJson.value.errors) && observedJson.value.errors.length > 0) {
        issues.push({
            kind: 'graphqlErrors',
            severity: 'critical',
            message: summarizeGraphqlErrors(observedJson.value.errors),
        });
    }

    if (recordedJson.ok && observedJson.ok) {
        const shapeIssues = compareJsonShape(recordedJson.value, observedJson.value);
        issues.push(...shapeIssues);
    }

    return {
        ok: issues.length === 0,
        index,
        sampler,
        issues,
    };
}

function parseJson(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        return { ok: false, value: null };
    }
}

function looksLikeHtmlLogin(body, contentType = '') {
    const text = String(body || '');
    if (!text) return false;
    const htmlish = /<html\b|<form\b|<title\b/i.test(text) || /text\/html/i.test(String(contentType || ''));
    if (!htmlish) return false;
    return /login|sign[\s-]?in|password|username|session expired|unauthorized/i.test(text);
}

function summarizeGraphqlErrors(errors) {
    const first = errors[0] || {};
    const message = typeof first.message === 'string' ? first.message : 'GraphQL response contains errors';
    return `GraphQL semantic error: ${message}`;
}

function compareJsonShape(recorded, observed, path = '$') {
    const issues = [];
    if (recorded == null || observed == null) {
        if (recorded !== observed) issues.push({ kind: 'jsonNullabilityDiff', path, severity: 'high' });
        return issues;
    }
    if (Array.isArray(recorded) || Array.isArray(observed)) {
        if (!Array.isArray(recorded) || !Array.isArray(observed)) {
            issues.push({ kind: 'jsonTypeDiff', path, recorded: typeOf(recorded), observed: typeOf(observed), severity: 'high' });
            return issues;
        }
        if (recorded.length > 0 && observed.length === 0) {
            issues.push({ kind: 'jsonArrayEmptied', path, severity: 'high' });
        }
        if (recorded.length > 0 && observed.length > 0) {
            issues.push(...compareJsonShape(recorded[0], observed[0], `${path}[0]`));
        }
        return issues;
    }
    if (typeof recorded === 'object' || typeof observed === 'object') {
        if (typeof recorded !== 'object' || typeof observed !== 'object') {
            issues.push({ kind: 'jsonTypeDiff', path, recorded: typeOf(recorded), observed: typeOf(observed), severity: 'high' });
            return issues;
        }
        const recordedKeys = Object.keys(recorded).sort();
        const observedKeys = Object.keys(observed).sort();
        const missing = recordedKeys.filter(k => !observedKeys.includes(k));
        const added = observedKeys.filter(k => !recordedKeys.includes(k));
        if (missing.length || added.length) {
            issues.push({ kind: 'jsonKeySetDiff', path, missing, added, severity: 'high' });
        }
        for (const key of recordedKeys.filter(k => observedKeys.includes(k))) {
            issues.push(...compareJsonShape(recorded[key], observed[key], `${path}.${key}`));
        }
    }
    return issues;
}

function typeOf(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
}

function headerValue(headers, name) {
    const wanted = String(name || '').toLowerCase();
    for (const [k, v] of Object.entries(headers || {})) {
        if (String(k || '').toLowerCase() === wanted) return Array.isArray(v) ? v.join(', ') : String(v || '');
    }
    return '';
}

module.exports = {
    compareRecordedLiveResponse,
    _internal: { parseJson, looksLikeHtmlLogin, compareJsonShape },
};
