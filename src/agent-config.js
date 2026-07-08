'use strict';

function resolveAgentOptions(args = [], config = {}) {
    const flags = new Set(Array.isArray(args) ? args : []);
    const configured = config.agent && typeof config.agent === 'object' ? config.agent : {};

    const flagAgent = flags.has('--agent');
    const configAgent = configured.enabled === true;
    const doAgent = flagAgent || configAgent;
    const doRun = flags.has('--run') || doAgent;
    const agentEnabled = flagAgent || configAgent;

    return {
        doAgent,
        doRun,
        agent: {
            enabled: agentEnabled,
            maxLlmRounds: clampInt(configured.maxLlmRounds, 1, 3, 1),
            javaSafeMode: configured.javaSafeMode !== false,
        },
    };
}

function labelForAgentOptions(options = {}, watch = false) {
    if (options.doAgent) return watch ? 'agent validate (watch)' : 'agent validate';
    if (options.doRun) return watch ? 'generate + run/validate (watch)' : 'generate + run/validate';
    return watch ? 'generate only (watch)' : 'generate only';
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

module.exports = { resolveAgentOptions, labelForAgentOptions, _internal: { clampInt } };
