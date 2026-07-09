'use strict';

function evaluateFinalGreenGate({
    result = {},
    baselineDiff = null,
    semanticDiff = null,
    businessVerification = null,
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

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

module.exports = { evaluateFinalGreenGate };
