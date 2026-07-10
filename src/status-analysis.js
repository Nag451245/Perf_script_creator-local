'use strict';

const peNaming = require('./pe-naming');

function statusFamily(code) {
    const n = Number(code);
    if (!Number.isFinite(n) || n <= 0) return 'unknown';
    return `${Math.floor(n / 100)}xx`;
}

function statusRelevance(code) {
    const n = Number(code);
    if (!Number.isFinite(n) || n <= 0) return 'unknown_status';
    if (n === 200) return 'synchronous_success';
    if (n === 201) return 'created_success';
    if (n === 202) return 'accepted_async_success';
    if (n >= 200 && n < 300) return 'success';
    if (n >= 300 && n < 400) return 'redirect_or_not_modified_flow';
    if (n === 400) return 'bad_request_payload_or_query';
    if (n === 401) return 'authentication_required_or_session_missing';
    if (n === 403) return 'authorization_or_csrf_failed';
    if (n === 404) return 'not_found_or_wrong_url';
    if (n === 409) return 'state_conflict';
    if (n === 422) return 'validation_or_payload_failed';
    if (n >= 400 && n < 500) return 'client_error';
    if (n >= 500 && n < 600) return 'server_error';
    return 'unknown_status';
}

// Success statuses that are semantically interchangeable for most flows: a
// create that recorded 200 but replays 201 (or 202 async) is not a real
// regression. Strict recording-first matching is the DEFAULT (senior-PE
// principle); opts.lenientSuccessDrift lets an operator fold this benign drift.
const SUCCESS_FAMILY = new Set([200, 201, 202, 203, 204, 205, 206]);

function classifyStatusTransition(recordedCode, observedCode, opts = {}) {
    const recorded = Number(recordedCode || 0);
    const observed = Number(observedCode || 0);
    const recordedFamily = statusFamily(recorded);
    const observedFamily = statusFamily(observed);
    const matchesRecording = !!recorded && !!observed && recorded === observed;
    if (matchesRecording) {
        return {
            recorded,
            observed,
            recordedFamily,
            observedFamily,
            matchesRecording: true,
            category: 'status_matches_recording',
            relevance: statusRelevance(recorded),
            repairHint: 'No status repair needed; compare body/headers if later samplers drift.',
        };
    }

    // Recorded 3xx replaying as 2xx is not divergence: the recording stored
    // the RAW redirect hop; JMeter (follow_redirects) reports the landing.
    if (recordedFamily === '3xx' && observedFamily === '2xx') {
        return {
            recorded,
            observed,
            recordedFamily,
            observedFamily,
            matchesRecording: false,
            folded: true,
            category: 'redirect_folded_by_replay',
            relevance: 'informational',
            repairHint: 'JMeter followed the recorded redirect; the 2xx landing is the expected replay shape — nothing to repair.',
        };
    }

    // Benign success drift (200<->201<->202<->204) folds ONLY when the operator
    // opts into lenient matching; strict recording-first remains the default.
    if (opts.lenientSuccessDrift && SUCCESS_FAMILY.has(recorded) && SUCCESS_FAMILY.has(observed)) {
        return {
            recorded,
            observed,
            recordedFamily,
            observedFamily,
            matchesRecording: false,
            folded: true,
            category: 'success_code_drift_tolerated',
            relevance: 'informational',
            repairHint: `Recording expected ${recorded}, replay observed ${observed}; both are success statuses and run.strictStatusMatch is off, so this is treated as acceptable (e.g. async/create returning 201/202).`,
        };
    }

    let category = 'status_drift';
    let repairHint = `Recording expected ${recorded || 'unknown'} but replay observed ${observed || 'unknown'}. Compare this sampler with the recording before judging downstream failures.`;
    if (recordedFamily === '2xx' && observedFamily === '2xx') {
        category = 'success_code_drift';
        repairHint = `The request still returned ${observed}, but the recording expected ${recorded}; verify async/create semantics and body shape before treating it as green.`;
    } else if (recordedFamily === '3xx' || observedFamily === '3xx') {
        category = 'redirect_flow_drift';
        repairHint = `Redirect behavior changed: recording expected ${recorded}, replay observed ${observed}. Check Location/state/cookie propagation around this redirect.`;
    } else if ((observed === 401 || observed === 403) && recordedFamily !== '4xx') {
        category = 'auth_or_session_correlation_failed';
        repairHint = `Replay reached ${observed} where recording expected ${recorded}; inspect prior auth/session producers, cookies, CSRF, and Authorization headers.`;
    } else if ((observed === 400 || observed === 422) && recordedFamily !== '4xx') {
        category = 'request_payload_or_header_failed';
        repairHint = `Replay reached ${observed} where recording expected ${recorded}; compare request body, query parameters, and headers against the recording.`;
    } else if (observedFamily === '4xx' && recordedFamily !== '4xx') {
        category = 'client_error_after_replay_request';
        repairHint = `Replay reached client error ${observed} where recording expected ${recorded}; check URL, auth, payload, and dynamic IDs.`;
    } else if (observedFamily === '5xx' && recordedFamily !== '5xx') {
        category = 'server_error_after_replay_request';
        repairHint = `Replay reached server error ${observed} where recording expected ${recorded}; verify the request did not send stale or invalid correlated data before blaming the server.`;
    } else if (recordedFamily === '4xx' || recordedFamily === '5xx') {
        category = 'expected_error_status_changed';
        repairHint = `The recording expected an error status ${recorded}, but replay observed ${observed}; this may be acceptable only if the recorded error was intentional.`;
    }

    return {
        recorded,
        observed,
        recordedFamily,
        observedFamily,
        matchesRecording: false,
        category,
        relevance: statusRelevance(observed),
        repairHint,
    };
}

