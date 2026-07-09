'use strict';

function flagsForRunMode(mode) {
    switch (mode) {
        case 'run':
            return ['--run'];
        case 'agent':
            return ['--agent'];
        case 'senior-agent':
            return ['--agent', '--senior'];
        case 'agent-watch':
            return ['--agent', '--watch'];
        case 'generate':
        case '':
        case null:
        case undefined:
            return [];
        default:
            return [];
    }
}

function flagsForRunRequest(request = {}) {
    const flags = [...flagsForRunMode(request.mode)];
    if (request.force) flags.push('--force');
    pushPositiveIntFlag(flags, '--iterations', request.iterations, { max: 6 });
    pushPositiveIntFlag(flags, '--retry-failed', request.retryFailed);
    // AI assist: off by default (cost). 'on' or 'pro' enables paid LLM.
    const ai = String(request.aiAssist || 'off').toLowerCase();
    if (ai === 'on' || ai === 'pro') flags.push('--ai');
    if (request.geminiPro || ai === 'pro') flags.push('--gemini-pro');
    const inputs = normalizeList(request.selectedInputs);
    for (const input of inputs) {
        flags.push('--input', input);
    }
    if (request.pair && inputs.length === 2) flags.push('--pair');
    return flags;
}

function pushPositiveIntFlag(flags, flag, value, { max = Infinity } = {}) {
    if (value === '' || value == null) return;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return;
    flags.push(flag, String(Math.min(n, max)));
}

function normalizeList(values) {
    return Array.isArray(values)
        ? values.map(value => String(value || '').trim()).filter(Boolean)
        : [];
}

module.exports = { flagsForRunMode, flagsForRunRequest };
