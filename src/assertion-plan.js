'use strict';
/**
 * assertion-plan.js — OPT-IN Response Assertions for the shipped JMX.
 *
 * OFF BY DEFAULT, and it earned that. The first version ran automatically and
 * put the SAME six failure phrases under every business step — 25 identical
 * "Assert no failure text" nodes in one plan. As feedback from the operator who
 * had to open it: "the whole JMX contains same assertions and they are
 * useless." That was right on both counts:
 *
 *   - No information. An assertion that is identical on every step cannot tell
 *     you which step broke, and "Invalid login" under step 20 of a search flow
 *     is decoration, not verification.
 *   - Real cost. 25 steps x 6 substring patterns is ~175 extra scans of
 *     multi-hundred-KB response bodies per iteration, paid on every thread of
 *     every load run.
 *
 * A performance engineer writes a handful of assertions, not a hundred. So when
 * this IS turned on (run.assertions.enabled = true):
 *
 *   1. Content only where two recordings PROVE the marker is stable, the login
 *      page does not also carry it (or it cannot catch an auth wall), and it is
 *      not a per-run value. One recording proves nothing, so it asserts nothing.
 *   2. Failure-text checks ONLY on the step that submits credentials, where
 *      "Invalid login" actually means the step failed.
 *   3. Never on a static asset, a telemetry host, an auto-submit bridge page, or
 *      a recorded 3xx (which replays as a followed redirect, so the body JMeter
 *      sees is the destination's).
 *   4. Capped at 8 steps by default. If it needs more than that, the check
 *      belongs in the agent's gates, not stamped across the plan.
 *
 * JMETER DETAIL THAT MATTERS. `Assertion.test_type` 2 is "Contains", and
 * Contains treats the pattern as a REGULAR EXPRESSION. Any real page text with
 * `(`, `?`, `.` or `$` in it then matches something other than what the
 * engineer typed — occasionally everything. 16 is "Substring", a literal
 * compare, and that is what these assertions use. Negative is 16|4 = 20.
 */

const invariantsModule = require('./invariants');

// JMeter ResponseAssertion test_type bit flags.
const SUBSTRING = 16;
const NOT = 4;

const DEFAULT_MAX_SAMPLERS = 8;
const MAX_POSITIVE_PER_SAMPLER = 3;
const MAX_NEGATIVE_PER_SAMPLER = 6;

/**
 * Failure text that must never appear in a healthy response. Deliberately
 * literal and specific: "error" alone is in half the JavaScript on the web, so
 * asserting on it produces noise, not signal. Each of these means the step
 * actually failed.
 *
 * Every one is still checked against the recording before use — if a step's
 * recorded body legitimately contains the phrase, it is dropped for that step.
 */
const ERROR_MARKER_GROUPS = {
    // Authentication and session — the failures that hide behind a 200.
    auth: [
        'Invalid login', 'Invalid username or password', 'Login failed',
        'Authentication failed', 'Access Denied', 'You are not authorized',
    ],
    session: ['Session expired', 'session has expired', 'Your session has timed out'],
    // Server-side blow-ups that still render as a 200 error page.
    server: [
        'Internal Server Error', 'An unexpected error occurred',
        'Something went wrong', 'Service Unavailable',
    ],
    // If one of these reaches the response body, the step failed whatever the
    // status line says.
    stackTrace: [
        'java.lang.NullPointerException', 'Traceback (most recent call last)',
        'Object reference not set', 'System.NullReferenceException',
        'Fatal error:', 'Whitelabel Error Page', 'SQLSTATE',
    ],
};
const ERROR_MARKERS = Object.values(ERROR_MARKER_GROUPS).flat();

