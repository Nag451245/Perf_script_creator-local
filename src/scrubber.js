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

const SECRET_FIELD_NAMES = [
    'password', 'passwd', 'pwd', 'pass',
    'authorization', 'auth', 'apikey', 'api_key', 'api-key',
    'access_token', 'refresh_token', 'id_token',
    'x-api-key', 'x-auth-token',
    'ssn', 'pin', 'otp', 'mfa', 'totp',
    'creditcard', 'credit_card', 'cardnumber', 'cvv', 'cvc',
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

module.exports = { scrubRecordingXml, SECRET_FIELD_NAMES, REDACT };
