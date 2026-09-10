'use strict';
/**
 * run-summary.js — tell the operator what to DO, and what changed since last
 * time.
 *
 * Two gaps this closes, both observed in real use:
 *
 * 1. "Verdict: needs attention" is a STATUS, not an instruction. The operator
 *    then has to interpret it — and the recurring question was exactly that:
 *    "does it say green or needs attention?", "it passed but the logs say
 *    otherwise". A verdict should end in a decision: run it, run it but look
 *    at these, or don't run it yet and here is why.
 *
 * 2. Nothing compared a run to the one before it. When scripts that used to
 *    work started failing, the agent had no answer — the numbers were on disk
 *    the whole time (86 samplers then, 61 now) and nobody looked. A run keeps
 *    a short history so the next one can say what moved.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = 'run_history.json';
const MAX_HISTORY = 10;

// The history lives under evidence/ rather than at the root: nobody opens it by
// hand, and the root is meant to hold only the deliverable and the files a
// human reads. It must NOT sit loose at the root either — the organizer files
// stray root files into evidence/ anyway, and a history that moves every run is
// a history the next run cannot find.
function historyPath(outDir) { return path.join(outDir, 'evidence', HISTORY_FILE); }
function legacyHistoryPath(outDir) { return path.join(outDir, HISTORY_FILE); }

function readHistoryFile(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
}

function loadHistory(outDir) {
    return readHistoryFile(historyPath(outDir)) || readHistoryFile(legacyHistoryPath(outDir)) || [];
}

/** Record this run, newest last, keeping only the recent past. */
function appendHistory(outDir, entry) {
    const history = loadHistory(outDir);
    history.push({ at: new Date().toISOString(), ...entry });
    const trimmed = history.slice(-MAX_HISTORY);
    try {
        fs.mkdirSync(path.dirname(historyPath(outDir)), { recursive: true });
        fs.writeFileSync(historyPath(outDir), JSON.stringify(trimmed, null, 2));
        // A folder written by an older build keeps a copy at the root; leaving
        // it means two histories that disagree.
        const legacy = legacyHistoryPath(outDir);
        if (fs.existsSync(legacy)) { try { fs.unlinkSync(legacy); } catch { /* locked */ } }
    } catch { /* best effort — history is a convenience, never a blocker */ }
    return trimmed;
}

/** The numbers worth comparing between two runs of the same flow. */
function summarizeRun({ result = {}, gate = null, disabledCount = 0, verdict = '' } = {}) {
    const samples = (result.samples || []).filter(s => s && !s.isTransaction);
    return {
        verdict,
        requests: samples.length,
        passed: samples.filter(s => s.success !== false).length,
        disabled: Number(disabledCount) || 0,
        gates: gate && Array.isArray(gate.failures) ? gate.failures.map(f => f.category) : [],
    };
}

/**
 * What moved since the previous run? Deliberately plain sentences: this is
 * read at a glance, usually by someone asking "why is this different today".
 */
function describeChange(previous, current) {
    if (!previous || !current) return '';
    const parts = [];
    if (current.passed !== previous.passed || current.requests !== previous.requests) {
        parts.push(`${current.passed}/${current.requests} requests passed (was ${previous.passed}/${previous.requests})`);
    }
    const disabledDelta = (current.disabled || 0) - (previous.disabled || 0);
    if (disabledDelta > 0) parts.push(`${disabledDelta} more request(s) disabled than last time`);
    if (disabledDelta < 0) parts.push(`${-disabledDelta} request(s) re-enabled since last time`);

    const before = new Set(previous.gates || []);
    const after = new Set(current.gates || []);
    const appeared = [...after].filter(g => !before.has(g));
    const cleared = [...before].filter(g => !after.has(g));
    if (appeared.length) parts.push(`new problem(s): ${appeared.join(', ')}`);
    if (cleared.length) parts.push(`fixed since last run: ${cleared.join(', ')}`);
    if (previous.verdict && current.verdict && previous.verdict !== current.verdict) {
        parts.push(`verdict moved from "${previous.verdict}" to "${current.verdict}"`);
    }
    return parts.length ? `Since the last run: ${parts.join('; ')}.` : 'Since the last run: nothing material changed.';
}

/**
 * The one line that replaces the verdict word: what should the operator do
 * with this script, right now? Ordered by what blocks hardest.
 */
/**
 * How many samplers answered with a success STATUS but failed their job? These
 * are the ones that make a run read "61/61 passed" while the script is broken.
 */
