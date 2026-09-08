'use strict';
/**
 * knowledge-base.js — the agent's expert knowledge, as DATA.
 *
 * The 70 modules around this one encode expertise as code: each knows one
 * pattern and fires on a hardcoded trigger. That makes the agent exactly as
 * smart as the patterns someone wrote, and it can only get smarter when a
 * developer edits JavaScript.
 *
 * This is the other half — a knowledge base a performance engineer can read,
 * extend, and correct without touching code. Each entry is a DIAGNOSIS, not a
 * rule:
 *
 *   symptom      what you observe
 *   when         the conditions under which this applies (checks below)
 *   discriminate the cheap test that tells this apart from look-alikes
 *   remedy       what a senior would do about it
 *   verify       how you know it actually worked
 *   confidence   how sure we are (learned entries decay; seeded ones don't)
 *
 * That shape is what makes this composable with hypothesis-driven diagnosis
 * later: a matched entry is a ranked hypothesis that already carries its own
 * experiment and its own definition of done.
 *
 * SAFETY: knowledge PROPOSES, evidence DISPOSES. Nothing here changes a
 * script or a verdict on its own — findings are advisory until a gate proves
 * them. A knowledge base that could act unilaterally would let one wrong
 * entry quietly break every future run.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

/**
 * The check vocabulary an entry's `when` clause may use. Small on purpose:
 * every check is cheap, deterministic, and evaluated against the run context
 * (the generated script, the recording, and the run config). Adding a check
 * is a deliberate act; adding an ENTRY should not be.
 *
 * Each returns { hit: boolean, evidence?: string }.
 */
