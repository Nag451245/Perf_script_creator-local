'use strict';

function evaluateFinalGreenGate({
    result = {},
    baselineDiff = null,
    semanticDiff = null,
    businessVerification = null,
} = {}) {
    const failures = [];

    if (result.success === false) {
        failures.push({
            category: result.recordingDriftFailure ? 'recording_drift_failure' : 'jmeter_failure',
            reason: result.failureMessage || result.error || 'JMeter run did not pass all request samples.',
        });
    }

    if (baselineDiff && Array.isArray(baselineDiff.drift) && baselineDiff.drift.length > 0) {
        failures.push({
            category: 'baseline_drift',
            reason: `${baselineDiff.drift.length} sampler(s) differed from the recording.`,
            details: baselineDiff.drift,
        });
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
        reason: failures.length ? failures.map(f => f.reason).join(' | ') : 'All green gates passed.',
    };
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

module.exports = { evaluateFinalGreenGate };
