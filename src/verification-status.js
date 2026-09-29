'use strict';

// This is intentionally separate from the legacy verdict vocabulary. Verdicts
// remain operator-facing compatibility strings; this answers only whether the
// generated artifact has been proven safe to use.
function deriveVerificationStatus({
    validationAttempted = false,
    finalGreenGate = null,
    businessVerification = null,
    runtimeProof = null,
    correlationEvidence = null,
} = {}) {
    if (!validationAttempted) return 'GENERATED';
    const proofStatus = runtimeProof && runtimeProof.status;
    const proofAccepted = proofStatus === 'VERIFIED' || proofStatus === 'notApplicable';
    if (finalGreenGate && finalGreenGate.ok === true && businessVerification && businessVerification.ok === true && proofAccepted && correlationEvidence === 'AVAILABLE') {
        return 'VERIFIED';
    }
    return 'UNVERIFIED';
}

module.exports = { deriveVerificationStatus };