const DOCUMENT_MIME_RE = /(?:text\/html|application\/json|application\/.*\+json|text\/xml|application\/xml|application\/soap|text\/plain)/i;
const STATIC_ASSET_RE = /\.(?:css|js|mjs|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map|webp|avif|mp4|pdf)(?:$|\?)/i;
const NOISE_PATH_RE = /\/(?:favicon\.ico|robots\.txt|beacon|collect|analytics|telemetry|domainreliability|ohttp_gateway|__webpack)/i;
const THIRD_PARTY_RE = /gstatic|googleapis|google-analytics|googletagmanager|doubleclick|dynatrace|newrelic|pendo|launchdarkly|sentry|ruxit|gravatar|hotjar|segment|fullstory/i;
const PASSWORD_INPUT_RE = /<input[^>]+type\s*=\s*["']?password["']?/i;
const TITLE_RE = /<title>\s*([^<]{3,120}?)\s*<\/title>/i;
// A page whose entire job is to auto-POST a hidden form onward. With redirects
// followed, the replay lands PAST it, so anything asserted here fails on a
// correct run.
const AUTO_SUBMIT_RE = /<form[^>]*>[\s\S]{0,4000}?<input[^>]+type\s*=\s*["']?hidden[\s\S]{0,4000}?<\/form>[\s\S]{0,2000}?(?:\.submit\(\)|onload\s*=\s*["'][^"']*submit)/i;

function bodyOf(entry) {
    return String((entry && entry.response && entry.response.content && entry.response.content.text) || '');
}
function mimeOf(entry) {
    return String((entry && entry.response && entry.response.content && entry.response.content.mimeType) || '');
}
function statusOf(entry) {
    return Number((entry && entry.response && entry.response.status) || 0);
}
function urlOf(entry) {
    return String((entry && entry.request && entry.request.url) || '');
}
function pathOf(entry) {
    try { return new URL(urlOf(entry)).pathname; } catch { return urlOf(entry).split('?')[0]; }
}
function hostOf(entry) {
    try { return new URL(urlOf(entry)).hostname; } catch { return ''; }
}

/**
 * Is this a step worth asserting on at all? The first cut a human makes, and
 * the one that keeps the script readable: assertions belong on the pages and
 * API calls that carry the business, not on 400 supporting requests.
 */
function isAssertable(entry) {
    if (!entry || !entry.response) return { ok: false, why: 'no recorded response' };
    const status = statusOf(entry);
    // A recorded 3xx replays as a FOLLOWED redirect, so the response JMeter
    // asserts against is the destination, not this hop. Asserting the hop's
    // recorded body is the classic false red.
    if (status < 200 || status >= 300) return { ok: false, why: `recorded status ${status || 'none'} — only 2xx responses are asserted` };
    const mime = mimeOf(entry);
    if (!DOCUMENT_MIME_RE.test(mime)) return { ok: false, why: `content type ${mime || 'unknown'} is not a document` };
    const path = pathOf(entry);
    if (STATIC_ASSET_RE.test(path)) return { ok: false, why: 'static asset' };
    if (NOISE_PATH_RE.test(path)) return { ok: false, why: 'telemetry/noise path' };
    if (THIRD_PARTY_RE.test(hostOf(entry))) return { ok: false, why: 'third-party host' };
    const body = bodyOf(entry);
    if (body.length < 16) return { ok: false, why: 'response body too small to prove anything' };
    if (AUTO_SUBMIT_RE.test(body)) return { ok: false, why: 'auto-submit bridge page — the replay lands past it' };
    return { ok: true };
}

/**
 * Is this the request that submits credentials? That is the one step where
 * "Invalid login" is a real check rather than decoration.
 */
