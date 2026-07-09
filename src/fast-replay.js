'use strict';
/**
 * fast-replay.js — Node-only HTTP replay engine for the Phase 2/3 inner loop.
 *
 * Why this exists (ARCHITECTURE.md spells it out): JMeter is a Java process
 * with a ~3-5s JVM start per iteration. For an *agent* loop that wants to
 * try-then-verify several extractor hypotheses, that overhead dominates.
 * This module replays HAR entries with Node's built-in http/https, applies
 * the local app's parameterizations + ghost substitutions, asserts per-
 * sampler against the recording (status, body shape), and returns a diff
 * report — typically in tens of milliseconds, not tens of seconds.
 *
 * JMeter is still authoritative for Phase 5 (`--run`) because that's what
 * the user will actually load-test with; fast-replay is for verifying
 * "will my JMX work" before paying for the JMeter run.
 *
 * Deliberately small: cookie jar per session, no redirect chasing surprises
 * (we replay the recorded chain literally), no TLS verification override by
 * default (set `runCfg.fastReplay.insecure: true` for self-signed staging).
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { safeJsonShape } = require('./verifier')._internal;
const semanticResponse = require('./semantic-response');

const DEFAULT_TIMEOUT_MS = 30000;

function cloneCookies(cookieJar) { return new Map(cookieJar); }

/**
 * RFC-ish "domain match": a cookie set for `bank.com` should be sent to
 * `bank.com` and `api.bank.com`, but NOT to `evilbank.com`. The naive
 * `host.endsWith(domain)` check is famously the wrong call here — that's
 * what we used to do; this is the fix.
 */
function cookieDomainMatches(host, domain) {
    if (!host || !domain) return false;
    const d = domain.replace(/^\./, '').toLowerCase();
    const h = host.toLowerCase();
    if (h === d) return true;
    // Subdomain match must land on a dot boundary.
    return h.length > d.length && h.endsWith(`.${d}`);
}

function joinCookies(cookieJar, host) {
    const items = [];
    for (const [k, v] of cookieJar.entries()) {
        const [domain, name] = k.split('|');
        if (cookieDomainMatches(host, domain)) items.push(`${name}=${v}`);
    }
    return items.join('; ');
}
function rememberSetCookie(cookieJar, host, raw) {
    if (!raw) return;
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const line of arr) {
        const [pair] = String(line).split(';');
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.substring(0, eq).trim();
        const value = pair.substring(eq + 1).trim();
        if (!name) continue;
        cookieJar.set(`${host}|${name}`, value);
    }
}

function pickClient(u) { return u.protocol === 'https:' ? https : http; }

function substituteVars(text, vars) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => (n in vars ? String(vars[n]) : `\${${n}}`));
}

/**
 * Replay one entry. Returns { status, headers, body, durationMs }.
 */
