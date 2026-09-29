'use strict';
/**
 * scrubber.js — redact obvious secrets from the recording.xml sidecar so the
 * artifact is shareable without leaking PHI / credentials. Originals are
 * kept in a sibling `<name>_secrets.json` (gitignored) so the test still
 * has the real values when the user reruns with the recording attached.
 *
 * Conservative by design: we only redact fields whose NAME is in a known
 * secret list (case-insensitive). Random-looking blobs are left alone —
 * a JMeter session token IS sensitive but it's also what makes the
 * recording reproducible; the correlation engine needs it intact.
 *
 * String-in / string-out. Idempotent.
 */

// Only fields the correlation engine does NOT need to keep intact. We
// deliberately do NOT scrub session/CSRF/state tokens here — those make the
// recording reproducible and the correlation engine reads this artifact.
const SECRET_FIELD_NAMES = [
    'password', 'passwd', 'pwd', 'pass',
    'authorization', 'auth', 'apikey', 'api_key', 'api-key',
    'access_token', 'refresh_token', 'id_token',
    'x-api-key', 'x-auth-token',
    'client_secret', 'clientsecret', 'secret', 'private_key', 'privatekey', 'client_assertion',
    'ssn', 'pin', 'otp', 'mfa', 'totp', 'securityanswer', 'security_answer',
    'creditcard', 'credit_card', 'cardnumber', 'cardnum', 'cvv', 'cvc', 'iban',
    'dob', 'date_of_birth', 'dateofbirth', 'taxid', 'tax_id', 'passport', 'nationalid', 'national_id',
];
const REDACT = '***REDACTED***';

function scrubRecordingXml(xml) {
    if (!xml) return { xml, hits: [] };
    const hits = [];

    const fieldAlternation = SECRET_FIELD_NAMES
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

    // Patterns are best-effort: we scrub in the most common shapes we
    // emit (samplerData and request/response header blocks).
    const patterns = [
        // application/x-www-form-urlencoded: name=value. Recording XML
        // escapes `&` as `&amp;`, so we accept `;` (last char of `&amp;`)
        // as a separator too. `\b` covers the start-of-line case.
        new RegExp(`(?:^|[?&;])(?:${fieldAlternation})=([^&\\s"'<;]+)`, 'gi'),
        // JSON: "name":"value"
        new RegExp(`"(?:${fieldAlternation})"\\s*:\\s*"([^"]+)"`, 'gi'),
        // Header: Name: value. In our recording.xml each header line either
        // starts the line OR sits right after an XML open tag like
        // <requestHeader>Authorization: …, so we accept both boundaries.
        new RegExp(`(?:^|>)\\s*(${fieldAlternation}):\\s*([^\\r\\n<]+)`, 'gim'),
    ];

    let out = xml;
    // Per-pattern callback: each pattern documents which capture holds the
    // secret value, so we never confuse a regex-offset arg with a string.
    const valueGetters = [
        (m, v) => v,         // pattern 0: form-encoded, group 1 = value
        (m, v) => v,         // pattern 1: JSON, group 1 = value
        (m, name, v) => v,   // pattern 2: header,  group 1 = name, group 2 = value
    ];
    for (let i = 0; i < patterns.length; i++) {
        const get = valueGetters[i];
        out = out.replace(patterns[i], (...args) => {
            const m = args[0];
            const value = get(...args);
            if (value == null || typeof value !== 'string') return m;
            hits.push({ original: value });
            return m.split(value).join(REDACT);
        });
    }

    return { xml: out, hits };
}

/**
 * Redact the same secret-NAMED fields from anything about to leave this
 * machine — the LLM prompt payload above all. The README's promise is that
 * PHI and credentials stay local; the prompt carries JMX snippets, failing
 * response bodies and headers, so it needs the same treatment the shareable
 * recording gets.
 *
 * Deliberately the SAME conservative rule, not a stronger one: session, CSRF,
 * state and nonce values are exactly what the model must see to propose a
 * correlation, and redacting them would leave it guessing — which is how
 * hallucinated extractors get invented. Names on the secret list (password,
 * Authorization, SSN, card, DOB…) are never correlation targets, so removing
 * them costs the model nothing.
 *
 * Walks strings, arrays and objects; returns the same shape.
 */