function isCredentialSubmit(entry) {
    const method = String((entry && entry.request && entry.request.method) || '').toUpperCase();
    if (method !== 'POST') return false;
    const post = (entry.request && entry.request.postData) || {};
    const sent = `${post.text || ''} ${((post.params || []).map(p => p.name).join(' '))}`;
    if (/(^|[&"'{,_-])(password|passwd|pwd|passcode|credential)/i.test(sent)) return true;
    return /\/(?:login|signin|sign-in|authenticate|authentication|session)s?(?:\.|\/|\?|$)/i.test(pathOf(entry));
}

/** Bodies in this recording that ARE the login page. */
function loginBodies(entries = []) {
    return entries.map(bodyOf).filter(b => b && PASSWORD_INPUT_RE.test(b));
}

/**
 * Turn an invariants marker into text a human would actually type into a
 * Response Assertion.
 *   json-key:accountId -> "accountId"   (the quoted key: structural, stable)
 *   title:Patient Chart -> Patient Chart
 */
function markerToText(marker) {
    if (marker.startsWith('json-key:')) return `"${marker.slice(9)}"`;
    if (marker.startsWith('title:')) return marker.slice(6);
    return '';
}

/**
 * Would this text also match the login page? Then it proves nothing: the whole
 * point of the assertion is to fail when the app hands back a login screen with
 * a 200, and a marker the login page also carries cannot do that.
 */
function survivesLoginPage(text, logins) {
    return !logins.some(b => b.includes(text));
}

function isVolatile(text, excluded) {
    const t = String(text);
    if (t.length < 3 || t.length > 120) return true;
    if (!/[A-Za-z]/.test(t)) return true;                 // pure digits/punctuation
    if (/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(t)) return true;  // dates, times
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t)) return true; // uuid
    if (/\b\d{6,}\b/.test(t)) return true;                // record ids
    if (/@[\w.-]+\.\w{2,}/.test(t)) return true;          // emails
    // Anything the run already treats as per-user: correlated values, CSV data.
    return excluded.some(v => v && String(v).length >= 3 && t.includes(String(v)));
}

/**
 * Which error markers can be asserted as "must NOT appear" for this step?
 * Only the ones the recording proves are absent when the step works. A step
 * whose healthy body legitimately says "Service Unavailable" (a status widget,
 * say) must not be gated on it.
 */
function usableErrorMarkers(recordedBodies, extra = []) {
    const lowered = recordedBodies.map(b => b.toLowerCase());
    const usable = (m) => lowered.every(b => !b.includes(String(m).toLowerCase()));

    // Spread the budget ACROSS categories rather than taking the first N off
    // one list. Six ways to say "bad password" and no stack-trace check is not
    // what a human writes — one probe per failure mode is.
    const picked = [];
    const groups = [
        ...extra.map(String).filter(Boolean).map(m => [m]),   // operator's own first
        ...Object.values(ERROR_MARKER_GROUPS),
    ];
    for (let round = 0; picked.length < MAX_NEGATIVE_PER_SAMPLER; round++) {
        let addedThisRound = false;
        for (const group of groups) {
            if (picked.length >= MAX_NEGATIVE_PER_SAMPLER) break;
            const next = group.filter(usable)[round];
            if (!next || picked.includes(next)) continue;
            picked.push(next);
            addedThisRound = true;
        }
        if (!addedThisRound) break;
    }
    return picked;
}

/**
 * Plan the assertions for a flow.
 *
 * @param {object[]} entries           primary recording, index-aligned with samplers
 * @param {object[]} secondaryEntries  second recording (what makes markers provable)
 * @param {string[]} excludedValues    correlation + CSV values: never assertable
 * @param {Set<string>|null} businessLabels sampler names the guard protects
 * @param {object} cfg                 run.assertions
 */
function planAssertions({
    entries = [],
    secondaryEntries = [],
    samplerNames = [],
    excludedValues = [],
    businessLabels = null,
    cfg = {},
} = {}) {
    const notes = [];
    // On by default again, but ONLY in the narrow form below. The first version
    // ran automatically and put the same six failure phrases under all 25
    // business steps — identical assertions that told a reviewer nothing and
    // cost ~175 substring scans of large bodies per iteration. It was switched
    // off wholesale, which left the plan with no verification at all. Neither
    // extreme is right: a handful of assertions that each mean something is.
    if (cfg.enabled === false) {
        return { assertions: [], notes: [], dualRecording: false, disabled: true };
    }

    const maxSamplers = Number.isFinite(Number(cfg.maxSamplers)) ? Math.max(1, Number(cfg.maxSamplers)) : DEFAULT_MAX_SAMPLERS;
    const dualRecording = Array.isArray(secondaryEntries) && secondaryEntries.length > 0;
    const invariants = dualRecording
        ? invariantsModule.mineInvariants({ primary: entries, secondary: secondaryEntries })
        : { byEntryIndex: {}, steps: 0 };
    const paired = dualRecording
        ? invariantsModule._internal.alignSecondary(entries, secondaryEntries)
        : entries.map(() => null);

    const logins = loginBodies(entries);
    const loginTitle = logins.length ? (logins[0].match(TITLE_RE) || [])[1] || '' : '';

    // Assertions are placed by sampler ORDER, so they are only correct while
    // sampler N really is recording entry N. If the two ever drift, an
    // assertion lands on the wrong request and fails a healthy step — worse
    // than having no assertion. Stop at the shortest common prefix.
    const alignedCount = samplerNames.length
        ? Math.min(entries.length, samplerNames.length)
        : entries.length;
    if (samplerNames.length && samplerNames.length !== entries.length) {
        notes.push(`sampler/recording alignment is partial (${samplerNames.length} samplers vs ${entries.length} recorded entries) — only the first ${alignedCount} step(s) were considered, so no assertion can land on the wrong request.`);
    }

    const candidates = [];
    for (let i = 0; i < alignedCount; i++) {
        const entry = entries[i];
        const eligible = isAssertable(entry);
        if (!eligible.ok) continue;

        const label = samplerNames[i] || pathOf(entry);
        const body = bodyOf(entry);
        const twinBody = paired[i] ? bodyOf(paired[i]) : '';
        // The login page itself SHOULD look like the login page. Asserting
        // "not the login page" there would fail every run.
        const isLoginPage = PASSWORD_INPUT_RE.test(body);

        // ── positive: what proves this step did its job ──────────────────
        const positive = [];
        const inv = invariants.byEntryIndex[i];
        if (inv) {
            for (const marker of inv.markers) {
                const text = markerToText(marker);
                if (!text || isVolatile(text, excludedValues)) continue;
                if (!survivesLoginPage(text, logins)) continue;
                // Belt and braces: the marker came from agreement, but confirm
                // the literal we are about to ship is in both bodies verbatim.
                if (!body.includes(text)) continue;
                if (twinBody && !twinBody.includes(text)) continue;
                positive.push(text);
                if (positive.length >= MAX_POSITIVE_PER_SAMPLER) break;
            }
        }

        // ── negative: what must never appear ─────────────────────────────
        // ONLY on the step that submits credentials. The first version put the
        // same six phrases under every business step: 25 identical assertions
        // that distinguished nothing, cost a scan of every response body, and
        // were the reason this pass got switched off. "Invalid login" means
        // something on the login POST and nothing at all on step 20.
        const negative = [];
        if (isCredentialSubmit(entry)) {
            const recordedBodies = twinBody ? [body, twinBody] : [body];
            negative.push(...usableErrorMarkers(recordedBodies, cfg.errorMarkers || []));
            // "You did not land back on the login page" — only meaningful right
            // after signing in.
            if (!isLoginPage && loginTitle && !body.includes(loginTitle) &&
                (!twinBody || !twinBody.includes(loginTitle))) {
                negative.unshift(loginTitle);
            }
        }

        if (!positive.length && !negative.length) continue;
        candidates.push({
            samplerIndex: i,
            label,
            path: pathOf(entry),
            positive,
            negative,
            proven: !!inv,
            business: !!(businessLabels && businessLabels.has(label)),
        });
    }

    // Rank the way an engineer prioritises: the steps that carry the business
    // first, then steps whose markers two recordings agree on, then the rest.
    // The cap keeps the script readable — 200 assertions is not diligence.
    candidates.sort((a, b) =>
        (b.business - a.business) || (b.proven - a.proven) ||
        (b.positive.length - a.positive.length) || (a.samplerIndex - b.samplerIndex));
    const assertions = candidates.slice(0, maxSamplers)
        .sort((a, b) => a.samplerIndex - b.samplerIndex);

    const withPositive = assertions.filter(a => a.positive.length).length;
    if (!dualRecording) {
        notes.push('only one recording, so no marker can be PROVEN stable — asserting error markers and the login-page check only. A second recording of the same flow unlocks per-step content assertions.');
    } else if (!withPositive) {
        notes.push('no step offered a marker both recordings agree on that the login page does not also carry — error-marker assertions only.');
    }
    if (candidates.length > assertions.length) {
        notes.push(`${candidates.length - assertions.length} further step(s) were assertable but left alone at the cap of ${maxSamplers} (run.assertions.maxSamplers).`);
    }

    return { assertions, notes, dualRecording, invariantSteps: invariants.steps, considered: candidates.length };
}

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * One ResponseAssertion element. Positive and negative have to be separate
 * elements: the NOT bit is a property of the whole assertion, not of an
 * individual pattern, so mixing them in one would invert the lot.
 */
function assertionElement({ testname, texts, negate, message, idPrefix }) {
    const strings = texts.map((t, i) =>
        `                <stringProp name="${idPrefix}_${i}">${esc(t)}</stringProp>`).join('\n');
    return `
            <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="${esc(testname)}" enabled="true">
              <collectionProp name="Asserion.test_strings">
${strings}
              </collectionProp>
              <stringProp name="Assertion.custom_message">${esc(message)}</stringProp>
              <stringProp name="Assertion.test_field">Assertion.response_data</stringProp>
              <boolProp name="Assertion.assume_success">false</boolProp>
              <intProp name="Assertion.test_type">${negate ? (SUBSTRING | NOT) : SUBSTRING}</intProp>
            </ResponseAssertion>
            <hashTree/>`;
}

/** Write the planned assertions into the JMX. */
function injectAssertions(xml, assertions = []) {
    const { injectAfterSampler } = require('./extractors');
    let out = xml;
    let injected = 0;
    let elements = 0;
    for (const a of assertions) {
        let block = '';
        // Name assertions after the SAMPLER, not the path. A flow with twenty
        // /graphql calls otherwise produces twenty identically-named
        // assertions, and a failure in the JTL cannot be traced to a step.
        const who = a.label || a.path;
        if (a.positive.length) {
            // No OR bit: every marker must hold. They were all proven by both
            // recordings, so any one of them going missing is a real failure.
            block += assertionElement({
                testname: `Assert content: ${who}`,
                texts: a.positive,
                negate: false,
                idPrefix: 'assert_present',
                // A JSON-key marker already carries its own quotes; wrapping it
                // again produced ""success"" in the failure message.
                message: `Step content missing. This response no longer carries ${a.positive.map(t => (t.startsWith('"') ? t : `"${t}"`)).join(' + ')}, which both recordings of this flow returned here. A 200 with the content gone is an auth wall, an error page, or the wrong response — not a passing step.`,
            });
        }
        if (a.negative.length) {
            block += assertionElement({
                testname: `Assert no failure text: ${who}`,
                texts: a.negative,
                negate: true,
                idPrefix: 'assert_absent',
                message: 'Failure text in the response body. The recording never returned this wording here, so the step failed regardless of the status code.',
            });
        }
        if (!block) continue;
        const next = injectAfterSampler(out, a.samplerIndex, block);
        if (next === out) continue;
        out = next;
        injected++;
        elements += (a.positive.length ? 1 : 0) + (a.negative.length ? 1 : 0);
    }
    return { xml: out, injected, elements };
}

module.exports = {
    planAssertions,
    injectAssertions,
    ERROR_MARKERS,
    _internal: { isAssertable, isVolatile, usableErrorMarkers, markerToText, survivesLoginPage, assertionElement, isCredentialSubmit },
};
