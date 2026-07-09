'use strict';
/**
 * playbooks.js — stack-specific recipes, selected by evidence.
 *
 * A senior engineer walks in with priors: "Auth0 Universal Login → the login
 * state lives in a hidden input", "Dynatrace RUM → /bf? beacons are noise".
 * Playbooks encode those priors as DATA (playbooks/*.json), matched against
 * the recording's stack fingerprint / hosts / paths, and merged into runCfg
 * with strict precedence: explicit config > playbook > code defaults. A
 * playbook can never override something the operator set explicitly.
 *
 * Playbook file shape:
 * {
 *   "id": "auth0-universal-login",
 *   "description": "...",
 *   "match": { "signalsAny": ["oauth"], "hostsAny": ["auth0"], "pathsAny": ["/u/login/"] },
 *   "disableCalls": ["/bf?"],
 *   "oauth": { "dropBareStateNonce": true },
 *   "llmFlowNotes": ["..."],
 *   "expectations": ["human-readable prior for the report"]
 * }
 * At least one match list must hit for the playbook to apply.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'playbooks');

function loadPlaybooks(dir = DEFAULT_DIR) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files.sort()) {
        try {
            const pb = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (pb && pb.id && pb.match) out.push(pb);
        } catch { /* invalid playbook file — skip, never fatal */ }
    }
    return out;
}

/** Build the match haystacks once from the recording. */
function buildEvidence(entries = [], fingerprintSignals = []) {
    const hosts = new Set();
    const paths = [];
    for (const e of entries) {
        try {
            const u = new URL(e.request.url);
            hosts.add(u.hostname.toLowerCase());
            if (paths.length < 4000) paths.push((u.pathname + u.search).toLowerCase());
        } catch { /* unparseable url */ }
    }
    return {
        signals: fingerprintSignals.map(s => String(s.stack || s).toLowerCase()),
        hosts: [...hosts],
        pathsText: paths.join('\n'),
    };
}

function matchPlaybook(pb, evidence) {
    const m = pb.match || {};
    const hits = [];
    for (const sig of m.signalsAny || []) {
        if (evidence.signals.some(s => s.includes(String(sig).toLowerCase()))) hits.push(`signal:${sig}`);
    }
    for (const host of m.hostsAny || []) {
        if (evidence.hosts.some(h => h.includes(String(host).toLowerCase()))) hits.push(`host:${host}`);
    }
    for (const p of m.pathsAny || []) {
        if (evidence.pathsText.includes(String(p).toLowerCase())) hits.push(`path:${p}`);
    }
    return hits;
}

/**
 * Select matching playbooks and merge them into runCfg.
 * Precedence: explicit config wins — playbooks only ADD disables/notes and
 * only fill oauth flags the config leaves undefined.
 *
 * @returns {{ runCfg, applied: Array<{id, evidence:string[], expectations:string[]}>, addedDisables: string[] }}
 */
function applyPlaybooks({ entries = [], fingerprintSignals = [], runCfg = {}, dir } = {}) {
    const playbooks = loadPlaybooks(dir);
    if (!playbooks.length) return { runCfg, applied: [], addedDisables: [] };

    const evidence = buildEvidence(entries, fingerprintSignals);
    const applied = [];
    const merged = { ...runCfg, oauth: { ...(runCfg.oauth || {}) } };
    const existingDisables = new Set((runCfg.disableCalls || []).map(String));
    const existingProtects = new Set((runCfg.protectedCalls || []).map(String));
    const addedDisables = [];
    const addedProtects = [];
    const notes = [...(runCfg.llmFlowNotes || [])];

    for (const pb of playbooks) {
        const hits = matchPlaybook(pb, evidence);
        if (!hits.length) continue;
        for (const d of pb.disableCalls || []) {
            if (!existingDisables.has(d)) { existingDisables.add(d); addedDisables.push(d); }
        }
        // App-specific business nouns: the guard and adjudicator protect
        // these from disabling — playbooks carry them so generic code never
        // has to know one app's endpoint names.
        for (const p of pb.protectedCalls || []) {
            if (!existingProtects.has(p)) { existingProtects.add(p); addedProtects.push(p); }
        }
        for (const [k, v] of Object.entries(pb.oauth || {})) {
            if (merged.oauth[k] === undefined) merged.oauth[k] = v;
        }
        for (const n of pb.llmFlowNotes || []) {
            if (!notes.includes(n)) notes.push(n);
        }
        applied.push({ id: pb.id, evidence: hits, expectations: pb.expectations || [] });
    }

    if (!applied.length) return { runCfg, applied: [], addedDisables: [], addedProtects: [] };
    merged.disableCalls = [...existingDisables];
    merged.protectedCalls = [...existingProtects];
    merged.llmFlowNotes = notes;
    return { runCfg: merged, applied, addedDisables, addedProtects };
}

module.exports = { loadPlaybooks, applyPlaybooks, _internal: { buildEvidence, matchPlaybook } };