function classifySampleReplay(entry = {}, sample = {}, opts = {}) {
    const recorded = Number(entry && entry.response && entry.response.status || 0);
    const observed = Number(sample && (sample.responseCode || sample.code || sample.status) || 0);
    if (!recorded || !observed) return null;
    const authBounce = classifyAuthBounce(entry, sample, recorded, observed);
    const loginBodyBounce = classifyLoginBodyBounce(entry, sample, recorded, observed);
    return authBounce || loginBodyBounce || classifyStatusTransition(recorded, observed, opts);
}

function classifyAuthBounce(entry, sample, recorded, observed) {
    const finalUrl = String(sample.finalUrl || sample.url || '').trim();
    if (!finalUrl) return null;
    const recordedUrl = String(entry && entry.request && entry.request.url || '').trim();
    const recordedParsed = parseUrl(recordedUrl);
    const observedParsed = parseUrl(finalUrl);
    if (!recordedParsed || !observedParsed) return null;
    if (recordedParsed.host === observedParsed.host) return null;
    if (!isAuthLikeHost(observedParsed.host)) return null;
    if (isAuthLikeHost(recordedParsed.host)) return null;

    return {
        recorded,
        observed,
        recordedFamily: statusFamily(recorded),
        observedFamily: statusFamily(observed),
        matchesRecording: false,
        category: 'auth_redirect_bounce',
        relevance: 'authentication_required_or_session_missing',
        observedFinalUrl: finalUrl,
        recordedUrl,
        repairHint: `Replay returned ${observed} but landed on auth host ${observedParsed.host} instead of the recorded app host ${recordedParsed.host}; repair auth/session cookies or redirect state before downstream samplers.`,
    };
}

function parseUrl(value) {
    try {
        const url = new URL(value);
        return { host: url.host.toLowerCase(), pathname: url.pathname || '/' };
    } catch {
        return null;
    }
}

function isAuthLikeHost(host) {
    return /auth|login|logon|sso|idp|okta|ping|iam|keycloak|adfs|cognito|auth0|identity|account|oauth|oidc|saml|realms|microsoftonline|accounts\.google|onelogin|forgerock|duosecurity|salesforce|my\.salesforce|frontdoor/i.test(String(host || ''));
}

function classifyLoginBodyBounce(entry, sample, recorded, observed) {
    if (recorded < 200 || recorded >= 300 || observed < 200 || observed >= 300) return null;
    const recordedBody = bodyOf(entry && entry.response && entry.response.content && entry.response.content.text);
    const observedBody = bodyOf(sample && (sample.responseBody || sample.body));
    if (!observedBody || !isLoginLikeBody(observedBody)) return null;
    if (isLoginLikeBody(recordedBody)) return null;
    return {
        recorded,
        observed,
        recordedFamily: statusFamily(recorded),
        observedFamily: statusFamily(observed),
        matchesRecording: false,
        category: 'auth_login_body_bounce',
        relevance: 'authentication_required_or_session_missing',
        observedFinalUrl: sample.finalUrl || sample.url || '',
        recordedUrl: entry && entry.request && entry.request.url || '',
        repairHint: `Replay returned ${observed} with a login/auth page body while the recording had application content; repair auth/session correlation before treating downstream samplers as root cause.`,
    };
}

function isLoginLikeBody(body) {
    const text = String(body || '').toLowerCase();
    if (!text) return false;
    return /<form\b[^>]*(login|password|username|email)?/.test(text) ||
        /\b(sign in|log in|login|password|username|sso|single sign-on|authenticate)\b/.test(text);
}

function bodyOf(value) {
    return String(value || '');
}

