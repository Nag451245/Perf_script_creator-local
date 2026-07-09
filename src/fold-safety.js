'use strict';
/**
 * fold-safety.js — decide, from RECORDING EVIDENCE alone, whether folding
 * (disabling) a request is safe, for ANY app with zero taught rules.
 *
 * A request may be folded only when the recording proves the flow survives
 * without it. Two questions decide it — the exact two a senior engineer asks
 * before deleting a sampler:
 *
 *   CHECK 1 (upstream feed) — does an UPSTREAM request send a value this
 *     request consumes? If so, this request participates in a value chain and
 *     is not obviously disposable; folding it on a heuristic hunch is unsafe,
 *     so we mark UNCERTAIN and let the live fold-probe decide.
 *
 *   CHECK 2 (downstream dependency) — does this request GENERATE a value a
 *     later request consumes, or NAVIGATE the page to a location the next
 *     request depends on? If so, folding it starves or misdirects the
 *     downstream request and the JMX can never go green past this point.
 *     Hard UNSAFE.
 *
 * Verdicts:
 *   'safe'      produces nothing consumed downstream, no load-bearing
 *               navigation, consumes nothing upstream → fold freely.
 *   'unsafe'    Check 2 tripped → never fold on evidence; only an explicit
 *               operator disable may override (operator tier is absolute).
 *   'uncertain' Check 1 tripped but Check 2 clean → do NOT fold at generation;
 *               defer to the live fold-probe (replay with it disabled and
 *               confirm the business flow still holds) before folding.
 *
 * Navigation reproduction: a DUPLICATE redirect hop is safe to fold even
 * though it navigates, because the PARENT's followed redirect chain performs
 * the same navigation (JMeter follows it). The caller passes the proven
 * duplicate-hop set so this module treats their navigation as reproduced.
 */
const { buildLinks } = require('./replay-correlate');
const { _internal: { buildCookieLinks } } = require('./value-flow-decisions');

/**
 * @param {Array}  entries        canonical recording entries
 * @param {Object} opts
 * @param {Set<number>} opts.foldingIndexes indexes also being folded this pass
 *        (a consumer that is itself folded doesn't count as a live dependency)
 * @param {Set<number>} opts.duplicateHopIndexes proven duplicate hops — their
 *        navigation is reproduced by the parent chain
 * @returns {{ byIndex: Object<number,{verdict,reasons,checks}> }}
 */
function assessFoldSafety(entries = [], opts = {}) {
    const foldingIndexes = opts.foldingIndexes instanceof Set ? opts.foldingIndexes : new Set();
    const duplicateHopIndexes = opts.duplicateHopIndexes instanceof Set ? opts.duplicateHopIndexes : new Set();

    const valueLinks = (buildLinks(entries).links || []).map(l => ({ ...l, kind: 'value' }));
    const cookieLinks = (buildCookieLinks(entries) || []).map(l => ({ ...l, kind: 'cookie' }));
    const links = [...valueLinks, ...cookieLinks];

    const producedBy = new Map();  // producer index -> links it produces
    const consumedBy = new Map();  // consumer index -> links it consumes
    for (const link of links) {
        if (!producedBy.has(link.producer)) producedBy.set(link.producer, []);
        producedBy.get(link.producer).push(link);
        if (!consumedBy.has(link.consumer)) consumedBy.set(link.consumer, []);
        consumedBy.get(link.consumer).push(link);
    }

    const byIndex = {};
    for (let i = 0; i < entries.length; i++) {
        byIndex[i] = assessOne({
            entries, index: i, producedBy, consumedBy, foldingIndexes, duplicateHopIndexes,
        });
    }
    return { byIndex, links };
}

