'use strict';

const { _internal: { samplerLabel } } = require('./value-flow-decisions');

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

function classifyStatusTransition(recordedCode, observedCode) {
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

function traceStatusRootCause({ entries = [], samples = [], failingIndex = null } = {}) {
    const normalized = normalizeSamples(samples);
    let failIndex = Number.isFinite(Number(failingIndex))
        ? Number(failingIndex)
        : firstFailedIndex(normalized);
    if (failIndex < 0) failIndex = firstStatusDivergenceIndex(entries, normalized);
    if (failIndex < 0) return null;

    const divergences = [];
    for (let i = 0; i <= Math.min(failIndex, entries.length - 1); i++) {
        const entry = entries[i];
        const sample = normalized[i] || sampleByLabel(normalized, samplerLabel(entry, i));
        const recorded = Number(entry && entry.response && entry.response.status || 0);
        const observed = Number(sample && (sample.responseCode || sample.code || sample.status) || 0);
        if (!recorded || !observed) continue;
        const transition = classifyStatusTransition(recorded, observed);
        if (!transition.matchesRecording && !transition.folded) {
            divergences.push({
                index: i,
                sampler: samplerLabel(entry, i),
                ...transition,
            });
        }
    }
    if (!divergences.length) return null;
    const rootCause = divergences[0];
    const failing = divergences.find(d => d.index === failIndex) || rootCause;
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

function firstFailedIndex(samples) {
    const idx = samples.findIndex(s => s && (s.success === false || isBadStatus(s)));
    return idx;
}

function firstStatusDivergenceIndex(entries, samples) {
    const compareLen = Math.min((entries || []).length, (samples || []).length);
    for (let i = 0; i < compareLen; i++) {
        const recorded = Number(entries[i] && entries[i].response && entries[i].response.status || 0);
        const observed = Number(samples[i] && (samples[i].responseCode || samples[i].code || samples[i].status) || 0);
        if (!recorded || !observed || recorded === observed) continue;
        if (classifyStatusTransition(recorded, observed).folded) continue; // redirect folding, not divergence
        return i;
    }
    return -1;
}

function isBadStatus(sample) {
    const code = Number(sample.responseCode || sample.code || sample.status || 0);
    return code >= 400;
}

function sampleByLabel(samples, label) {
    return samples.find(s => String(s.label || s.name || '').trim() === label);
}

module.exports = {
    statusFamily,
    statusRelevance,
    classifyStatusTransition,
    traceStatusRootCause,
    _internal: { firstStatusDivergenceIndex },
};
