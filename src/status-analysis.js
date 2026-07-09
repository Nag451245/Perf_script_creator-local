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
    const pairs = alignEntrySamplePairs(entries, normalized);
    const explicitFailIndex = failingIndex == null
        ? null
        : (Number.isFinite(Number(failingIndex)) ? Number(failingIndex) : null);

    const divergences = [];
    for (const { entry, sample, entryIndex } of pairs) {
        if (explicitFailIndex != null && entryIndex > explicitFailIndex) continue;
        const recorded = Number(entry && entry.response && entry.response.status || 0);
        const observed = Number(sample && (sample.responseCode || sample.code || sample.status) || 0);
        if (!recorded || !observed) continue;
        const transition = classifyStatusTransition(recorded, observed);
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
        if (!recorded || !observed || recorded === observed) continue;
        if (classifyStatusTransition(recorded, observed).folded) continue; // redirect folding, not divergence
        return entryIndex;
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
    const match = /^Step\s+0*(\d+)\b/i.exec(String(label || '').trim());
    return match ? Number(match[1]) : 0;
}

module.exports = {
    statusFamily,
    statusRelevance,
    classifyStatusTransition,
    traceStatusRootCause,
    _internal: { firstStatusDivergenceIndex, alignEntrySamplePairs },
};
