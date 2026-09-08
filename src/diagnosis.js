'use strict';
/**
 * diagnosis.js — the reasoning loop: model, hypotheses, experiments, verdict.
 *
 * The gates tell you a run is wrong. They do not tell you WHY, and that is the
 * gap between a rule engine and an engineer. A senior handed "login returns a
 * 200 with the login page" does not consult a catalogue — they build a picture
 * of the app, list the handful of things that could produce that symptom,
 * then run the cheapest observation that kills most of the list.
 *
 * This module does that, deterministically:
 *
 *   1. MODEL     what is this app? which hosts, which cookies carry the
 *                session, which step mints them, what stack is it.
 *   2. HYPOTHESES given the symptom and the model, what could explain it —
 *                structural candidates plus anything the knowledge base
 *                recognises. Each carries a prior.
 *   3. EXPERIMENTS every hypothesis names checks that discriminate it from its
 *                look-alikes. Here they run against evidence already in hand,
 *                so a full differential costs nothing and no extra traffic.
 *   4. VERDICT   rank by evidence FOR minus evidence AGAINST, and say plainly
 *                which one the evidence actually supports.
 *
 * Deliberately NOT a fixer: diagnosis explains, gates decide, remedies are
 * applied by the existing machinery under its existing guards. A reasoner that
 * could also act on its own conclusions would be a reasoner nobody can trust.
 */

const SESSION_COOKIE_RE = /(sess|auth|token|jwt|iam|idem|csrf|sid)/i;
const AUTH_ERROR_RE = /(invalid (?:user|password|credential)|authentication failed|bad credentials|login failed|account (?:locked|disabled)|mfa|two[- ]factor)/i;

function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
}
function apexOf(host) {
    return String(host || '').split('.').slice(-2).join('.');
}
function bodyOf(entry) {
    return String((entry && entry.response && entry.response.content && entry.response.content.text) || '');
}
function setCookiesOf(headers) {
    return (headers || [])
        .filter(h => /^set-cookie$/i.test(String(h.name || '')))
        .map(h => String(h.value || '').split('=')[0].trim())
        .filter(Boolean);
}

/**
 * STEP 1 — the working model of the application. Not a report: the thing every
 * later step reasons over.
 */
function buildAppModel({ entries = [], stack = [] } = {}) {
    const hosts = new Map();
    const sessionMinters = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const host = hostOf((e.request && e.request.url) || '');
        if (host) hosts.set(host, (hosts.get(host) || 0) + 1);
        const cookies = setCookiesOf(e.response && e.response.headers).filter(c => SESSION_COOKIE_RE.test(c));
        if (cookies.length) {
            let p = '';
            try { p = new URL(e.request.url).pathname; } catch { p = ''; }
            sessionMinters.push({ entryIndex: i, host, path: p, cookies });
        }
    }
    const ranked = [...hosts.entries()].sort((a, b) => b[1] - a[1]);
    const primaryHost = ranked.length ? ranked[0][0] : '';
    const sessionCookieNames = [...new Set(sessionMinters.flatMap(m => m.cookies))];
    return {
        hosts: ranked.map(([h, n]) => ({ host: h, requests: n })),
        primaryHost,
        primaryApex: apexOf(primaryHost),
        multiHost: new Set(ranked.map(([h]) => apexOf(h))).size > 1,
        sessionMinters,
        sessionCookieNames,
        stack: (stack || []).map(String),
    };
}

/**
 * STEP 2+3 — structural hypotheses for a session/auth symptom, each with the
 * checks that support or refute it, run against evidence already collected.
 */
