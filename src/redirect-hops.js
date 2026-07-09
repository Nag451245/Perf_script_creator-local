'use strict';
/**
 * redirect-hops.js — identify DUPLICATE redirect-hop samplers from recording
 * evidence alone, for any app, with zero taught rules.
 *
 * The class that keeps tripping scripts (live case: /s/interceptor/authorize/
 * appearing inside TWO transactions and killing the session both times):
 * browser recordings list every hop of a redirect chain as its own entry, so
 * generation emits a standalone sampler for a request that JMeter ALREADY
 * executes while following the parent's redirects. Replaying the hop again,
 * out of band, re-fires a single-use token (state/code/interceptor grant) —
 * which invalidates the session the chain just established. The failure then
 * surfaces downstream and looks like a correlation bug. It is not.
 *
 * The recording PROVES duplicateness, no path knowledge needed:
 *   entry[j] responded 3xx with a Location that resolves to entry[i]'s URL
 *   (i right after j, allowing a small gap for interleaved beacons), and
 *   entry[i] is a GET (Location hops always replay as GET).
 *
 * Every detected hop carries its parent/root so reports can show the chain.
 * This is EVIDENCE-tier: it outranks "path looks session-like" priors —
 * folding is safe BY CONSTRUCTION because the parent still executes the hop
 * inside its followed chain. Only an explicit operator protect may override.
 */

const GAP = 3; // tolerate interleaved beacons/favicons between chain hops

function detectDuplicateRedirectHops(entries = []) {
    const byIndex = {};
    for (let i = 1; i < entries.length; i++) {
        const cur = entries[i];
        if (!cur || methodOf(cur) !== 'GET') continue;
        const curUrl = urlOf(cur);
        if (!curUrl) continue;
        for (let j = i - 1; j >= Math.max(0, i - GAP); j--) {
            const prev = entries[j];
            const status = Number(prev && prev.response && prev.response.status || 0);
            if (status < 300 || status >= 400) continue;
            const location = headerValue(prev, 'location');
            if (!location) continue;
            let target;
            try { target = new URL(location, urlOf(prev)); } catch { continue; }
            if (!sameRequest(target, curUrl)) continue;
            const parentDup = byIndex[j];
            byIndex[i] = {
                index: i,
                parentIndex: j,
                rootIndex: parentDup ? parentDup.rootIndex : j,
                url: curUrl.href,
                via: `${status} Location from entry ${j}`,
            };
            break;
        }
    }
    const indexes = Object.keys(byIndex).map(Number);
    return { byIndex, indexes };
}

/**
 * Exact URL match, or same origin+path with the same query-parameter NAMES —
 * rotating values (state, code, nonce) must not defeat the match; a hop is
 * the same hop even when its single-use token differs.
 */
function sameRequest(a, b) {
    if (a.href === b.href) return true;
    if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
    const names = (u) => [...u.searchParams.keys()].sort().join(',');
    return names(a) === names(b);
}

function urlOf(entry) {
    try { return new URL(entry && entry.request && entry.request.url || ''); } catch { return null; }
}

function methodOf(entry) {
    return String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
}

function headerValue(entry, name) {
    for (const h of (entry && entry.response && entry.response.headers) || []) {
        if (String(h.name || '').toLowerCase() === name) return h.value;
    }
    return '';
}

module.exports = { detectDuplicateRedirectHops, _internal: { sameRequest } };
