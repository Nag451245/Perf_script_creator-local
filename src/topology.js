'use strict';
/**
 * topology.js — the dev-savvy half of a senior engineer's read of a recording.
 *
 * A correlation expert asks "does the script replay?". An engineer with dev
 * knowledge also asks "what is this thing I'm about to hammer?" — and the
 * recording already answered, in its response headers and cookies:
 *
 *   Set-Cookie: TS01dc4fc6=...        an F5 BIG-IP persistence cookie => there
 *                                     is a load balancer with SESSION AFFINITY
 *                                     in front. Under load, a shared cookie
 *                                     store pins every thread to ONE node and
 *                                     you load-test a single server.
 *   Server: volt-adc                  traffic terminates on an ADC, not the app
 *   Via: 1.1 google / X-Cache: HIT    a CDN/proxy tier is answering some of it
 *   Cache-Control: max-age=28800      responses your test "measures" may never
 *                                     reach the origin at all
 *
 * None of that changes whether the script replays, so the correlation engine
 * is right to ignore it — and a performance engineer would ask about every one
 * of them before trusting a number. This module reads those signals off the
 * recording (deterministic, no vendor list beyond well-known header/cookie
 * shapes) and states the load-test implication of each.
 *
 * Second job: COMPUTED VALUE SOURCE. When a value can't be correlated because
 * the browser COMPUTED it (a signature, a fingerprint), point at the code that
 * computes it — the JS file and the line — so the human ask is "port this
 * function", not "we couldn't find it".
 */

// Affinity cookies: name shape -> the balancer that sets it.
const AFFINITY_COOKIES = [
    { re: /^TS[0-9a-f]{6,}$/i, tech: 'F5 BIG-IP ASM/LTM' },
    { re: /^BIGipServer/i, tech: 'F5 BIG-IP LTM' },
    { re: /^AWSALB(CORS)?$/i, tech: 'AWS Application Load Balancer' },
    { re: /^(SERVERID|X-Mapping-[a-z0-9]+|route)$/i, tech: 'HAProxy/nginx affinity' },
    { re: /^(ARRAffinity|ARRAffinitySameSite)$/i, tech: 'Azure App Service ARR' },
    { re: /^(NSC_[a-z0-9]+)$/i, tech: 'Citrix NetScaler' },
];
const ADC_SERVER_RE = /(volt-adc|big-?ip|f5|netscaler|haproxy|awselb|envoy|cloudfront|akamai)/i;
const CDN_HEADERS = [
    { name: 'via', tech: 'forward/CDN proxy' },
    { name: 'x-cache', tech: 'CDN cache' },
    { name: 'cf-ray', tech: 'Cloudflare' },
    { name: 'x-amz-cf-id', tech: 'AWS CloudFront' },
    { name: 'x-served-by', tech: 'Fastly' },
    { name: 'x-varnish', tech: 'Varnish' },
];
const APM_COOKIE_RE = /^(dtCookie|dtLatC|rxVisitor|rxvt|_dd_s|nr_|JSESSIONID_APM)/i;
const API_MIME_RE = /(json|xml)/i;

function headersOf(entry) { return (entry && entry.response && entry.response.headers) || []; }
function headerVal(entry, name) {
    for (const h of headersOf(entry)) if (String(h.name || '').toLowerCase() === name) return String(h.value || '');
    return '';
}
function hostOf(entry) {
    try { return new URL(entry.request.url).hostname; } catch { return ''; }
}

/**
 * Read the infrastructure a recording passed through.
 * @returns {{findings: Array<{signal,tech,evidence,count,implication,severity}>}}
 */
