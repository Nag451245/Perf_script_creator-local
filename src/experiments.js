'use strict';
/**
 * experiments.js — let a hypothesis go prove itself.
 *
 * Diagnosis over collected evidence can only reason about what already
 * happened. A senior does better: they design the one cheap observation that
 * separates two theories, run it, and come back with an answer in a minute
 * instead of another full test cycle. That is what this does.
 *
 * WHAT MAKES THIS SAFE TO POINT AT SOMEONE'S ENVIRONMENT:
 *   - GET only. Never a mutating verb, ever — an experiment must not be able
 *     to create, change or delete anything in the system under test.
 *   - No cookies sent, so a probe cannot consume or invalidate a live session.
 *   - Destructive-looking paths (logout, delete, revoke, reset…) are refused
 *     even as GETs, because plenty of apps still act on them.
 *   - Only hosts the RECORDING already contacted. The agent cannot be talked
 *     into probing somewhere new by a bad hypothesis.
 *   - Hard caps on count, redirects and time; disabled with one config flag.
 *
 * The results only ever add evidence FOR or AGAINST a hypothesis — they never
 * change a script. Knowledge proposes, experiments observe, gates dispose.
 */

const { httpGet } = require('./live-probe');

const MAX_EXPERIMENTS = 4;
const TIMEOUT_MS = 8000;
const DESTRUCTIVE_PATH_RE = /(logout|signout|sign-out|delete|remove|revoke|reset|cancel|deactivate|purge|terminate)/i;
const SESSION_COOKIE_RE = /(sess|auth|token|jwt|iam|idem|sid)/i;
const TOKEN_SHAPE_RE = /[A-Za-z0-9_\-]{24,}/g;

/**
 * Is this URL safe to observe? Deliberately strict: an experiment that needs
 * an exception is an experiment a human should run.
 */
function isSafeToProbe(url, knownHosts = []) {
    let u;
    try { u = new URL(url); } catch { return { ok: false, why: 'unparseable URL' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, why: 'not http(s)' };
    if (DESTRUCTIVE_PATH_RE.test(u.pathname)) return { ok: false, why: 'path looks state-changing' };
    if (knownHosts.length && !knownHosts.includes(u.hostname)) {
        return { ok: false, why: 'host was not in the recording' };
    }
    return { ok: true };
}

/**
 * Turn hypotheses into observations worth making. Only hypotheses whose truth
 * a GET can actually discriminate get an experiment; the rest are left to the
 * evidence (or to a human — we never try credentials, for instance, because a
 * wrong guess can lock the account).
 */
function planExperiments({ hypotheses = [], model = {}, entries = [], baseUrl = '' } = {}) {
    const knownHosts = [...new Set((entries || [])
        .map(e => { try { return new URL(e.request.url).hostname; } catch { return ''; } })
        .filter(Boolean))];
    const plan = [];

    for (const h of hypotheses) {
        if (plan.length >= MAX_EXPERIMENTS) break;

        // Does the session minter actually mint when called fresh?
        if (h.id === 'session_never_minted' || h.id === 'session_minter_disabled') {
            const minter = (model.sessionMinters || [])[0];
            if (!minter) continue;
            const url = absolute(minter.path, minter.host, baseUrl);
            const safe = isSafeToProbe(url, knownHosts);
            if (!safe.ok) continue;
            plan.push({
                hypothesisId: h.id,
                kind: 'mint-check',
                url,
                question: `Does ${minter.path} still issue a session cookie when called directly?`,
                expect: `Set-Cookie matching /${SESSION_COOKIE_RE.source}/`,
            });
            continue;
        }

        // Does the value we replay actually rotate between two fresh loads?
        if (h.id === 'single_use_value_replayed' || String(h.id).startsWith('kb:literal-with-producer')) {
            const producer = pickProducer(entries);
            if (!producer) continue;
            const safe = isSafeToProbe(producer.url, knownHosts);
            if (!safe.ok) continue;
            plan.push({
                hypothesisId: h.id,
                kind: 'volatility-check',
                url: producer.url,
                recordedValue: producer.value,
                question: `Is the value ${producer.value.slice(0, 12)}… regenerated on every load of ${producer.path}?`,
                expect: 'two fresh loads disagree, or the recorded value is gone',
            });
        }
    }
    return plan;
}

/** The best page to test volatility on: one whose body carries a token-shaped
 *  value that a later request sends back. */
function pickProducer(entries = []) {
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (String((e.request && e.request.method) || 'GET').toUpperCase() !== 'GET') continue;
        const body = String((e.response && e.response.content && e.response.content.text) || '');
        if (!body || body.length > 400000) continue;
        const candidates = body.match(TOKEN_SHAPE_RE) || [];
        for (const value of candidates.slice(0, 40)) {
            for (let j = i + 1; j < entries.length; j++) {
                const req = entries[j].request || {};
                const sent = `${req.url || ''} ${(req.postData && req.postData.text) || ''} ` +
                    `${((req.postData && req.postData.params) || []).map(p => p.value).join('&')}`;
                if (sent.includes(value)) {
                    let p = '';
                    try { p = new URL(e.request.url).pathname; } catch { p = ''; }
                    return { url: e.request.url, path: p, value };
                }
            }
        }
    }
    return null;
}

