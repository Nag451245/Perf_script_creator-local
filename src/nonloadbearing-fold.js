'use strict';
/**
 * nonloadbearing-fold.js — the app-agnostic answer to "a recorded plumbing hop
 * fails on replay but the flow is actually fine."
 *
 * The failure class (browser SPA / OAuth-OIDC / SAML, but the rule needs to
 * know NONE of that): a recorded request re-fires a SINGLE-USE token
 * (`/authorize/resume` state, `/oauth/token` code, an interceptor grant). On
 * replay JMeter's Cookie Manager + Follow-Redirects have ALREADY established the
 * session by following the parent's live 302 chain, so the standalone hop
 * replays a burned token and 401/403s. Static priors protect it — resume sets an
 * `auth0` cookie so it "looks like" a session producer; `/oauth/token` "looks
 * like" the credential grant. Those priors are correct for M2M / PKCE / banking
 * and WRONG here, and no amount of static reasoning can tell the two apart.
 *
 * The RUN can. The discriminator is purely empirical and universal:
 *
 *   A sampler that FAILED (4xx/5xx) while every downstream request still
 *   PASSED was not load-bearing — nothing depended on it. Fold it.
 *
 * In a true M2M flow a failed `/oauth/token` starves every downstream call and
 * they 401 too, so the signal does NOT fire and the token exchange is kept.
 * Here downstream is green (it rode the cookies), so the signal fires and we
 * fold — exactly what a human does by hand: disable the two red hops, re-run,
 * clean. The caller confirms the fold with a counterfactual replay; this module
 * only decides WHICH failures are safe to try folding.
 *
 * Safety rails baked in:
 *  - a failing BUSINESS request (mutating verb on a business path: checkout,
 *    transfer, /save, /submit, …) is NEVER a fold candidate — that is a real
 *    defect to surface, not hide.
 *  - a guard/operator-PROTECTED sampler is never folded.
 *  - we require the flow to have CONTINUED past the failure (a later success),
 *    so we never "fold" a run that simply died at the end.
 */

const MUTATING_METHOD_RE = /^(POST|PUT|PATCH|DELETE)$/i;
// Kept in sync with post-run-adjudicator.BUSINESS_PATH_RE — a failing request on
// any of these is load-bearing by definition and must never be folded to green.
const BUSINESS_PATH_RE = /(?:\/api\/|\/graphql|\/rest\/|\/v\d+\/|\/batch|\/print|\/upload|\/download|\/export|\/import|\/save|\/create|\/update|\/edit|\/delete|\/remove|\/submit|\/tasks?|\/checkout|\/cart|\/order|\/orders|\/basket|\/payment|\/pay\b|\/purchase|\/refund|\/transfer|\/transaction|\/account|\/withdraw|\/deposit|\/booking|\/reservation|\/appointment|\/schedule|\/apply|\/approve|\/reject|\/confirm|\/place|\/process|\/quote|\/enroll|\/subscribe)/i;

/**
 * @param {Object} args
 * @param {Object} args.evidence  run evidence ({ rows: [...] }) from run-evidence
 * @param {Object} [args.guard]   business guard ({ protectedNames: Set })
 * @param {Set<string>} [args.protectedLabels] extra labels never to fold
 * @returns {Array<{index:number,label:string,responseCode:string,reason:string}>}
 */
function detectNonLoadBearingFailures({ evidence = null, guard = null, protectedLabels = new Set() } = {}) {
    const rows = ((evidence && evidence.rows) || [])
        .filter(r => r && !r.isTransaction && Number.isFinite(Number(r.entryIndex)))
        .slice()
        .sort((a, b) => Number(a.entryIndex) - Number(b.entryIndex));
    if (!rows.length) return [];

    const failed = (r) => r.success === false || Number(r.observedStatus || 0) >= 400;
    const isProtected = (r) => guardProtects(guard, r.label) || protectedLabels.has(String(r.label || '').trim());
    const isBusiness = (r) => {
        const method = String(r.method || (r.entry && r.entry.request && r.entry.request.method) || 'GET').toUpperCase();
        const hay = `${r.label || ''} ${r.finalUrl || ''} ${pathOf(r)}`;
        return MUTATING_METHOD_RE.test(method) && BUSINESS_PATH_RE.test(hay);
    };

    const candidate = new Set(); // row array indices
    // Peel trailing isolated failures from the end: a failing row is folded only
    // when every failure DOWNSTREAM of it is already a fold candidate — so a
    // chain of plumbing failures (resume 401 → oauth/token 403) all qualify even
    // though each is "downstream" of the other.
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = rows.length - 1; i >= 0; i--) {
            if (candidate.has(i)) continue;
            const r = rows[i];
            if (!failed(r)) continue;
            if (isProtected(r) || isBusiness(r)) continue; // real failure — never fold
            let loadBearingDownstream = false;
            let successDownstream = false;
            for (let j = i + 1; j < rows.length; j++) {
                if (failed(rows[j])) { if (!candidate.has(j)) { loadBearingDownstream = true; break; } }
                else successDownstream = true;
            }
            if (!loadBearingDownstream && successDownstream) { candidate.add(i); changed = true; }
        }
    }

    return [...candidate]
        .sort((a, b) => a - b)
        .map(i => ({
            index: Number(rows[i].entryIndex),
            label: rows[i].label,
            responseCode: String(rows[i].observedStatus || ''),
            reason: `failed (${rows[i].observedStatus || '4xx'}) but every downstream request still passed — not load-bearing; the session rode cookies / the followed redirect chain`,
        }));
}

function guardProtects(guard, label) {
    return !!(guard && guard.protectedNames && guard.protectedNames.has(String(label || '').trim()));
}

function pathOf(row) {
    const url = row && (row.finalUrl || (row.entry && row.entry.request && row.entry.request.url));
    try { return new URL(url || '').pathname || '/'; }
    catch { return String((row && row.path) || url || '/').split('?')[0] || '/'; }
}

module.exports = { detectNonLoadBearingFailures, _internal: { BUSINESS_PATH_RE } };