function redactForExternal(value) {
    if (value == null) return value;
    if (typeof value === 'string') return scrubRecordingXml(value).xml;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(redactForExternal);
    const out = {};
    for (const [key, val] of Object.entries(value)) {
        out[key] = SECRET_FIELD_NAMES.includes(String(key).toLowerCase())
            ? REDACT
            : redactForExternal(val);
    }
    return out;
}

function sanitizeRunEvidenceForExternal(evidence = {}) {
    const rows = Array.isArray(evidence.rows) ? evidence.rows : [];
    return {
        observedBodiesBackfilled: Number(evidence.observedBodiesBackfilled || 0),
        rows: rows.map(row => ({
            entryIndex: row.entryIndex,
            sampleIndex: row.sampleIndex,
            label: row.label,
            method: row.method,
            recordedStatus: row.recordedStatus,
            observedStatus: row.observedStatus,
            recordedBodyLength: row.recordedBodyLength,
            observedBodyLength: row.observedBodyLength,
            assertionFailure: redactForExternal(row.assertionFailure || ''),
            success: row.success,
            renderedRequest: sanitizeRenderedRequestForExternal(row.renderedRequest),
            redirects: (row.redirects || []).map(redirect => ({
                status: redirect.status,
                url: sanitizeUrl(redirect.url),
                location: sanitizeUrl(redirect.location),
                setCookies: (redirect.setCookies || []).map(value => ({ present: Boolean(value) })),
            })),
        })),
    };
}

function sanitizeRenderedRequestForExternal(request) {
    if (!request) return null;
    const headers = (request.headers || []).map(header => ({
        name: String(header.name || ''),
        value: sensitiveName(header.name) || String(header.name || '').toLowerCase() === 'cookie'
            ? REDACT : redactForExternal(String(header.value || '')),
        present: Boolean(header.value),
    }));
    const query = {};
    for (const [name, value] of Object.entries(request.query || {})) {
        query[name] = sensitiveName(name) ? REDACT : redactForExternal(value);
    }
    return {
        method: request.method || '',
        url: sanitizeUrl(request.url),
        query,
        headers,
        cookies: (request.cookies || []).map(cookie => ({
            name: String(cookie.name || ''),
            value: REDACT,
            present: Boolean(cookie.value),
        })),
        body: {
            present: Boolean(request.body),
            length: String(request.body || '').length,
        },
    };
}

function sanitizeUrl(value) {
    const raw = String(value || '');
    try {
        const url = new URL(raw);
        for (const [name] of url.searchParams) {
            if (sensitiveName(name)) url.searchParams.set(name, REDACT);
        }
        const parts = url.pathname.split('/');
        for (let index = 1; index < parts.length - 1; index++) {
            if (!isSensitiveRoute(parts[index])) continue;
            if (isKnownAuthRoute(parts[index + 1])) continue;
            parts[index + 1] = REDACT;
        }
        url.pathname = parts.join('/');
        return url.toString();
    } catch {
        return redactForExternal(raw);
    }
}

function isSensitiveRoute(segment) {
    return /^(?:auth|callback|reset|token|authorize|sso)$/i.test(String(segment || ''));
}

function isKnownAuthRoute(segment) {
    return /^(?:callback|reset|token|authorize|sso)$/i.test(String(segment || ''));
}

function sensitiveName(name) {
    const normalized = String(name || '').toLowerCase().replace(/[-_\s]/g, '');
    return SECRET_FIELD_NAMES.some(secret => secret.replace(/[-_]/g, '') === normalized) ||
        /(?:token|session|cookie|authorization|password|secret|csrf|xsrf|state|code|saml|relay)/i.test(normalized);
}

module.exports = {
    scrubRecordingXml,
    redactForExternal,
    sanitizeRunEvidenceForExternal,
    SECRET_FIELD_NAMES,
    REDACT,
};
