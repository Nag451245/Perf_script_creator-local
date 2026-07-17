'use strict';
/**
 * invariants.js — body-truth for every business step, mined from the two
 * recordings' AGREEMENT.
 *
 * A single recording cannot tell a stable business marker from volatile noise:
 * timestamps, session ids and record numbers change on every visit. But two
 * independent recordings of the same journey agree on exactly the parts that
 * MEAN something — the JSON keys a working response carries, the title of the
 * page that really loaded. Anything identical across Rec1 and Rec2 is provably
 * stable; anything else must not be asserted or the gate turns flaky.
 *
 * This generalizes the two body checks that already exist — the auth wall
 * (login markers where the recording had none) and the outcome probe (the
 * submitted value echoed) — into per-step assertions across the whole flow:
 * a sampler may return 200 and still fail its step, because the markers both
 * recordings swear by are missing from the live body.
 *
 * Discipline against false reds:
 *   - only markers present in BOTH recordings' response for the SAME step;
 *   - only DISCRIMINATIVE markers (shared by few other steps — a boilerplate
 *     key present everywhere proves nothing and would mask an auth wall);
 *   - steps need >= MIN_MARKERS to be gated at all;
 *   - a live row with no captured body is never judged;
 *   - one config switch (run.invariants.enabled=false) turns it all off.
 */

const JSON_KEY_RE = /"([A-Za-z_][A-Za-z0-9_]{2,30})"\s*:/g;
const TITLE_RE = /<title>\s*([^<]{3,120}?)\s*<\/title>/i;
const MAX_MARKERS_PER_STEP = 6;
const MIN_MARKERS_TO_GATE = 2;
// a marker carried by more than this share of steps is boilerplate, not truth
const DISCRIMINATIVE_MAX_SHARE = 0.5;

function bodyOf(entry) {
    return String((entry && entry.response && entry.response.content && entry.response.content.text) || '');
}
function pathnameOf(entry) {
    try { return new URL(entry.request.url).pathname; } catch { return String((entry && entry.request && entry.request.url) || '').split('?')[0]; }
}
function methodOf(entry) {
    return String((entry && entry.request && entry.request.method) || 'GET').toUpperCase();
}

/** Markers one body offers: JSON key set, or a page title. */
function candidateMarkers(body) {
    const text = String(body || '');
    if (!text) return [];
    const out = new Set();
    if (/^[\s﻿]*[{[]/.test(text)) {
        let m; const re = new RegExp(JSON_KEY_RE.source, 'g');
        while ((m = re.exec(text)) !== null && out.size < 40) out.add(`json-key:${m[1]}`);
    } else {
        const t = text.match(TITLE_RE);
        if (t) out.add(`title:${t[1]}`);
    }
    return [...out];
}

/** Does a live body carry this marker? */
function markerPresent(body, marker) {
    const text = String(body || '');
    if (!text) return false;
    if (marker.startsWith('json-key:')) return text.includes(`"${marker.slice(9)}"`);
    if (marker.startsWith('title:')) {
        const t = text.match(TITLE_RE);
        return !!t && t[1] === marker.slice(6);
    }
    return false;
}

/**
 * Align secondary-recording entries to primary ones: same method + pathname,
 * matched by occurrence order. Rotating query values must not defeat the
 * match; a different journey through the same pages still aligns.
 */
function alignSecondary(primary = [], secondary = []) {
    const buckets = new Map();
    for (const e of secondary) {
        const key = `${methodOf(e)} ${pathnameOf(e)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(e);
    }
    const used = new Map();
    return primary.map(e => {
        const key = `${methodOf(e)} ${pathnameOf(e)}`;
        const list = buckets.get(key) || [];
        const idx = used.get(key) || 0;
        used.set(key, idx + 1);
        return list[idx] || list[list.length - 1] || null;
    });
}

/**
 * Mine per-step invariants from the two recordings' agreement.
 * @returns {{ byEntryIndex: Object<number,{markers:string[],path:string}>, steps: number }}
 */
function mineInvariants({ primary = [], secondary = [] } = {}) {
    if (!primary.length || !secondary.length) return { byEntryIndex: {}, steps: 0 };
    const paired = alignSecondary(primary, secondary);
    // agreement per step
    const perStep = primary.map((e, i) => {
        const twin = paired[i];
        if (!twin) return [];
        const a = candidateMarkers(bodyOf(e));
        if (!a.length) return [];
        const b = new Set(candidateMarkers(bodyOf(twin)));
        return a.filter(m => b.has(m));
    });
    // discriminativity: drop markers most steps carry (boilerplate)
    const stepCount = perStep.filter(s => s.length).length || 1;
    const tally = new Map();
    for (const step of perStep) for (const m of new Set(step)) tally.set(m, (tally.get(m) || 0) + 1);
    const byEntryIndex = {};
    perStep.forEach((markers, i) => {
        const kept = markers
            .filter(m => (tally.get(m) || 0) / stepCount <= DISCRIMINATIVE_MAX_SHARE)
            .slice(0, MAX_MARKERS_PER_STEP);
        if (kept.length >= MIN_MARKERS_TO_GATE) {
            byEntryIndex[i] = { markers: kept, path: pathnameOf(primary[i]) };
        }
    });
    return { byEntryIndex, steps: Object.keys(byEntryIndex).length };
}

/**
 * Judge live evidence rows against the mined invariants.
 * Only PASSING rows with a captured body are judged — a failing row already
 * has a verdict, and a body-less row offers no evidence either way.
 * @returns {Array<{index,sampler,missing:string[],expected:number}>}
 */
function checkInvariants({ rows = [], invariants = null } = {}) {
    const map = (invariants && invariants.byEntryIndex) || {};
    const out = [];
    for (const r of rows) {
        if (!r || r.isTransaction || r.success === false) continue;
        const inv = map[r.entryIndex];
        const body = String(r.observedBody || '');
        if (!inv || !body) continue;
        const missing = inv.markers.filter(m => !markerPresent(body, m));
        // ALL markers gone => the step's real content is absent (auth wall,
        // error page, wrong response). A partial miss is drift worth flagging
        // only when most of the step's truth vanished.
        if (missing.length && missing.length >= Math.ceil(inv.markers.length * 0.75)) {
            out.push({ index: r.entryIndex, sampler: r.label, missing, expected: inv.markers.length });
        }
    }
    return out;
}

module.exports = { mineInvariants, checkInvariants, _internal: { candidateMarkers, markerPresent, alignSecondary } };
