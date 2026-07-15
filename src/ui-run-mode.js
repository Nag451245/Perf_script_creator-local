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
    if (request.force || request.runSelected) flags.push('--force');
    pushPositiveIntFlag(flags, '--iterations', request.iterations, { max: 6 });
    pushPositiveIntFlag(flags, '--retry-failed', request.retryFailed);
    // Scenario code rides as a per-run FLAG, never through saved settings: the
    // next run defaults back to SC01 unless the operator types one again.
    const scenario = scenarioFlagValue(request.scenarioCode);
    if (scenario) flags.push('--scenario', scenario);
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

/**
 * Sanitize the operator's scenario code before it reaches a child-process
 * argument: short alphanumeric only, so a stray value can never become another
 * flag. Blank (the normal case) means SC01 and no flag at all.
 */
function scenarioFlagValue(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    return /^[A-Za-z0-9_]{1,10}$/.test(raw) ? raw : '';
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