function sessionHypotheses({ model, evidence = [], disabledLabels = new Set(), failingLabels = [] }) {
    const out = [];
    const rows = (evidence || []).filter(r => r && !r.isTransaction);
    const liveSessionCookies = new Set();
    for (const r of rows) {
        for (const c of setCookiesOf(r.observedResponseHeaders)) {
            if (SESSION_COOKIE_RE.test(c)) liveSessionCookies.add(c);
        }
    }
    const recordedCookies = new Set(model.sessionCookieNames);

    // H1 — the session was never established at all. Requires actual
    // observations: with no evidence rows we have not looked, and "we did not
    // see it" is not the same claim as "it did not happen".
    if (recordedCookies.size) {
        const missing = [...recordedCookies].filter(c => !liveSessionCookies.has(c));
        const observed = rows.length > 0;
        out.push({
            id: 'session_never_minted',
            claim: 'No step in the live run produced the session cookies the recording shows, so nothing downstream is authenticated.',
            prior: 0.5,
            for: observed && missing.length === recordedCookies.size
                ? [`live run set NONE of the recorded session cookies (${[...recordedCookies].slice(0, 4).join(', ')})`]
                : [],
            against: observed && missing.length === 0 ? ['every recorded session cookie was also set live'] : [],
            remedy: 'Find the step that mints the session in the recording and make sure it runs, sends what it needs, and succeeds before anything else.',
        });
    }

    // H2 — a step that MINTS the session is disabled in the shipped script.
    // Match on a DISTINCTIVE path, never a bare "/" — a root path is a
    // substring of every label and would "support" this hypothesis on every
    // app, which is how a reasoner ends up right by accident and wrong later.
    const disabledMinters = model.sessionMinters.filter(m => {
        const p = String(m.path || '');
        if (p.length < 4 || p === '/') return false;
        for (const label of disabledLabels) if (String(label).includes(p)) return true;
        return false;
    });
    out.push({
        id: 'session_minter_disabled',
        claim: 'A request whose recorded response sets session cookies is disabled in the shipped script, so the session can never be created.',
        prior: 0.35,
        for: disabledMinters.map(m => `${m.path} sets ${m.cookies.slice(0, 3).join(', ')} but is disabled`),
        against: disabledMinters.length ? [] : ['no session-minting step is disabled'],
        remedy: 'Re-enable that step (and check run.disableCalls — it is global, so another flow\'s tuning can disable it here).',
    });

    // H3 — the session lives on a different host than the failing request.
    const failingHosts = new Set();
    for (const r of rows) {
        if (!failingLabels.includes(r.label)) continue;
        const h = hostOf(r.finalUrl || r.recordedUrl || '');
        if (h) failingHosts.add(h);
    }
    const minterApexes = new Set(model.sessionMinters.map(m => apexOf(m.host)).filter(Boolean));
    const crossDomain = [...failingHosts].filter(h => minterApexes.size && !minterApexes.has(apexOf(h)));
    out.push({
        id: 'cross_domain_session',
        claim: 'The session cookie is issued on one domain and the failing request goes to another, so the cookie is never sent with it.',
        prior: 0.3,
        for: crossDomain.length
            ? [`session minted on ${[...minterApexes].join(', ')} but failing request targets ${crossDomain.slice(0, 2).join(', ')}`]
            : [],
        against: !crossDomain.length && failingHosts.size ? ['failing requests are on the same domain that mints the session'] : [],
        remedy: 'Reproduce the cross-domain handoff explicitly (the redirect or auto-POST that carries the assertion), rather than expecting the cookie to travel by itself.',
    });

    // H4 — the app answered with an explicit authentication error.
    const authErrors = [];
    for (const r of rows) {
        const body = String(r.observedBody || '');
        const m = body.match(AUTH_ERROR_RE);
        if (m) authErrors.push(`${r.label}: "${m[0]}"`);
        if (authErrors.length >= 2) break;
    }
    out.push({
        id: 'credentials_rejected',
        claim: 'The application explicitly rejected the credentials or demanded a second factor — this is a data/account problem, not a correlation problem.',
        prior: 0.2,
        for: authErrors,
        against: authErrors.length ? [] : ['no response states an authentication error'],
        remedy: 'Verify the account works in a browser against this environment, and use a test-friendly account without MFA.',
    });

    // H5 — a single-use value was replayed.
    const replayed = [];
    for (const r of rows) {
        if (!failingLabels.includes(r.label)) continue;
        const rec = String(r.recordedBody || '');
        const obs = String(r.observedBody || '');
        if (rec && obs && r.observedStatus === r.recordedStatus && obs.length && rec.length &&
            Math.abs(obs.length - rec.length) / Math.max(rec.length, 1) > 0.5) {
            replayed.push(`${r.label}: response shape differs sharply from the recording`);
        }
        if (replayed.length >= 2) break;
    }
    out.push({
        id: 'single_use_value_replayed',
        claim: 'A one-time value (grant, nonce, challenge) was replayed after it had already been consumed, so the server refused the exchange.',
        prior: 0.25,
        for: replayed,
        against: [],
        remedy: 'Extract that value fresh from the step immediately before the consumer, and make sure no earlier step consumed it first.',
    });

    return out;
}

/** Knowledge-base findings become hypotheses too — they arrive pre-evidenced. */
function knowledgeHypotheses(findings = []) {
    return (findings || []).map(f => ({
        id: `kb:${f.id}`,
        claim: f.title,
        prior: typeof f.confidence === 'number' ? f.confidence : 0.7,
        for: f.evidence ? [f.evidence] : [],
        against: [],
        remedy: f.remedy || '',
        discriminate: f.discriminate || '',
    }));
}

/**
 * STEP 4 — score and rank. Evidence FOR raises, evidence AGAINST kills. A
 * hypothesis with no supporting evidence never outranks one that has some,
 * however high its prior — that is the difference between reasoning from the
 * evidence and reasoning from a favourite theory.
 */
function rankHypotheses(hypotheses = []) {
    return hypotheses
        .map(h => {
            const forN = (h.for || []).length;
            const againstN = (h.against || []).length;
            const score = forN === 0 && againstN > 0 ? 0
                : (h.prior || 0.5) + forN * 0.45 - againstN * 0.35;
            return { ...h, score: Number(score.toFixed(3)), supported: forN > 0 };
        })
        // Supported ALWAYS outranks unsupported, whatever the priors say. A
        // confident theory with nothing behind it is exactly the failure mode
        // this loop exists to prevent; score only breaks ties within a tier.
        .sort((a, b) => (Number(b.supported) - Number(a.supported)) || (b.score - a.score));
}

/**
 * Full differential for a not-green run.
 * @returns {{model, hypotheses, top, summary}}
 */
function diagnose({ entries = [], evidence = [], stack = [], disabledLabels = new Set(),
    failingLabels = [], knowledgeFindings = [] } = {}) {
    const model = buildAppModel({ entries, stack });
    const hypotheses = rankHypotheses([
        ...sessionHypotheses({ model, evidence, disabledLabels, failingLabels }),
        ...knowledgeHypotheses(knowledgeFindings),
    ]);
    const supported = hypotheses.filter(h => h.supported);
    const top = supported[0] || null;
    const summary = top
        ? `${top.claim} Evidence: ${top.for.join('; ')}.`
        : 'No hypothesis is supported by the evidence collected — the symptom is not one this reasoner recognises yet.';
    return { model, hypotheses, top, summary };
}

module.exports = {
    diagnose, buildAppModel, rankHypotheses,
    _internal: { sessionHypotheses, knowledgeHypotheses, setCookiesOf, apexOf },
};