function traceStatusRootCause({ entries = [], samples = [], evidence = null, failingIndex = null, strictStatusMatch = true } = {}) {
    const pairs = evidence && Array.isArray(evidence.rows)
        ? pairsFromEvidence(evidence)
        : alignEntrySamplePairs(entries, normalizeSamples(samples));
    const explicitFailIndex = failingIndex == null
        ? null
        : (Number.isFinite(Number(failingIndex)) ? Number(failingIndex) : null);
    const replayOpts = { lenientSuccessDrift: strictStatusMatch === false };

    const divergences = [];
    for (const { entry, sample, entryIndex } of pairs) {
        if (explicitFailIndex != null && entryIndex > explicitFailIndex) continue;
        const recorded = Number(entry && entry.response && entry.response.status || 0);
        const observed = Number(sample && (sample.responseCode || sample.code || sample.status) || 0);
        if (!recorded || !observed) continue;
        const transition = classifySampleReplay(entry, sample, replayOpts);
        if (!transition) continue;
        if (!transition.matchesRecording && !transition.folded) {
            divergences.push({
                index: entryIndex,
                sampler: sample.label || sample.name || samplerLabel(entry, entryIndex),
                ...transition,
            });
        }
    }
    if (!divergences.length) return null;
    const rootCause = divergences[0];
    const failIndex = explicitFailIndex != null
        ? explicitFailIndex
        : firstFailedEntryIndex(pairs) ?? rootCause.index;
    const failing = divergences.find(d => d.index === failIndex) || divergences.find(d => d.index >= failIndex) || rootCause;
    const upstream = rootCause.index < failIndex;
    return {
        rootCauseIndex: rootCause.index,
        failingIndex: failIndex,
        rootCause,
        failing,
        upstream,
        divergences,
        summary: upstream
            ? `earliest upstream divergence at ${rootCause.sampler}: recorded ${rootCause.recorded}, observed ${rootCause.observed}; fix this before chasing downstream ${failing.observed}.`
            : `failing sampler diverged from recording at ${rootCause.sampler}: recorded ${rootCause.recorded}, observed ${rootCause.observed}.`,
    };
}

function normalizeSamples(samples) {
    return (samples || []).filter(s => !s.isTransaction);
}

function firstFailedEntryIndex(pairs) {
    const pair = pairs.find(({ sample }) => sample && (sample.success === false || isBadStatus(sample)));
    return pair ? pair.entryIndex : null;
}

function firstStatusDivergenceIndex(entries, samples) {
    for (const { entry, sample, entryIndex } of alignEntrySamplePairs(entries, normalizeSamples(samples))) {
        const recorded = Number(entry && entry.response && entry.response.status || 0);
        const observed = Number(sample && (sample.responseCode || sample.code || sample.status) || 0);
        if (!recorded || !observed) continue;
        const transition = classifySampleReplay(entry, sample);
        if (!transition || transition.matchesRecording || transition.folded) continue; // redirect folding, not divergence
        return entryIndex;
    }
    return -1;
}

function pairsFromEvidence(evidence) {
    return (evidence.rows || [])
        .filter(row => !row.isTransaction)
        .map(row => ({
            entry: row.entry || {},
            sample: {
                ...(row.sample || {}),
                label: row.label,
                code: row.observedStatus,
                responseCode: row.observedStatus,
                status: row.observedStatus,
                success: row.success,
                body: row.observedBody,
                responseBody: row.observedBody,
                finalUrl: row.finalUrl,
                urls: row.subUrls,
            },
            entryIndex: row.entryIndex,
            sampleIndex: row.sampleIndex,
        }));
}

function isBadStatus(sample) {
    const code = Number(sample.responseCode || sample.code || sample.status || 0);
    return code >= 400;
}

function sampleByLabel(samples, label) {
    return samples.find(s => String(s.label || s.name || '').trim() === label);
}

function samplerLabel(entry, index) {
    const method = String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
    let path = '/';
    try { path = new URL(entry.request && entry.request.url || '').pathname || '/'; }
    catch { path = String(entry && entry.request && entry.request.url || '/').split('?')[0] || '/'; }
    return `Step ${String(index + 1).padStart(2, '0')} - ${method} ${path}`;
}

function alignEntrySamplePairs(entries, samples) {
    const pairs = [];
    const usedSampleIndexes = new Set();
    const usedEntryIndexes = new Set();

    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        const sample = samples[sampleIndex] || {};
        const stepNumber = stepNumberFromLabel(sample.label || sample.name);
        if (!stepNumber) continue;
        const entryIndex = stepNumber - 1;
        if (entryIndex < 0 || entryIndex >= entries.length || usedEntryIndexes.has(entryIndex)) continue;
        pairs.push({ entry: entries[entryIndex] || {}, sample, entryIndex, sampleIndex });
        usedEntryIndexes.add(entryIndex);
        usedSampleIndexes.add(sampleIndex);
    }

    let fallbackEntryIndex = 0;
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        if (usedSampleIndexes.has(sampleIndex)) continue;
        while (fallbackEntryIndex < entries.length && usedEntryIndexes.has(fallbackEntryIndex)) fallbackEntryIndex++;
        if (fallbackEntryIndex >= entries.length) break;
        pairs.push({
            entry: entries[fallbackEntryIndex] || {},
            sample: samples[sampleIndex] || {},
            entryIndex: fallbackEntryIndex,
            sampleIndex,
        });
        usedEntryIndexes.add(fallbackEntryIndex);
        fallbackEntryIndex++;
    }

    return pairs.sort((a, b) => a.entryIndex - b.entryIndex || a.sampleIndex - b.sampleIndex);
}

function stepNumberFromLabel(label) {
    return peNaming.stepNumberFromLabel(label);
}

module.exports = {
    statusFamily,
    statusRelevance,
    classifyStatusTransition,
    classifySampleReplay,
    traceStatusRootCause,
    _internal: { firstStatusDivergenceIndex, alignEntrySamplePairs, pairsFromEvidence, isLoginLikeBody },
};
