'use strict';
/**
 * live-probe.js — hypothesis-testing against the LIVE system, the way a senior
 * engineer curls an endpoint before blaming the script.
 *
 * Strictly side-effect safe: GET only, no cookies carried, bounded redirects
 * and timeouts. First use case: the FRESHNESS probe — fetch the flow's landing
 * page live and compare the values the page embeds (inline-JS challenge pairs,
 * hidden inputs) against the recording. A value that differs is deployment-
 * rotated: replaying the recorded literal would fail SILENTLY (200, no session),
 * so the probe says so BEFORE a single JMeter run is spent — and confirms that
 * the correlation the agent wired is genuinely required rather than cosmetic.
 *
 * Why GET-only is not a limitation here: everything this probe needs to know
 * lives in a public landing page. Anything requiring a session belongs in the
 * run itself, where the script already carries one.
 *
 * Verdicts per probed value:
 *   rotated   — live value differs from the recording  => correlation REQUIRED
 *   stable    — live value equals the recording        => literal would survive
 *   absent    — the regex no longer matches the page   => page structure changed
 *   unknown   — probe could not run (offline/blocked)  => never blocks a run
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * GET a URL with no cookies, bounded redirects/time. Resolves
 * {ok, status, body, url} — never throws; failures come back as {ok:false}.
 */
function httpGet(rawUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, redirectsLeft = MAX_REDIRECTS } = {}) {
    return new Promise((resolve) => {
        let target;
        try { target = new URL(rawUrl); } catch { return resolve({ ok: false, error: 'bad url', url: rawUrl }); }
        if (!/^https?:$/.test(target.protocol)) return resolve({ ok: false, error: 'unsupported protocol', url: rawUrl });
        const lib = target.protocol === 'https:' ? https : http;
        const req = lib.get(target, {
            timeout: timeoutMs,
            // A probe must never authenticate or mutate: no cookies, plain GET.
            headers: { 'User-Agent': 'perfscript-live-probe/1.0', 'Accept': '*/*' },
            rejectUnauthorized: false, // staging boxes routinely carry self-signed certs
        }, (res) => {
            const status = res.statusCode || 0;
            const location = res.headers && res.headers.location;
            if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
                res.resume();
                let next;
                try { next = new URL(location, target).href; } catch { return resolve({ ok: false, error: 'bad redirect', url: rawUrl }); }
                return resolve(httpGet(next, { timeoutMs, redirectsLeft: redirectsLeft - 1 }));
            }
            let body = '';
            let bytes = 0;
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                bytes += Buffer.byteLength(chunk);
                if (bytes <= MAX_BODY_BYTES) body += chunk;
            });
            res.on('end', () => resolve({ ok: true, status, body, url: target.href }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `timeout after ${timeoutMs}ms`, url: rawUrl }); });
        req.on('error', (e) => resolve({ ok: false, error: e.message, url: rawUrl }));
    });
}

/**
 * Compare one recorded token against the live page.
 * @param {string} liveBody   the page as it is served NOW
 * @param {Object} token      {name, value, regex} from js-challenge-token
 */
function classifyToken(liveBody, token) {
    let m = null;
    try { m = new RegExp(token.regex).exec(String(liveBody || '')); } catch { m = null; }
    if (!m) return { name: token.name, verdict: 'absent', recordedValue: token.value, liveValue: null };
    // group 2 is the value; group 1 is the (possibly rotating) name
    const liveName = m[1];
    const liveValue = m[2];
    const verdict = liveValue === token.value ? 'stable' : 'rotated';
    return { name: token.name, liveName, verdict, recordedValue: token.value, liveValue };
}

/**
 * FRESHNESS probe. Fetch `url` live and classify each recorded token.
 * @returns {Promise<{ok, reachable, url, status, tokens, summary, notes}>}
 */
async function probeFreshness({ url = '', tokens = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!url || !tokens.length) return { ok: false, reachable: null, url, tokens: [], summary: '', notes: 'nothing to probe' };
    const res = await httpGet(url, { timeoutMs });
    if (!res.ok) {
        return {
            ok: false, reachable: false, url, error: res.error,
            tokens: tokens.map(t => ({ name: t.name, verdict: 'unknown', recordedValue: t.value, liveValue: null })),
            summary: `live probe could not reach ${url} (${res.error}) — proceeding without freshness evidence`,
            notes: 'probe failure never blocks a run; it only removes evidence',
        };
    }
    const classified = tokens.map(t => classifyToken(res.body, t));
    const rotated = classified.filter(c => c.verdict === 'rotated');
    const absent = classified.filter(c => c.verdict === 'absent');
    const stable = classified.filter(c => c.verdict === 'stable');
    const parts = [];
    if (rotated.length) parts.push(`${rotated.length} rotated since the recording (correlation is REQUIRED: ${rotated.map(r => r.name).join(', ')})`);
    if (stable.length) parts.push(`${stable.length} unchanged`);
    if (absent.length) parts.push(`${absent.length} no longer present in the page (${absent.map(a => a.name).join(', ')})`);
    return {
        ok: true, reachable: true, url, status: res.status,
        tokens: classified,
        summary: parts.join('; '),
        notes: absent.length
            ? 'a value the recording embedded is gone from the live page — the page changed shape; the extractor may need review'
            : '',
    };
}

module.exports = { probeFreshness, httpGet, _internal: { classifyToken } };