const CHECKS = {
    /** A request parameter whose value is still a recorded literal (not ${var}). */
    scriptSendsLiteralParam({ xml }, { namePattern, minLength = 0 }) {
        const re = safeRe(namePattern);
        if (!re) return { hit: false };
        const hits = [];
        for (const m of String(xml || '').matchAll(
            /<stringProp name="Argument\.name">([^<]*)<\/stringProp>\s*<stringProp name="Argument\.value">([^<]*)</g)) {
            const name = decodeXml(m[1]);
            const value = decodeXml(m[2]);
            if (!re.test(name)) continue;
            if (value.includes('${')) continue;              // already correlated/parameterized
            if (value.length < minLength) continue;
            hits.push(`${name}=${value.slice(0, 24)}…`);
            if (hits.length >= 3) break;
        }
        return { hit: hits.length > 0, evidence: hits.join('; ') };
    },

    /** The script defines no extractor producing this variable name. */
    scriptHasNoExtractorFor({ xml }, { refname }) {
        const re = safeRe(refname);
        if (!re) return { hit: false };
        for (const m of String(xml || '').matchAll(/(?:refname|referenceNames)">([^<]+)</g)) {
            for (const nm of m[1].split(/[,;]/)) if (re.test(nm.trim())) return { hit: false };
        }
        return { hit: true, evidence: `no extractor produces /${refname}/` };
    },

    /** The recording shows a response header/cookie matching a pattern. */
    recordingSetsCookie({ entries }, { namePattern }) {
        const re = safeRe(namePattern);
        if (!re) return { hit: false };
        const names = new Set();
        for (const e of entries || []) {
            for (const h of (e.response && e.response.headers) || []) {
                if (!/^set-cookie$/i.test(String(h.name || ''))) continue;
                const cookie = String(h.value || '').split('=')[0].trim();
                if (re.test(cookie)) names.add(cookie);
            }
        }
        return { hit: names.size > 0, evidence: [...names].slice(0, 4).join(', ') };
    },

    /** The script is missing a JMeter manager element it needs. */
    scriptMissingElement({ xml }, { element }) {
        return { hit: !new RegExp(`<${element}\\b`).test(String(xml || '')), evidence: `<${element}> absent` };
    },

    /** Fewer unique data rows than the users this script will be run with. */
    dataRowsBelowUsers({ dataRows, users }, { minRatio = 1 }) {
        const rows = Number(dataRows) || 0;
        const u = Number(users) || 0;
        if (!rows || u <= 1) return { hit: false };
        if (rows >= u * minRatio) return { hit: false };
        return { hit: true, evidence: `${rows} data row(s) for ${u} users` };
    },

    /** The recording carries (almost) no response bodies to correlate from. */
    recordingBodyCoverageBelow({ entries }, { pct = 25 }) {
        const list = entries || [];
        if (!list.length) return { hit: false };
        const withBody = list.filter(e =>
            String((e.response && e.response.content && e.response.content.text) || '')).length;
        const share = Math.round((withBody / list.length) * 100);
        return { hit: share < pct, evidence: `${share}% of requests have a response body` };
    },

    /** The script relies on status codes alone — no assertions at all. */
    scriptHasNoAssertions({ xml }) {
        const has = /<(ResponseAssertion|JSONPathAssertion|XPath2Assertion|SizeAssertion)\b/.test(String(xml || ''));
        return { hit: !has, evidence: 'no assertion elements in the plan' };
    },

    /** An extractor with no sane default silently yields an empty variable. */
    extractorWithoutDefault({ xml }) {
        const bad = [];
        for (const m of String(xml || '').matchAll(/<RegexExtractor\b[\s\S]*?<\/RegexExtractor>/g)) {
            const block = m[0];
            const ref = (block.match(/refname">([^<]*)</) || [])[1] || '?';
            const def = (block.match(/\.default">([^<]*)</) || [])[1];
            if (def == null || def === '') bad.push(ref);
            if (bad.length >= 3) break;
        }
        return { hit: bad.length > 0, evidence: bad.join(', ') };
    },

    /** The recording's stack fingerprint matches (e.g. asp.net, jsf, saml). */
    stackIs({ stack }, { any = [] }) {
        const have = (stack || []).map(s => String(s).toLowerCase());
        const want = any.map(s => String(s).toLowerCase());
        const hit = want.some(w => have.some(h => h.includes(w)));
        return { hit, evidence: hit ? have.join(', ') : '' };
    },

    /** A request sends a value that a LATER-or-equal request also produces —
     *  i.e. a dynamic value shipped as a literal even though a producer exists. */
    literalHasProducerInRecording({ entries, xml }, { minLength = 20 }) {
        const literals = new Set();
        for (const m of String(xml || '').matchAll(/<stringProp name="Argument\.value">([^<]*)</g)) {
            const v = decodeXml(m[1]);
            if (v.length >= minLength && !v.includes('${') && /^[A-Za-z0-9_\-+/=]+$/.test(v)) literals.add(v);
            if (literals.size >= 60) break;
        }
        if (!literals.size) return { hit: false };
        const found = [];
        for (const e of entries || []) {
            const body = String((e.response && e.response.content && e.response.content.text) || '');
            if (!body) continue;
            for (const v of literals) {
                if (body.includes(v)) { found.push(v.slice(0, 18) + '…'); literals.delete(v); }
                if (found.length >= 3) break;
            }
            if (found.length >= 3) break;
        }
        return { hit: found.length > 0, evidence: found.join(', ') };
    },
};

function safeRe(pattern) {
    try { return new RegExp(pattern, 'i'); } catch { return null; }
}
function decodeXml(s) {
    return String(s || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** Load every knowledge file in a directory (plus any extra file paths). */
function loadKnowledge({ dir = DEFAULT_KNOWLEDGE_DIR, extraFiles = [] } = {}) {
    const entries = [];
    const files = [];
    try {
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) if (/\.json$/i.test(f)) files.push(path.join(dir, f));
        }
    } catch { /* no knowledge dir — the agent still runs, just without priors */ }
    for (const f of [...files, ...(extraFiles || [])]) {
        try {
            const parsed = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
            const list = Array.isArray(parsed) ? parsed : (parsed.entries || []);
            for (const e of list) if (e && e.id && Array.isArray(e.when)) entries.push({ source: path.basename(f), ...e });
        } catch { /* a malformed knowledge file must never break a run */ }
    }
    return entries;
}

/**
 * Review a script + recording against the knowledge base.
 * @returns {Array} findings, most-confident first, each carrying the senior's
 *          remedy, the discriminating test, and how to verify the fix.
 */
function reviewAgainstKnowledge(context = {}, { knowledge = null } = {}) {
    const kb = knowledge || loadKnowledge();
    const findings = [];
    for (const entry of kb) {
        const evidence = [];
        let matched = true;
        for (const clause of entry.when) {
            const check = CHECKS[clause && clause.check];
            if (!check) { matched = false; break; }        // unknown check => never guess
            let res;
            try { res = check(context, clause) || {}; } catch { res = {}; }
            const want = clause.expect !== false;           // default: expect a hit
            if (!!res.hit !== want) { matched = false; break; }
            if (res.evidence) evidence.push(res.evidence);
        }
        if (!matched) continue;
        findings.push({
            id: entry.id,
            title: entry.title,
            severity: entry.severity || 'medium',
            confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.8,
            symptom: entry.symptom || '',
            evidence: evidence.join(' · '),
            discriminate: entry.discriminate || '',
            remedy: entry.remedy || '',
            verify: entry.verify || '',
            source: entry.source,
        });
    }
    const rank = s => (s === 'high' ? 3 : s === 'medium' ? 2 : 1);
    return findings.sort((a, b) => rank(b.severity) - rank(a.severity) || b.confidence - a.confidence);
}

module.exports = { loadKnowledge, reviewAgainstKnowledge, CHECKS, DEFAULT_KNOWLEDGE_DIR };
