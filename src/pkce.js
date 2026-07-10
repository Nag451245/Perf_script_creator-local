'use strict';
/**
 * pkce.js — OAuth2 PKCE (RFC 7636) detection and honest handling guidance.
 *
 * PKCE ties an /authorize request (carrying code_challenge + code_challenge_method)
 * to a later /token exchange (carrying code_verifier). The server verifies
 * transform(code_verifier) === code_challenge, where transform is:
 *   - 'plain' : identity            (challenge === verifier)
 *   - 'S256'  : base64url(SHA-256(verifier))
 *
 * Handling policy (senior-PE, converge-or-report):
 *   - 'plain'  : the algorithm is the identity, so we CAN mint fresh values
 *                natively (challenge === verifier === __RandomString) — Java-safe.
 *   - 'S256'   : base64url(SHA-256(...)) has no clean native JMeter function, so
 *                under Java-safe mode we DO NOT fake it; we flag the precise
 *                unresolved requirement (JSR223 opt-in needed, or replay the
 *                recorded pair if the server tolerates challenge reuse).
 *
 * This module is a read-only analyzer over HAR-shaped entries; it never rewrites
 * a JMX. Callers surface `note`/`blocker` in the reasoning + human-questions.
 */

const AUTHORIZE_PATH_RE = /\/(?:authorize|authorization|connect\/authorize|oauth2?\/authorize|as\/authorization\.oauth2)\b/i;

function fieldsFromEntry(entry) {
    const req = (entry && entry.request) || {};
    const fields = new Map();
    const put = (name, value) => {
        const key = String(name || '').trim().toLowerCase();
        if (key && !fields.has(key)) fields.set(key, String(value == null ? '' : value));
    };
    try {
        const u = new URL(String(req.url || ''));
        for (const [name, value] of u.searchParams.entries()) put(name, value);
    } catch { /* unparseable URL */ }
    for (const pair of req.queryString || []) put(pair.name, pair.value);
    const body = String((req.postData && req.postData.text) || '');
    if (body && body.includes('=') && !body.trim().startsWith('{')) {
        for (const seg of body.split('&')) {
            const idx = seg.indexOf('=');
            if (idx > 0) {
                let n = seg.slice(0, idx); let v = seg.slice(idx + 1);
                try { n = decodeURIComponent(n.replace(/\+/g, ' ')); } catch { /* keep raw */ }
                try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* keep raw */ }
                put(n, v);
            }
        }
    }
    return fields;
}

function analyzePkce(entries = []) {
    let method = null;
    let challengeSeen = false;
    let verifierSeen = false;
    let authorizeUrl = '';
    for (const entry of entries || []) {
        const url = String((entry && entry.request && entry.request.url) || '');
        const fields = fieldsFromEntry(entry);
        if (fields.has('code_challenge')) {
            challengeSeen = true;
            if (AUTHORIZE_PATH_RE.test(url) && !authorizeUrl) authorizeUrl = url.split('?')[0];
            const m = String(fields.get('code_challenge_method') || '').trim().toUpperCase();
            if (m) method = m;
        }
        if (fields.has('code_verifier')) verifierSeen = true;
    }
    if (!challengeSeen && !verifierSeen) return { present: false };

    // Default per RFC 7636 §4.3: absent method means 'plain'.
    const resolvedMethod = method || 'PLAIN';
    const isS256 = resolvedMethod === 'S256';
    const result = {
        present: true,
        method: resolvedMethod,
        authorizeUrl,
        challengeSeen,
        verifierSeen,
        nativeSafe: !isS256,
    };
    if (!isS256) {
        result.handling = 'plain';
        result.note = {
            title: 'oauth-pkce-plain',
            summary: `PKCE (${resolvedMethod}) detected: code_challenge equals code_verifier, so fresh values can be minted natively.`,
            why: 'plain PKCE transform is the identity function — no hashing required.',
            action: 'mint a single ${__RandomString(64,abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~,)} and use it for both code_challenge and code_verifier.',
        };
    } else {
        result.handling = 's256_unresolved';
        result.blocker = {
            requirement: 'oauth_pkce_s256',
            title: 'OAuth2 PKCE S256 requires SHA-256(base64url) that JMeter cannot compute Java-safe',
            detail: 'code_challenge = base64url(SHA-256(code_verifier)). There is no native JMeter function for base64url of a raw SHA-256 digest, so a fresh S256 challenge cannot be produced without scripting.',
            options: [
                'Enable JSR223 opt-in (agent.javaSafeMode=false) so a Groovy PreProcessor can compute the challenge from a fresh verifier.',
                'If the authorization server tolerates challenge reuse, replay the recorded code_verifier/code_challenge pair as-is (already the default — PKCE binds the challenge to a fresh auth code each run).',
                'Provide a pre-computed verifier/challenge pair via test data if the server enforces one-time challenges.',
            ],
        };
    }
    return result;
}

// The Java-safe native expression for a plain-PKCE verifier (== challenge).
function nativePlainPkceExpression() {
    return '${__RandomString(64,abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~,)}';
}

module.exports = { analyzePkce, nativePlainPkceExpression, _internal: { fieldsFromEntry } };