function replayOne({ entry, vars, cookieJar, targetBaseUrl, insecure, timeoutMs }) {
    return new Promise((resolve, reject) => {
        // Substitute ${vars} into the URL FIRST so parameterized recordings
        // (e.g. `/users/${userId}`) replay correctly. Headers/body get the
        // same treatment below.
        const rawUrl = substituteVars(entry.request.url, vars);
        const recUrl = new URL(rawUrl);
        let u = recUrl;
        if (targetBaseUrl) {
            // Always honor the override base. The recording's host is treated
            // as the primary; the override is the test environment for it.
            // Third-party hosts in a recording (CDNs, analytics, payment
            // iframes) are NOT rewritten — that's `host-rewrite.js`'s job,
            // which the JMX-emission pipeline owns. Here, fast-replay's caller
            // only ever passes one base, so we apply it across the board for
            // the same reason JMeter's "domain override" plugin does: the
            // user picked this target on purpose.
            const t = new URL(targetBaseUrl);
            u = new URL(recUrl.pathname + recUrl.search, `${t.protocol}//${t.host}`);
        }
        const headers = {};
        for (const h of entry.request.headers || []) {
            const n = String(h.name || '');
            if (/^(host|content-length|connection)$/i.test(n)) continue;
            headers[n] = substituteVars(String(h.value || ''), vars);
        }
        const cookieHeader = joinCookies(cookieJar, u.hostname);
        if (cookieHeader) headers['Cookie'] = cookieHeader;

        let body;
        const pd = entry.request.postData;
        if (pd && typeof pd.text === 'string') body = substituteVars(pd.text, vars);

        const start = Date.now();
        const method = (entry.request.method || 'GET').toUpperCase();
        const observedRequest = { method, url: u.toString(), headers: { ...headers }, body: body || '' };
        const req = pickClient(u).request({
            method,
            protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search, headers,
            rejectUnauthorized: !insecure,
            timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                rememberSetCookie(cookieJar, u.hostname, res.headers['set-cookie']);
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: buf.toString('utf8'),
                    durationMs: Date.now() - start,
                    request: observedRequest,
                });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

/**
 * Run all entries in order against `targetBaseUrl`, applying `vars`
 * substitution, and diff each response to the recording. Returns a compact
 * per-sampler verdict the agent loop can act on.
 *
 * @returns {Promise<{
 *   ok:boolean, samples: Array, drift:Array, errors:Array, durationMs:number
 * }>}
 */
async function replayAll({ entries, vars = {}, targetBaseUrl = null, insecure = false, timeoutMs, onLog = () => {} }) {
    const cookieJar = new Map();
    const samples = [];
    const drift = [];
    const errors = [];
    const start = Date.now();

    for (let i = 0; i < (entries || []).length; i++) {
        const e = entries[i];
        if (!e || !e.request || !e.request.url) continue;
        try {
            const r = await replayOne({ entry: e, vars, cookieJar, targetBaseUrl, insecure, timeoutMs });
            const recStatus = Number(e.response?.status || 0);
            const recBody = (e.response?.content?.text) || '';
            const recShape = safeJsonShape(recBody);
            const obsShape = safeJsonShape(r.body);
            const issues = [];
            if (recStatus && r.status && recStatus !== r.status) issues.push({ kind: 'statusDiff', recorded: recStatus, observed: r.status });
            if (recBody && r.body) {
                const pct = Math.abs(r.body.length - recBody.length) / Math.max(1, recBody.length) * 100;
                if (pct > 30) issues.push({ kind: 'lengthDriftPct', pct: Math.round(pct), recorded: recBody.length, observed: r.body.length });
            }
            if (recShape && obsShape && recShape !== obsShape) issues.push({ kind: 'shapeDiff', recorded: recShape, observed: obsShape });
            const semantic = semanticResponse.compareRecordedLiveResponse({
                recorded: {
                    status: recStatus,
                    body: recBody,
                    contentType: contentTypeFromHar(e.response && e.response.headers),
                },
                observed: {
                    status: r.status,
                    body: r.body,
                    headers: r.headers || {},
                },
                sampler: `${e.request.method} ${e.request.url}`,
                index: i,
            });
            for (const issue of semantic.issues) issues.push({ ...issue, kind: issue.kind || 'semanticDiff' });
            samples.push({ index: i, url: e.request.url, status: r.status, durationMs: r.durationMs, success: r.status > 0 && r.status < 400 && issues.length === 0 });
            if (issues.length) drift.push({ index: i, sampler: `${e.request.method} ${e.request.url}`, issues });
        } catch (err) {
            errors.push({ index: i, url: e.request.url, message: err.message });
            samples.push({ index: i, url: e.request.url, status: 0, durationMs: 0, success: false });
            onLog(`fast-replay #${i} error: ${err.message}`);
        }
    }
    const ok = errors.length === 0 && drift.length === 0;
    return { ok, samples, drift, errors, durationMs: Date.now() - start };
}

function contentTypeFromHar(headers = []) {
    const h = (headers || []).find(item => /^content-type$/i.test(String(item.name || '')));
    return h ? String(h.value || '') : '';
}

module.exports = { replayAll, replayOne, _internal: { substituteVars, joinCookies, rememberSetCookie, cookieDomainMatches, contentTypeFromHar } };
