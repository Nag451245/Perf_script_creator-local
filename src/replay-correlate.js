'use strict';
/**
 * replay-correlate.js — step 1: replay-driven feedback correlation.
 *
 * The universal, app-agnostic core. Instead of statically guessing correlations
 * once, it REPLAYS the recorded flow against the live target and learns from the
 * server's actual responses:
 *
 *   1. STATIC PRE-PASS  — from the recording, link every dynamic value used in a
 *      request to the NEAREST prior response that produced it, capturing a
 *      left/right boundary (so we can re-extract the LIVE value later). Nearest-
 *      prior + boundary handles multi-attempt flows and value collisions without
 *      app-specific knowledge.
 *   2. LIVE REPLAY      — replay in order with a real cookie jar. At each producer
 *      response, re-extract the value by its boundary → store as a var. At each
 *      consumer request, substitute the LIVE var (via fast-replay's ${var}
 *      substitution). This proves the correlation against the real server.
 *   3. VERIFY           — compare each live status to the recording; report the
 *      first divergence and whether the flow reached the end.
 *
 * Output is the set of VERIFIED producer→consumer correlations (with boundaries),
 * ready to emit as JMeter extractors+substitutions — plus the un-correlatable
 * values (no producer) which are candidates for synthesis (PKCE/UUID/state) or
 * disable (IdP plumbing).
 */
const { replayOne } = require('./fast-replay');

const MIN_LEN = 8;          // ignore short/ambiguous values
const CTX = 24;             // boundary context length

// A value worth correlating: long-ish, mixed alphanumeric or token-shaped, and
// not an obvious word/number. Deliberately permissive — the replay verifies.
function isDynamic(value) {
    if (!value || typeof value !== 'string' || value.length < MIN_LEN) return false;
    if (/^\d+$/.test(value)) return value.length >= 10;          // long numeric ids ok
    if (!/[0-9]/.test(value) && /^[a-z ]+$/i.test(value)) return false; // plain words
    return /^[A-Za-z0-9._~%+/=:-]{8,}$/.test(value);
}

// Pull candidate dynamic values out of a request (URL query/path, body, headers).
function requestValues(entry) {
    const out = new Set();
    const url = entry.request && entry.request.url || '';
    try {
        const u = new URL(url);
        for (const v of u.searchParams.values()) if (isDynamic(v)) out.add(v);
        for (const seg of u.pathname.split('/')) if (isDynamic(seg)) out.add(seg);
    } catch { /* ignore */ }
    const body = entry.request && entry.request.postData && entry.request.postData.text || '';
    // JSON values + form values + bare tokens
    for (const m of body.matchAll(/"([A-Za-z0-9._~%+/=:-]{8,})"/g)) if (isDynamic(m[1])) out.add(m[1]);
    for (const m of body.matchAll(/=([A-Za-z0-9._~%+/=:-]{8,})/g)) if (isDynamic(m[1])) out.add(m[1]);
    for (const h of (entry.request && entry.request.headers) || []) {
        if (/^(cookie|host|content-length)$/i.test(h.name || '')) continue;
        if (isDynamic(h.value)) out.add(h.value);
    }
    return [...out];
}

// All searchable text of a response (headers incl. Location/Set-Cookie + body).
function responseText(entry) {
    const r = entry.response || {};
    const head = (r.headers || []).map(h => `${h.name}: ${h.value}`).join('\n');
    const body = (r.content && r.content.text) || '';
    return head + '\n' + body;
}

function boundaryOf(text, value) {
    const i = text.indexOf(value);
    if (i < 0) return null;
    return { left: text.slice(Math.max(0, i - CTX), i), right: text.slice(i + value.length, i + value.length + CTX) };
}

function extractByBoundary(text, b) {
    if (!b || !text) return null;
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const l = esc(b.left.slice(-10)); const r = esc(b.right.slice(0, 10));
    if (!l && !r) return null;
    const m = text.match(new RegExp(l + '([A-Za-z0-9._~%+/=:-]+?)' + r));
    return m ? m[1] : null;
}

/**
 * STATIC PRE-PASS: build producer→consumer links from the recording.
 * @returns {{ links: Array, orphans: Array }}
 *   link = { value, varName, producer, consumer, boundary, locationHint }
 *   orphan = { value, consumer }  (no prior response produced it → synth/disable)
 */
