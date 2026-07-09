'use strict';

const KNOWN_VOLATILE_NAMES = new Set([
    'state',
    'state-small',
    'statesmall',
    'nonce',
    'code',
    'auth_code',
    'authorization_code',
    'response_type',
    'relaystate',
    'samlrequest',
    'samlresponse',
    'code_verifier',
    'code_challenge',
    'code_challenge_method',
    'session_state',
]);

const BUSINESS_NAME_RE = /^(user(name)?|email|password|passwd|pwd|login|account|customer|coupon|promo|sku|product|item|amount|price|quantity|order|task|title|name|search|query)$/i;
const PROTOCOL_NAME_HINT_RE = /state|nonce|code|csrf|xsrf|relay|saml|execution|session|challenge|verifier|transaction|txn|flow|conversation|tab|ctx|context|request|auth|sid|rid|trace/i;
const AUTH_CONTEXT_RE = /\/authorize\b|\/oauth\b|\/token\b|\/callback\b|\/saml\b|\/sso\b|\/login\b|\/resume\b|openid|response_type=code|client_id=|redirect_uri=|code_challenge|code_verifier|samlrequest|samlresponse|relaystate/i;

function filterVolatileProtocolCorrelations(corrs, entries) {
    const observed = observeVolatileProtocolFields(entries);
    const observedNames = new Set(observed.map(f => f.name));
    const observedValues = new Set(observed.map(f => f.value).filter(Boolean));
    const hasAuthContext = observed.length > 0 || entriesHaveAuthProtocolContext(entries);
    const kept = [];
    const removed = [];

    for (const c of corrs || []) {
        const name = normalizeName(c.variableName || c.name || c.var || c.refName);
        const value = String(c.value == null ? '' : c.value);
        if (hasAuthContext && (
            observedNames.has(name) ||
            observedValues.has(value) ||
            isVolatileProtocolField(name, value)
        )) {
            removed.push(c);
        } else {
            kept.push(c);
        }
    }

    return { kept, removed, observedNames: [...observedNames].sort(), observed };
}

function observeVolatileProtocolFields(entries) {
    const observed = [];
    for (const e of entries || []) {
        if (!entryHasAuthProtocolContext(e)) continue;
        for (const field of requestFields(e)) {
            if (isVolatileProtocolField(field.name, field.value)) {
                observed.push(field);
            }
        }
    }
    return dedupeFields(observed);
}

function observedVolatileProtocolNames(entries) {
    return observeVolatileProtocolFields(entries).map(f => f.name).sort();
}

function entriesHaveAuthProtocolContext(entries) {
    return (entries || []).some(entryHasAuthProtocolContext);
}

function entryHasAuthProtocolContext(entry) {
    const req = entry && entry.request ? entry.request : {};
    const url = String(req.url || '');
    const body = String(req.postData && req.postData.text || '');
    return AUTH_CONTEXT_RE.test(`${url}\n${body}`);
}

function requestFields(entry) {
    const req = entry && entry.request ? entry.request : {};
    const fields = [];
    try {
        const u = new URL(String(req.url || ''));
        for (const [name, value] of u.searchParams.entries()) {
            fields.push({ name: normalizeName(name), value: String(value || ''), location: 'query' });
        }
    } catch { /* ignore unparseable URLs */ }

    for (const pair of req.queryString || []) {
        fields.push({ name: normalizeName(pair.name), value: String(pair.value || ''), location: 'query' });
    }

    const body = String(req.postData && req.postData.text || '');
    if (body) {
        collectBodyFields(body, fields);
    }
    return fields.filter(f => f.name);
}

function collectBodyFields(body, fields) {
    const text = body.trim();
    if (!text) return;

    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            collectJsonFields(JSON.parse(text), fields);
            return;
        } catch { /* fall through to form-ish parsing */ }
    }

    if (text.includes('=')) {
        for (const segment of text.split('&')) {
            const idx = segment.indexOf('=');
            if (idx <= 0) continue;
            fields.push({
                name: normalizeName(decodeMaybe(segment.slice(0, idx))),
                value: decodeMaybe(segment.slice(idx + 1)),
                location: 'body',
            });
        }
    }
}

function collectJsonFields(value, fields) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) collectJsonFields(item, fields);
        return;
    }
    for (const [name, v] of Object.entries(value)) {
        if (v && typeof v === 'object') {
            collectJsonFields(v, fields);
        } else {
            fields.push({ name: normalizeName(name), value: String(v == null ? '' : v), location: 'body' });
        }
    }
}

function isVolatileProtocolField(name, value) {
    const normalized = normalizeName(name);
    if (!normalized || BUSINESS_NAME_RE.test(normalized)) return false;
    if (/^(state|nonce)_\d+$/.test(normalized)) return false;
    if (KNOWN_VOLATILE_NAMES.has(normalized)) return true;
    return PROTOCOL_NAME_HINT_RE.test(normalized) && looksSingleUseValue(value);
}

function looksSingleUseValue(value) {
    const s = String(value == null ? '' : value).trim();
    if (s.length < 8 || /\s/.test(s)) return false;
    if (/^https?:\/\//i.test(s) || /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(s)) return false;
    const unique = new Set(s).size;
    const mixed = /[A-Za-z]/.test(s) && /[0-9]/.test(s);
    const encodedOrToken = /[-_.~+/=%]/.test(s);
    return unique >= 6 && (mixed || encodedOrToken || s.length >= 16);
}

function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
}

function decodeMaybe(value) {
    try {
        return decodeURIComponent(String(value || '').replace(/\+/g, ' '));
    } catch {
        return String(value || '');
    }
}

function dedupeFields(fields) {
    const seen = new Set();
    const out = [];
    for (const f of fields) {
        const key = `${f.name}\n${f.value}\n${f.location}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
    }
    return out;
}

module.exports = {
    filterVolatileProtocolCorrelations,
    observeVolatileProtocolFields,
    observedVolatileProtocolNames,
    _internal: {
        isVolatileProtocolField,
        looksSingleUseValue,
        entryHasAuthProtocolContext,
    },
};
