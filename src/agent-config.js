'use strict';

function resolveAgentOptions(args = [], config = {}) {
    const flags = new Set(Array.isArray(args) ? args : []);
    const configured = config.agent && typeof config.agent === 'object' ? config.agent : {};

    const flagAgent = flags.has('--agent');
    const flagSenior = flags.has('--senior');
    const configAgent = configured.enabled === true;
    const doAgent = flagAgent || configAgent;
    const doRun = flags.has('--run') || doAgent;
    const agentEnabled = flagAgent || configAgent;
    const seniorMode = resolveSeniorMode({ configured: configured.seniorMode, agentEnabled, flagSenior });

    return {
        doAgent,
        doRun,
        agent: {
            enabled: agentEnabled,
            maxLlmRounds: clampInt(configured.maxLlmRounds, 1, 3, 1),
            maxReplans: clampInt(configured.maxReplans, 0, 2, 0),
            javaSafeMode: configured.javaSafeMode !== false,
            seniorMode,
        },
    };
}

function labelForAgentOptions(options = {}, watch = false) {
    const mode = options.agent && options.agent.seniorMode;
    if (options.doAgent && mode === 'mature') return watch ? 'mature senior PE agent validate (watch)' : 'mature senior PE agent validate';
    if (options.doAgent && mode === 'strong') return watch ? 'strong senior PE agent validate (watch)' : 'strong senior PE agent validate';
    if (options.doAgent) return watch ? 'agent validate (watch)' : 'agent validate';
    if (options.doRun) return watch ? 'generate + run/validate (watch)' : 'generate + run/validate';
    return watch ? 'generate only (watch)' : 'generate only';
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function resolveSeniorMode({ configured, agentEnabled, flagSenior } = {}) {
    if (!agentEnabled && !flagSenior) return 'off';
    if (flagSenior) return 'mature';
    return ['off', 'strong', 'mature'].includes(configured) ? configured : 'strong';
}

module.exports = { resolveAgentOptions, labelForAgentOptions, _internal: { clampInt, resolveSeniorMode } };