function analyzeTopology(entries = []) {
    const affinity = new Map();   // cookieName -> {tech, count, hosts:Set}
    const servers = new Map();    // server header -> count
    const cdn = new Map();        // tech -> {count, sample}
    const apm = new Map();        // cookie -> count
    let cachedApiCount = 0;
    const cachedApiSamples = [];

    for (const e of entries || []) {
        const host = hostOf(e);
        for (const h of headersOf(e)) {
            const n = String(h.name || '').toLowerCase();
            const v = String(h.value || '');
            if (n === 'set-cookie') {
                const cookieName = v.split('=')[0].trim();
                const hit = AFFINITY_COOKIES.find(a => a.re.test(cookieName));
                if (hit) {
                    const cur = affinity.get(cookieName) || { tech: hit.tech, count: 0, hosts: new Set() };
                    cur.count++; if (host) cur.hosts.add(host);
                    affinity.set(cookieName, cur);
                }
                if (APM_COOKIE_RE.test(cookieName)) apm.set(cookieName, (apm.get(cookieName) || 0) + 1);
            }
            if (n === 'server' && v) servers.set(v, (servers.get(v) || 0) + 1);
            const cdnHit = CDN_HEADERS.find(c => c.name === n);
            if (cdnHit) {
                const cur = cdn.get(cdnHit.tech) || { count: 0, sample: v.slice(0, 40) };
                cur.count++; cdn.set(cdnHit.tech, cur);
            }
        }
        // A cacheable API response: the test may measure the cache, not the app.
        const mime = String((e.response && e.response.content && e.response.content.mimeType) || '');
        if (API_MIME_RE.test(mime)) {
            const cc = headerVal(e, 'cache-control');
            const m = cc.match(/max-age=(\d+)/i);
            if (m && Number(m[1]) > 0 && !/no-store|no-cache/i.test(cc)) {
                cachedApiCount++;
                if (cachedApiSamples.length < 3) {
                    try { cachedApiSamples.push(`${new URL(e.request.url).pathname} (max-age=${m[1]})`); } catch { /* skip */ }
                }
            }
        }
    }

    const findings = [];
    // Group affinity by TECHNOLOGY, not cookie name: one balancer that sets
    // four rotating TS* cookies is ONE fact about the topology, not four.
    const affinityByTech = new Map();
    for (const [cookie, info] of affinity) {
        const cur = affinityByTech.get(info.tech) || { count: 0, cookies: [], hosts: new Set() };
        cur.count += info.count;
        cur.cookies.push(cookie);
        for (const h of info.hosts) cur.hosts.add(h);
        affinityByTech.set(info.tech, cur);
    }
    for (const [tech, info] of affinityByTech) {
        findings.push({
            signal: 'session_affinity',
            tech,
            evidence: `${info.cookies.length} persistence cookie(s) (${info.cookies.slice(0, 3).join(', ')}${info.cookies.length > 3 ? ', …' : ''}) on ${info.count} response(s)${info.hosts.size ? ` across ${[...info.hosts].join(', ')}` : ''}`,
            count: info.count,
            severity: 'high',
            implication: `A load balancer is pinning sessions (${tech}). Each virtual user needs its OWN cookie store — JMeter's Cookie Manager must be per-thread (clear per iteration only if you intend to re-balance). Sharing one store pins every thread to a single node and quietly load-tests one server; with a small pool, also expect uneven node distribution in the results.`,
        });
    }
    const topServer = [...servers.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topServer && ADC_SERVER_RE.test(topServer[0])) {
        findings.push({
            signal: 'edge_tier',
            tech: topServer[0],
            evidence: `Server: ${topServer[0]} on ${topServer[1]} response(s)`,
            count: topServer[1],
            severity: 'info',
            implication: `Traffic terminates on an application delivery controller/edge (${topServer[0]}) rather than the app server. Response times include that hop, and the edge may rate-limit or shape a synthetic load that a browser never triggers — confirm test-traffic allowances before blaming the app for latency.`,
        });
    }
    for (const [tech, info] of cdn) {
        findings.push({
            signal: 'cdn_proxy',
            tech,
            evidence: `${tech} header seen ${info.count}× (e.g. "${info.sample}")`,
            count: info.count,
            severity: 'info',
            implication: `A caching tier (${tech}) serves part of this flow. Requests it answers never reach the origin, so including them inflates throughput and flatters response times — decide deliberately whether the test should measure the CDN or bypass it.`,
        });
    }
    if (cachedApiCount) {
        findings.push({
            signal: 'cacheable_api',
            tech: 'HTTP cache-control',
            evidence: `${cachedApiCount} API response(s) carry a positive max-age, e.g. ${cachedApiSamples.join('; ')}`,
            count: cachedApiCount,
            severity: 'medium',
            implication: `These API responses are cacheable. A repeated-iteration test may be measuring cache hits rather than application work; if the intent is to load the backend, vary the data or confirm whether the client actually revalidates.`,
        });
    }
    for (const [cookie, count] of apm) {
        findings.push({
            signal: 'apm_agent',
            tech: cookie,
            evidence: `${cookie} on ${count} response(s)`,
            count,
            severity: 'info',
            implication: `An APM/RUM agent (${cookie}) instruments this app. Its server-side traces are the fastest way to attribute a bottleneck once load is running — and its beacon endpoints are client-side noise that does not belong in the script.`,
        });
    }
    return { findings: findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.count - a.count) };
}

function severityRank(s) { return s === 'high' ? 3 : s === 'medium' ? 2 : 1; }

/**
 * COMPUTED VALUE SOURCE — find the JavaScript that produces a value the script
 * cannot correlate, so the ask becomes "port this function" instead of "no idea".
 * @param {Array} entries recording entries
 * @param {string} paramName the parameter whose value the browser computed
 */
function findComputedValueSource(entries = [], paramName = '') {
    if (!paramName) return null;
    const needle = String(paramName);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Look for the name being ASSIGNED or COMPUTED, not merely mentioned.
    const assignRe = new RegExp(`(?:${escaped})\\s*[:=]\\s*([^;,\\n]{0,80})`, 'i');
    for (const e of entries || []) {
        const mime = String((e.response && e.response.content && e.response.content.mimeType) || '');
        const url = (e.request && e.request.url) || '';
        const isJs = /javascript|ecmascript/i.test(mime) || /\.js(\?|$)/i.test(url);
        const body = String((e.response && e.response.content && e.response.content.text) || '');
        if (!isJs || !body || !body.includes(needle)) continue;
        const m = assignRe.exec(body);
        if (!m) continue;
        const at = m.index;
        const line = body.slice(0, at).split('\n').length;
        const snippet = body.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, ' ').trim();
        let file = url;
        try { file = new URL(url).pathname; } catch { /* keep raw */ }
        return {
            param: needle,
            file,
            line,
            snippet,
            ask: `"${needle}" is computed by the page's own JavaScript (${file}:${line}). No response contains it, so no extractor can capture it — the value must be reproduced. Port the computation into a JSR223 pre-processor, or ask the dev team whether a fixed/test-mode value is accepted.`,
        };
    }
    return null;
}

module.exports = { analyzeTopology, findComputedValueSource, _internal: { severityRank } };
