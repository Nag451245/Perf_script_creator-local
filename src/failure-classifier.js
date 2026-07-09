'use strict';

function classifyFirstFailure(result = {}) {
    if (result.statusRootCause && result.statusRootCause.rootCause) {
        return {
            sampler: result.statusRootCause.rootCause.sampler || '',
            responseCode: String(result.statusRootCause.rootCause.observed || ''),
            message: result.statusRootCause.summary || result.statusRootCause.rootCause.repairHint || '',
            category: result.statusRootCause.rootCause.category,
            rootCauseIndex: result.statusRootCause.rootCauseIndex,
            failingIndex: result.statusRootCause.failingIndex,
        };
    }

    const unresolved = firstUnresolved(result);
    if (unresolved) return unresolved;

    const sample = (result.samples || []).find(s => !s.isTransaction && s.success === false);
    if (!sample) return null;

    const code = String(sample.responseCode || sample.code || '');
    const message = String(sample.failureMessage || sample.responseMessage || sample.assertionMessage || '');
    const label = sample.label || sample.name || '';
    const base = { sampler: label, responseCode: code, message };

    if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(message + ' ' + label)) {
        return { ...base, category: 'unresolved_variable' };
    }
    if (/session expired|invalid_token|unauthorized|csrf|forbidden/i.test(message) && (code === '200' || code === '')) {
        return { ...base, category: 'soft_failure_200' };
    }
    if (code === '401' || code === '403') {
        return { ...base, category: 'auth_correlation_failed' };
    }
    if (code === '400' || code === '422' || /^5\d\d$/.test(code)) {
        return { ...base, category: 'payload_or_header_failed' };
    }
    if (code === '200' && message) {
        return { ...base, category: 'soft_failure_200' };
    }
    return { ...base, category: 'unknown_failure' };
}

function firstUnresolved(result) {
    const failure = (result.unresolvedFailures || []).find(u => u.varName || /unresolved|\$\{/i.test(String(u.issue || u.manualFixHint || '')));
    if (!failure) return null;
    return {
        sampler: failure.samplerLabel || failure.samplerName || '',
        responseCode: failure.responseCode || '',
        message: failure.issue || failure.manualFixHint || '',
        variable: failure.varName || '',
        category: 'unresolved_variable',
    };
}

module.exports = { classifyFirstFailure };
