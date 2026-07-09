'use strict';

const statusAnalysis = require('./status-analysis');

function evaluateFinalGreenGate({
    result = {},
    baselineDiff = null,
    semanticDiff = null,
    businessVerification = null,
    evidence = null,
} = {}) {
    const failures = [];
    const warnings = [];

    if (result.success === false) {
        failures.push({
            category: result.recordingDriftFailure ? 'recording_drift_failure' : 'jmeter_failure',
            reason: result.failureMessage || result.error || 'JMeter run did not pass all request samples.',
        });
    }

    // Baseline drift on a run where every sampler PASSED is a review flag,
    // not a failure: live dynamic pages legitimately differ in size from a
    // days-old recording, and assertions + the business guard + the outcome
    // probe already vouch for correctness. Blocking here made GREEN
    // unreachable for perfect scripts. Drift stays blocking evidence when
    // the run itself failed.
    if (baselineDiff && Array.isArray(baselineDiff.drift) && baselineDiff.drift.length > 0) {
        const driftFinding = {
            category: 'baseline_drift',
            reason: `${baselineDiff.drift.length} sampler(s) differed from the recording.`,
            details: baselineDiff.drift,
        };
        if (result.success === false) failures.push(driftFinding);
        else warnings.push(driftFinding);
    }

    if (semanticDiff && Array.isArray(semanticDiff.issues) && semanticDiff.issues.length > 0) {
        failures.push({
            category: 'semantic_drift',
            reason: `${semanticDiff.issues.length} semantic response issue(s) detected.`,
            details: semanticDiff.issues,
        });
    }

    if (businessVerification && businessVerification.ok === false) {
        failures.push({
            category: 'business_verification_failed',
            reason: businessVerification.reason || 'Protected business verification failed.',
            details: businessVerification,
        });
    }

    const evidenceGate = evaluateEvidenceGate(evidence);
    if (evidenceGate.failures.length) {
        failures.push({
            category: 'recording_evidence_drift',
            reason: evidenceGate.failures[0].reason,
            details: evidenceGate.failures,
        });
    }
    if (evidenceGate.warnings.length) warnings.push(...evidenceGate.warnings);

    return {
        ok: failures.length === 0,
        categories: unique(failures.map(f => f.category)),
        failures,
        warnings,
        reason: failures.length
            ? failures.map(f => f.reason).join(' | ')
            : (warnings.length
                ? `GREEN with review flags: ${warnings.map(w => w.reason).join(' | ')}`
                : 'All green gates passed.'),
    };
}

function evaluateEvidenceGate(evidence) {
    const failures = [];
    const warnings = [];
    if (!evidence || !Array.isArray(evidence.rows)) return { failures, warnings };
    let bodyComparable = 0;
    for (const row of evidence.rows || []) {
        if (row.isTransaction) continue;
        if (row.recordedBodyLength > 0 && row.observedBodyLength > 0) bodyComparable++;
        const transition = statusAnalysis.classifySampleReplay(row.entry || {}, {
            ...(row.sample || {}),
            label: row.label,
            code: row.observedStatus,
            responseCode: row.observedStatus,
            status: row.observedStatus,
            body: row.observedBody,
            responseBody: row.observedBody,
            finalUrl: row.finalUrl,
        });
        if (!transition || transition.matchesRecording || transition.folded) continue;
        if (/auth|session|login|redirect/i.test(`${transition.category || ''} ${transition.relevance || ''}`)) {
            failures.push({
                index: row.entryIndex,
                sampler: row.label,
                reason: `${row.label} diverged from recording: ${transition.category}`,
                transition,
            });
            break;
        }
    }
    if (!bodyComparable) {
        warnings.push({
            category: 'body_compare_unavailable',
            reason: 'No recorded and observed response bodies were available for recording comparison.',
        });
    }
    return { failures, warnings };
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

module.exports = { evaluateFinalGreenGate, _internal: { evaluateEvidenceGate } };