function falsePassCount(gate) {
    if (!gate || !Array.isArray(gate.failures)) return 0;
    const labels = new Set();
    for (const f of gate.failures) {
        if (f.category === 'auth_wall') {
            for (const w of f.walls || []) if (w.passed) labels.add(String(w.sampler || ''));
        }
        if (f.category === 'business_error_in_body' || f.category === 'business_marker_missing') {
            const items = Array.isArray(f.details) && f.details.length ? f.details : [f];
            for (const d of items) labels.add(String(d.sampler || d.label || ''));
        }
    }
    labels.delete('');
    return labels.size;
}

/** The server's own words for why, when the gate captured them. */
function statedReason(gate) {
    if (!gate || !Array.isArray(gate.failures)) return '';
    for (const f of gate.failures) {
        if (f.category !== 'business_error_in_body') continue;
        const items = Array.isArray(f.details) && f.details.length ? f.details : [f];
        const marker = items.map(d => d.marker).find(Boolean);
        if (marker) return String(marker);
    }
    return '';
}

function nextAction({ verdict = '', gate = null, blockers = [], continuation = null, validated = false } = {}) {
    const categories = gate && Array.isArray(gate.failures) ? gate.failures.map(f => f.category) : [];
    const has = (c) => categories.includes(c);
    const falsePasses = falsePassCount(gate);
    const reason = statedReason(gate);

    if (has('auth_wall')) {
        return {
            headline: 'Do not run this yet — nobody is logged in.',
            detail: `Requests are coming back as the login page with an HTTP 200, so every "pass" after login is measuring the login screen`
                + `${falsePasses ? `; ${falsePasses} sampler(s) counted as PASSING while doing nothing` : ''}.`
                + `${reason ? ` The server's own words: "${reason}".` : ''}`
                + ' Fix the sign-in first; see "What a human needs to provide" in the report.',
        };
    }
    if (blockers && blockers.length) {
        // The headline stays short and constant. An earlier version inlined the
        // blocker text and the guide then shouted a 90-character diagnosis in
        // capitals — the specifics belong in the detail, where they read.
        const first = blockers[0] || {};
        const what = String(first.blocker || '').trim();
        const ask = String(first.ask || '').trim();
        return {
            headline: 'Needs something from you before this can pass.',
            detail: [what, ask].filter(Boolean).join(' — ').slice(0, 400) || 'See "What a human needs to provide" in the report.',
        };
    }
    if (continuation && continuation.status === 'fixable_out_of_budget') {
        return {
            headline: 'Not stuck — it just ran out of iterations.',
            detail: continuation.message,
        };
    }
    if (has('business_marker_missing') || has('business_error_in_body')) {
        return {
            headline: falsePasses
                ? `Do not trust this run — ${falsePasses} step(s) reported success without doing their job.`
                : 'Run it, but check the flagged steps first.',
            detail: `JMeter counted these as passing because the status line said 200, but the response body says the step failed`
                + `${reason ? ` — the server said "${reason}"` : ''}.`
                + ' See "Passed in JMeter, but the body says otherwise" at the top of the report.',
        };
    }
    if (categories.length) {
        return {
            headline: 'Run it, but read the flagged items first.',
            detail: `Checks that did not pass: ${categories.join(', ')}. Each is explained in the report.`,
        };
    }
    if (!validated) {
        return {
            headline: 'Generated, but not proven yet.',
            detail: 'The script was built but never run against your environment. Run it here with validation on, or open it in JMeter yourself.',
        };
    }
    return {
        headline: 'Ready to run.',
        detail: 'Every request passed and the business checks held. Open it in JMeter and scale it up.',
    };
}

/**
 * The one small file the UI's run list reads: did it run, did it pass, how many
 * requests, how many iterations.
 *
 * It exists because the list used to read `<flow>_report.json`, and the output
 * tidy-up prunes that as a "JSON twin of report.html". Every organized folder
 * therefore showed "0 samples · generated" for a run that had actually
 * validated — the operator could not see pass/fail or iteration count anywhere
 * but the log. This file is tiny, stays at the folder root, and is never
 * pruned.
 */
const SUMMARY_FILE = 'run_summary.json';

function writeRunSummary(outDir, summary) {
    try {
        fs.writeFileSync(path.join(outDir, SUMMARY_FILE), JSON.stringify({
            writtenAt: new Date().toISOString(), ...summary,
        }, null, 2));
    } catch { /* the log still has it */ }
}

function readRunSummary(outDir) {
    try { return JSON.parse(fs.readFileSync(path.join(outDir, SUMMARY_FILE), 'utf8')); }
    catch { return null; }
}

module.exports = {
    nextAction, falsePassCount, statedReason, describeChange, summarizeRun, appendHistory, loadHistory,
    writeRunSummary, readRunSummary, SUMMARY_FILE,
};
