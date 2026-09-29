'use strict';

// Operator artifacts may be copied outside the protected output directory.
// Keep only diagnostic metadata, never raw rendered values or server reasons.
function summarizeFirstCorrelationDivergence(divergence) {
    if (!divergence || typeof divergence !== 'object') return null;
    const link = divergence.link && typeof divergence.link === 'object' ? divergence.link : {};
    return {
        kind: String(divergence.kind || 'unknown'),
        producerIndex: numericOrNull(divergence.producerIndex),
        consumerIndex: numericOrNull(divergence.consumerIndex),
        variable: safeName(link.variable || divergence.variable || ''),
        reason: 'redacted; inspect protected runtime-proof artifact for details',
    };
}

function numericOrNull(value) {
    return Number.isInteger(Number(value)) ? Number(value) : null;
}

function safeName(value) {
    return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 120) || 'unknown';
}

module.exports = { summarizeFirstCorrelationDivergence };
