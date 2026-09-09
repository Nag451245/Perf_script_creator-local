'use strict';
/**
 * run-config.js — resolve the run settings that apply to ONE flow.
 *
 * Why this exists: `run` was global, so a setting tuned for one recording was
 * silently applied to every other one. `run.disableCalls` gained
 * `/jwt/v2/create-cookie` while working on createtask; that entry then disabled
 * WebPT's session minter on an unrelated flow, and the script served login
 * pages for weeks before anyone connected the two. Config that is really about
 * one flow now lives under that flow's name:
 *
 *   "run":   { ...shared defaults... },
 *   "flows": { "createtask": { "disableCalls": ["/jwt/v2/create-cookie"] } }
 *
 * List settings REPLACE rather than merge. A flow that says "these are my
 * disables" must not quietly inherit another flow's — merging lists would
 * recreate the exact bug this module was written to stop.
 */

/**
 * @param {object}  config       parsed perfscript.config.json
 * @param {string}  flowName     the flow being scripted (matched exactly)
 * @param {string}  scenarioCode per-RUN only; never persisted (SC01 default)
 */
function runConfigForFlow({ config = {}, flowName = '', scenarioCode = '' } = {}) {
    const base = config.run || {};
    const perFlow = (config.flows && flowName && config.flows[flowName]) || null;
    const merged = perFlow ? { ...base, ...perFlow } : { ...base };
    if (scenarioCode) merged.scenarioCode = scenarioCode;
    return merged;
}

/** Which flows have their own overrides — used to explain settings in reports. */
function flowsWithOverrides(config = {}) {
    return Object.keys((config && config.flows) || {});
}

module.exports = { runConfigForFlow, flowsWithOverrides };