function absolute(pathname, host, baseUrl) {
    if (host) return `https://${host}${pathname || '/'}`;
    try { return new URL(pathname || '/', baseUrl).href; } catch { return ''; }
}

/** Run the planned observations. Never throws; an unreachable environment
 *  simply yields no new evidence. */
async function runExperiments(plan = [], { timeoutMs = TIMEOUT_MS } = {}) {
    const results = [];
    for (const exp of plan.slice(0, MAX_EXPERIMENTS)) {
        if (exp.kind === 'mint-check') {
            const res = await httpGet(exp.url, { timeoutMs });
            if (!res.ok) { results.push({ ...exp, ran: false, why: res.error }); continue; }
            const session = (res.setCookie || []).filter(c => SESSION_COOKIE_RE.test(c));
            // The endpoint minting on a bare GET means the script's failure is
            // in HOW it calls it. Minting nothing means the session depends on
            // something upstream — a different repair entirely.
            results.push({
                ...exp, ran: true, status: res.status,
                supports: session.length === 0,
                cookies: session,
                observation: session.length
                    ? `it DOES issue ${session.join(', ')} on a plain GET — so the session material is reachable; the script is not obtaining it`
                    : `it issued no session cookie on a plain GET (HTTP ${res.status}) — the session depends on earlier state`,
            });
            continue;
        }
        if (exp.kind === 'volatility-check') {
            const a = await httpGet(exp.url, { timeoutMs });
            const b = await httpGet(exp.url, { timeoutMs });
            if (!a.ok || !b.ok) { results.push({ ...exp, ran: false, why: (a.error || b.error) }); continue; }
            const recordedStillThere = String(a.body || '').includes(exp.recordedValue);
            const tokensA = new Set(String(a.body || '').match(TOKEN_SHAPE_RE) || []);
            const tokensB = new Set(String(b.body || '').match(TOKEN_SHAPE_RE) || []);
            const rotating = [...tokensA].some(t => !tokensB.has(t));
            results.push({
                ...exp, ran: true, status: a.status,
                supports: !recordedStillThere || rotating,
                observation: !recordedStillThere
                    ? 'the recorded value is no longer on the page — it has rotated'
                    : rotating
                        ? 'two fresh loads returned different token-shaped values — it is per-request'
                        : 'the same values came back on both loads — this value looks stable',
            });
        }
    }
    return results;
}

/** Fold observations back in as evidence, then let the ranker re-decide. */
function applyExperimentResults(hypotheses = [], results = []) {
    const byId = new Map();
    for (const r of results) {
        if (!r.ran) continue;
        if (!byId.has(r.hypothesisId)) byId.set(r.hypothesisId, []);
        byId.get(r.hypothesisId).push(r);
    }
    return hypotheses.map(h => {
        const mine = byId.get(h.id);
        if (!mine || !mine.length) return h;
        const forAdd = [], againstAdd = [];
        for (const r of mine) {
            const line = `live check — ${r.question} ${r.observation}`;
            (r.supports ? forAdd : againstAdd).push(line);
        }
        return {
            ...h,
            for: [...(h.for || []), ...forAdd],
            against: [...(h.against || []), ...againstAdd],
            testedLive: true,
        };
    });
}

module.exports = {
    planExperiments, runExperiments, applyExperimentResults,
    _internal: { isSafeToProbe, pickProducer, MAX_EXPERIMENTS },
};