function buildLinks(entries) {
    const links = [];
    const orphans = [];
    const seen = new Map(); // value -> varName (reuse one var per identical value)
    let n = 0;
    for (let i = 0; i < entries.length; i++) {
        for (const value of requestValues(entries[i])) {
            // find NEAREST prior response containing this value
            let producer = -1, boundary = null;
            for (let j = i - 1; j >= 0; j--) {
                const txt = responseText(entries[j]);
                const b = boundaryOf(txt, value);
                if (b) { producer = j; boundary = b; break; }
            }
            if (producer < 0) { orphans.push({ value, consumer: i }); continue; }
            let varName = seen.get(value);
            if (!varName) { varName = `c_${++n}`; seen.set(value, varName); }
            links.push({ value, varName, producer, consumer: i, boundary });
        }
    }
    return { links, orphans };
}

/**
 * LIVE REPLAY with correlation + verification.
 * @returns {Promise<{ applied, verified, failures, samples, reachedEnd, links, orphans }>}
 */
async function correlateAndReplay({ entries, targetBaseUrl = null, insecure = true, timeoutMs, onLog = () => {} }) {
    const { links, orphans } = buildLinks(entries);
    onLog(`pre-pass: ${links.length} producer→consumer link(s), ${orphans.length} orphan value(s) (client-gen/synth candidates)`);

    const linksByConsumer = new Map();
    const linksByProducer = new Map();
    const push = (map, key, val) => { if (!map.has(key)) map.set(key, []); map.get(key).push(val); };
    for (const lk of links) {
        push(linksByConsumer, lk.consumer, lk);
        push(linksByProducer, lk.producer, lk);
    }

    const cookieJar = new Map();
    const vars = {};
    const samples = [];
    const failures = [];
    const appliedSet = new Set();
    let reachedEnd = true;

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.request || !e.request.url) continue;

        // Apply correlations: rewrite a COPY of the entry, replacing recorded
        // literals with ${var} so fast-replay substitutes the LIVE value.
        const consumed = linksByConsumer.get(i) || [];
        let reqEntry = e;
        if (consumed.length) {
            const clone = JSON.parse(JSON.stringify({ request: e.request, response: { status: e.response && e.response.status } }));
            let urlS = clone.request.url;
            let bodyS = clone.request.postData && clone.request.postData.text;
            for (const lk of consumed) {
                if (vars[lk.varName] == null) continue;     // producer hasn't run/extracted yet
                const ref = '${' + lk.varName + '}';
                if (urlS && urlS.includes(lk.value)) urlS = urlS.split(lk.value).join(ref);
                if (bodyS && bodyS.includes(lk.value)) bodyS = bodyS.split(lk.value).join(ref);
                for (const h of clone.request.headers || []) if (h.value && h.value.includes(lk.value)) h.value = h.value.split(lk.value).join(ref);
                appliedSet.add(lk.varName);
            }
            clone.request.url = urlS;
            if (clone.request.postData) clone.request.postData.text = bodyS;
            reqEntry = clone;
        }

        let r;
        try {
            r = await replayOne({ entry: reqEntry, vars, cookieJar, targetBaseUrl, insecure, timeoutMs });
        } catch (err) {
            samples.push({ index: i, url: e.request.url, status: 0, error: err.message, success: false });
            continue;
        }

        // Verify against the recording.
        const recStatus = Number(e.response && e.response.status || 0);
        const ok = r.status > 0 && r.status < 400;
        const diverged = recStatus && recStatus < 400 && r.status >= 400;
        samples.push({ index: i, url: e.request.url, status: r.status, recStatus, success: ok });
        if (diverged) failures.push({ index: i, url: e.request.url, status: r.status, recStatus });

        // Harvest: extract LIVE values this response produces, by boundary.
        const produces = linksByProducer.get(i) || [];
        if (produces.length) {
            const liveText = (Object.entries(r.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')) + '\n' + (r.body || '');
            for (const lk of produces) {
                const live = extractByBoundary(liveText, lk.boundary);
                if (live != null) vars[lk.varName] = live;
            }
        }
    }

    const verified = [...appliedSet].length;
    return {
        links, orphans,
        applied: appliedSet.size,
        verified,
        failures,
        samples,
        reachedEnd: failures.length === 0,
    };
}

module.exports = { correlateAndReplay, buildLinks, _internal: { isDynamic, requestValues, boundaryOf, extractByBoundary } };