function assessOne({ entries, index, producedBy, consumedBy, foldingIndexes, duplicateHopIndexes }) {
    const reasons = [];
    const checks = {};

    // CHECK 2a — produces a value/cookie a LATER, still-enabled request needs.
    // A cookie produced by a duplicate redirect hop is exempt: JMeter's Cookie
    // Manager captures Set-Cookie while FOLLOWING the parent's redirect chain,
    // so the standalone sampler is not the only source.
    const produced = producedBy.get(index) || [];
    const liveConsumers = produced.filter(l => l.consumer > index && !foldingIndexes.has(l.consumer));
    const nonCookieProducers = liveConsumers.filter(l => !(l.kind === 'cookie' && duplicateHopIndexes.has(index)));
    checks.producesDownstreamValue = nonCookieProducers.length;
    if (nonCookieProducers.length) {
        reasons.push(`generates ${nonCookieProducers.length} value(s) a later request consumes (indexes ${[...new Set(nonCookieProducers.map(l => l.consumer))].slice(0, 5).join(', ')})`);
    }

    // CHECK 2b — load-bearing navigation: this response redirects to the URL
    // the NEXT still-enabled request targets, and nothing else re-establishes
    // that navigation. A proven duplicate hop is exempt (parent reproduces it).
    const nav = navigationDependency({ entries, index, foldingIndexes });
    checks.loadBearingNavigation = nav.loadBearing && !duplicateHopIndexes.has(index);
    if (checks.loadBearingNavigation) {
        reasons.push(`navigates to ${nav.target} which the next request (index ${nav.nextIndex}) depends on, and no other enabled request re-establishes it`);
    }

    // CHECK 1 — consumes a value an UPSTREAM request produced.
    const consumed = consumedBy.get(index) || [];
    const upstreamFeed = consumed.filter(l => l.producer < index);
    checks.consumesUpstreamValue = upstreamFeed.length;
    if (upstreamFeed.length) {
        reasons.push(`consumes ${upstreamFeed.length} value(s) produced upstream (indexes ${[...new Set(upstreamFeed.map(l => l.producer))].slice(0, 5).join(', ')})`);
    }

    let verdict;
    if (checks.producesDownstreamValue || checks.loadBearingNavigation) verdict = 'unsafe';
    else if (checks.consumesUpstreamValue) verdict = 'uncertain';
    else verdict = 'safe';

    return { index, verdict, reasons, checks };
}

/**
 * Does entry[index] redirect to the URL the next still-enabled entry targets,
 * with no other enabled entry re-establishing that navigation?
 */
function navigationDependency({ entries, index, foldingIndexes }) {
    const status = Number(entries[index] && entries[index].response && entries[index].response.status || 0);
    if (status < 300 || status >= 400) return { loadBearing: false };
    const location = headerValue(entries[index], 'location');
    if (!location) return { loadBearing: false };
    let target;
    try { target = new URL(location, urlOf(entries[index])); } catch { return { loadBearing: false }; }

    // Next still-enabled request after this one.
    let nextIndex = -1;
    for (let j = index + 1; j < entries.length; j++) {
        if (foldingIndexes.has(j)) continue;
        nextIndex = j; break;
    }
    if (nextIndex < 0) return { loadBearing: false };
    let nextUrl;
    try { nextUrl = new URL(urlOf(entries[nextIndex])); } catch { return { loadBearing: false }; }
    if (!sameNav(target, nextUrl)) return { loadBearing: false };

    // Is the navigation to `target` re-established by any OTHER enabled entry
    // (a duplicate hop / a parent chain landing there)? If so, not load-bearing.
    for (let j = 0; j < entries.length; j++) {
        if (j === index || foldingIndexes.has(j)) continue;
        const st = Number(entries[j] && entries[j].response && entries[j].response.status || 0);
        if (st < 300 || st >= 400) continue;
        const loc = headerValue(entries[j], 'location');
        if (!loc) continue;
        try {
            if (sameNav(new URL(loc, urlOf(entries[j])), nextUrl)) return { loadBearing: false };
        } catch { /* skip */ }
    }
    return { loadBearing: true, target: target.pathname, nextIndex };
}

function sameNav(a, b) {
    return a.origin === b.origin && a.pathname === b.pathname;
}

function urlOf(entry) {
    return (entry && entry.request && entry.request.url) || '';
}

function headerValue(entry, name) {
    for (const h of (entry && entry.response && entry.response.headers) || []) {
        if (String(h.name || '').toLowerCase() === name) return h.value;
    }
    return '';
}

module.exports = { assessFoldSafety, _internal: { navigationDependency } };
