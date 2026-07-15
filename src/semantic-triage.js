'use strict';
/**
 * semantic-triage.js — read what the SERVER SAID, then cross-reference it with
 * what the SCRIPT SENT.
 *
 * A senior engineer doesn't stop at "assertion failed / 4xx": they read the
 * response body — `{"error":"Appointment 844599527 not found"}` — recognise
 * the id as one the script transmitted, trace WHERE it came from (a CSV
 * column, a recorded literal), and conclude "stale test data, column AptID",
 * not "broken correlation". This module does that deterministically:
 *
 *   1. extract the server's stated reason from a failing/assertion-failed
 *      response body (JSON error fields, HTML error titles, common phrases);
 *   2. pull the ids/values embedded in that reason;
 *   3. match them against the values the script sent (CSV columns, request
 *      literals from the recording) and NAME the source;
 *   4. classify: stale_data | validation | auth | server_error | unknown.
 *
 * Output feeds failure forensics and blockers, so the human ask becomes
 * precise: "the server says X no longer exists; it is fed by CSV column Y /
 * lineage variable Z — re-record or refresh the data."
 */

// A login page, recognised by shape rather than by any app's wording: a
// password field, or a login form/title. Deliberately narrow — the recording
// comparison below is what makes a hit conclusive.
const PASSWORD_INPUT_RE = /<input[^>]+type\s*=\s*["']?password["']?/i;
const LOGIN_TITLE_RE = /<title>[^<]*\b(?:log\s?in|sign\s?in|authentication|anmelden|connexion)\b[^<]*<\/title>/i;
const LOGIN_FORM_RE = /<form[^>]+action\s*=\s*["'][^"']*\b(?:login|signin|authenticate|session)\b/i;

const ERROR_FIELD_RE = /"(?:error|error_message|errorMessage|message|detail|details|reason|fault|faultstring)"\s*:\s*"([^"]{4,300})"/gi;
const HTML_TITLE_RE = /<title>([^<]{4,120})<\/title>/i;
const PHRASE_RE = /((?:[A-Za-z][\w\s]{2,40})?(?:not\s+found|no\s+longer\s+(?:exists|available)|does\s+not\s+exist|expired|invalid|locked|denied|unauthoriz|forbidden|deleted|missing|already\s+(?:exists|used))[^.<"{}]{0,80})/gi;
const ID_IN_TEXT_RE = /(?<![0-9A-Za-z])(\d{5,12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9A-Za-z])/gi;

/** Extract the server's stated reasons from a response body. */
function serverReasons(body) {
    const text = String(body || '');
    if (!text) return [];
    const reasons = [];
    let m;
    const ef = new RegExp(ERROR_FIELD_RE.source, 'gi');
    while ((m = ef.exec(text)) !== null && reasons.length < 5) reasons.push(m[1].trim());
    if (!reasons.length) {
        const t = text.match(HTML_TITLE_RE);
        if (t && /error|not found|denied|expired|invalid/i.test(t[1])) reasons.push(t[1].trim());
    }
    if (!reasons.length) {
        const pf = new RegExp(PHRASE_RE.source, 'gi');
        while ((m = pf.exec(text)) !== null && reasons.length < 3) reasons.push(m[1].replace(/\s+/g, ' ').trim());
    }
    return [...new Set(reasons)];
}

function classify(reasons) {
    const hay = reasons.join(' | ').toLowerCase();
    if (!hay) return 'unknown';
    if (/(not found|no longer|does not exist|deleted|missing)/.test(hay)) return 'stale_data';
    if (/(unauthoriz|forbidden|denied|expired|session|login)/.test(hay)) return 'auth';
    if (/(invalid|required|must be|already exists|already used|validation)/.test(hay)) return 'validation';
    return 'unknown';
}

/**
 * Cross-reference: which values in the server's complaint did WE send, and
 * where did each come from?
 * @param {Object} args
 * @param {string[]} args.reasons        extracted server reasons
 * @param {Object}   args.sentSources    valueLiteral -> sourceDescription
 *                   (CSV columns, lineage vars, recorded request literals)
 */
function crossReference({ reasons = [], sentSources = {} } = {}) {
    const matches = [];
    const text = reasons.join(' | ');
    const re = new RegExp(ID_IN_TEXT_RE.source, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
        const id = m[1];
        if (Object.prototype.hasOwnProperty.call(sentSources, id)) {
            matches.push({ value: id, source: sentSources[id] });
        }
    }
    return matches;
}

/**
 * Build the sent-value source map for a run: CSV row values -> "CSV column X",
 * plus (optionally) lineage variables and recorded request literals.
 */
function buildSentSources({ csvHeader = [], csvRow = [], lineage = [], extraLiterals = {} } = {}) {
    const map = {};
    csvHeader.forEach((col, i) => {
        const v = String(csvRow[i] == null ? '' : csvRow[i]).trim();
        if (v.length >= 4) map[v] = `CSV column "${col}"`;
    });
    for (const l of lineage || []) {
        if (l && l.value) map[String(l.value)] = `live-lineage variable \${${l.name}} (recorded value)`;
    }
    for (const [v, src] of Object.entries(extraLiterals || {})) {
        if (String(v).length >= 4 && !map[v]) map[v] = src;
    }
    return map;
}

function loginMarkers(body) {
    const text = String(body || '');
    const hits = [];
    if (PASSWORD_INPUT_RE.test(text)) hits.push('a password input');
    if (LOGIN_TITLE_RE.test(text)) hits.push(`the page title "${(text.match(/<title>([^<]*)<\/title>/i) || [])[1] || ''}"`.slice(0, 60));
    if (LOGIN_FORM_RE.test(text)) hits.push('a form posting to a login/authenticate action');
    return hits;
}

/**
 * THE AUTH WALL — the failure mode that makes a green run a lie.
 *
 * When a session isn't established, most apps don't answer 401: they answer
 * 200 and hand back the LOGIN PAGE. JMeter records rc=200, s=true, and the
 * whole flow "passes" while never touching the application. This is the single
 * most dangerous false pass in load testing, and no status-code check can see
 * it — only the body can.
 *
 * The verdict is evidence-based, so it needs no app knowledge and can't fire on
 * a genuine login page: the LIVE body shows login markers that the RECORDED
 * body for the SAME request did not. The recording proves what this endpoint
 * looks like when authenticated; anything else is the wall.
 */
function detectAuthWall({ label = '', observedBody = '', recordedBody = '' } = {}) {
    const live = loginMarkers(observedBody);
    if (!live.length) return null;
    const recorded = loginMarkers(recordedBody);
    // The recorded response for this very request already looked like a login
    // page (this IS the login screen) — not a wall, just the flow.
    const newMarkers = live.filter(m => !recorded.includes(m));
    if (!newMarkers.length) return null;
    if (!String(recordedBody || '').trim()) return null; // no baseline => no claim
    return {
        label,
        category: 'auth_wall',
        evidence: `live response shows ${newMarkers.join(' and ')}; the recorded response for this request did not`,
        recordedTitle: (String(recordedBody).match(/<title>([^<]*)<\/title>/i) || [])[1] || '',
        observedTitle: (String(observedBody).match(/<title>([^<]*)<\/title>/i) || [])[1] || '',
        ask: `The server returned the LOGIN page for "${label}" with an HTTP 200, so JMeter counted it as a pass. The session is not established — every "passing" sampler after login is measuring the login page, not the application. Fix the authentication handshake before trusting any number from this run.`,
    };
}

/**
 * Scan aligned evidence rows for the auth wall. Returns the affected rows plus
 * the earliest one — the place to actually fix.
 */
function findAuthWall(rows = []) {
    const walls = [];
    for (const r of rows || []) {
        if (!r || r.isTransaction) continue;
        const hit = detectAuthWall({ label: r.label, observedBody: r.observedBody, recordedBody: r.recordedBody });
        if (hit) walls.push({ ...hit, entryIndex: r.entryIndex, observedStatus: r.observedStatus, passed: r.success !== false });
    }
    return {
        walls,
        earliest: walls.length ? walls.slice().sort((a, b) => (a.entryIndex || 0) - (b.entryIndex || 0))[0] : null,
        falsePasses: walls.filter(w => w.passed).length,
    };
}

/**
 * Triage one failing sample: reasons + classification + named data sources.
 */
function triageFailure({ label = '', responseBody = '', sentSources = {} } = {}) {
    const reasons = serverReasons(responseBody);
    const category = classify(reasons);
    const dataMatches = crossReference({ reasons, sentSources });
    const finalCategory = dataMatches.length ? 'stale_data' : category;
    return {
        label,
        category: finalCategory,
        reasons,
        dataMatches,
        summary: reasons.length
            ? `server says: "${reasons[0].slice(0, 140)}"${dataMatches.length ? ` — ${dataMatches.map(d => `${d.value} came from ${d.source}`).join('; ')}` : ''}`
            : '',
        ask: finalCategory === 'stale_data'
            ? (dataMatches.length
                ? `The server rejects data the script sent: ${dataMatches.map(d => `${d.value} (${d.source})`).join(', ')}. Refresh that data (re-record, or enable live lineage for it) — this is stale test data, not a correlation bug.`
                : 'The server reports the referenced record no longer exists — refresh the recording or the data pool.')
            : '',
    };
}

module.exports = {
    triageFailure, serverReasons, buildSentSources, detectAuthWall, findAuthWall,
    _internal: { classify, crossReference, loginMarkers },
};
