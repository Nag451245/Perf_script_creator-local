'use strict';
/**
 * engine.js — the ONLY coupling point to the existing PerfScript codebase.
 *
 * This local app REUSES the proven engine (correlation, generation, the
 * feedback loop) by requiring the existing backend modules in place. It does
 * NOT copy them and does NOT modify the current app (read-only require). The
 * backend's own require('express') etc. resolve from backend/node_modules
 * automatically, so this folder needs no node_modules of its own.
 *
 * Resolution order for the engine path:
 *   1. PERFSCRIPT_ENGINE env var (preferred for CI / shared installs).
 *   2. .env file at the local app root (auto-loaded; no dotenv dep).
 *   3. ../jmeter-script-creator/backend (sibling checkout — common dev layout).
 *   4. ../jmeter-script-creator-main/backend
 *   5. ../jmeter-script-creator-main/jmeter-script-creator-main/backend
 * Throws loudly if no candidate exists, listing every path it tried.
 */
const path = require('path');
const fs = require('fs');

// Tiny .env loader. Format: KEY=VALUE per line, # for comments, no quotes
// handling beyond stripping a single surrounding pair of " or '. We avoid
// adding `dotenv` as a dep — pony-tail principle (this is 20 lines).
(function loadDotEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    try {
        for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq < 0) continue;
            const key = line.substring(0, eq).trim();
            let value = line.substring(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && !(key in process.env)) process.env[key] = value;
        }
    } catch { /* unreadable .env — silently ignore */ }
})();

function findEngineRoot() {
    const sentinel = path.join('src', 'services', 'agent-orchestrator.js');
    const tried = [];
    const candidates = [];
    if (process.env.PERFSCRIPT_ENGINE) candidates.push(process.env.PERFSCRIPT_ENGINE);
    const here = path.resolve(__dirname, '..');
    candidates.push(
        path.resolve(here, '..', 'jmeter-script-creator', 'backend'),
        path.resolve(here, '..', 'jmeter-script-creator-main', 'backend'),
        path.resolve(here, '..', 'jmeter-script-creator-main', 'jmeter-script-creator-main', 'backend'),
    );
    for (const c of candidates) {
        tried.push(c);
        if (fs.existsSync(path.join(c, sentinel))) return c;
    }
    throw new Error(
        `PerfScript engine not found. Set PERFSCRIPT_ENGINE (env or .env) to the` +
        ` repo's "backend" folder. Tried:\n  - ${tried.join('\n  - ')}`
    );
}

const ENGINE_ROOT = findEngineRoot();

function eng(rel) { return require(path.join(ENGINE_ROOT, rel)); }

const HarParser            = eng('src/modules/har-parser');
const orchestrator         = eng('src/services/agent-orchestrator');
const jmeterDetector       = eng('src/services/jmeter-detector');
const recordingXml         = eng('src/modules/recording-xml-generator');
const stripListenerFilenamesModule = eng('src/modules/strip-listener-filenames');
const paramAdvisor         = eng('src/modules/parameterization-advisor');
const dataSynth            = eng('src/modules/test-data-synthesizer');
const clientSide           = eng('src/modules/client-side-detector');
const jmxSource            = eng('src/modules/jmx-source-parser');
const jtlParser            = eng('src/modules/jtl-parser');
const harComparator        = eng('src/modules/har-comparator');
const assertionMiner       = eng('src/modules/assertion-text-miner');

// API contract: the exact exports this local app depends on. Verified ONCE
// at load so an engine drift surfaces with a precise "engine module X is
// missing function Y" instead of a cryptic stack trace 30 seconds into a run.
// Adding to this list is the right way to harden against future engine
// refactors — pony-tail: we don't copy the engine, but we DO assert its shape.
const ENGINE_CONTRACT = [
    ['har-parser',             HarParser,                    'class HarParser', v => typeof v === 'function'],
    ['agent-orchestrator',     orchestrator,                 'runAgent',        v => typeof v.runAgent === 'function'],
    ['agent-orchestrator',     orchestrator,                 'generateCorrelatedJmx', v => typeof v.generateCorrelatedJmx === 'function'],
    ['jmeter-detector',        jmeterDetector,               'detect',          v => typeof v.detect === 'function'],
    ['recording-xml-generator', recordingXml,                'generate',        v => typeof v.generate === 'function'],
    ['strip-listener-filenames', stripListenerFilenamesModule, 'stripListenerFilenames', v => typeof v.stripListenerFilenames === 'function'],
    ['parameterization-advisor', paramAdvisor,               'suggestParameterizations', v => typeof v.suggestParameterizations === 'function'],
    ['test-data-synthesizer',  dataSynth,                    'synthesizeCsv',   v => typeof v.synthesizeCsv === 'function'],
    ['client-side-detector',   clientSide,                   'detectClientSideDynamic', v => typeof v.detectClientSideDynamic === 'function'],
    ['client-side-detector',   clientSide,                   'clientSideSnippetFor', v => typeof v.clientSideSnippetFor === 'function'],
    ['jmx-source-parser',      jmxSource,                    'parseJmxToHar',   v => typeof v.parseJmxToHar === 'function'],
    ['jtl-parser',             jtlParser,                    'parseJtlBuffer',  v => typeof v.parseJtlBuffer === 'function'],
    ['jtl-parser',             jtlParser,                    'pairJmxWithJtl',  v => typeof v.pairJmxWithJtl === 'function'],
    ['har-comparator',         harComparator,                'class HarComparator', v => typeof v === 'function'],
    ['assertion-text-miner',   assertionMiner,               'extractStableTextCandidates', v => typeof v.extractStableTextCandidates === 'function'],
];
const missing = ENGINE_CONTRACT
    .filter(([, mod, , ok]) => !ok(mod))
    .map(([modName, , exportName]) => `  - ${modName}: missing ${exportName}`);
if (missing.length) {
    throw new Error(
        `PerfScript engine at ${ENGINE_ROOT} is missing ${missing.length} expected export(s):\n` +
        `${missing.join('\n')}\n\n` +
        `This usually means the engine was upgraded with a breaking change. ` +
        `Pin to a compatible engine revision (or update src/engine.js to match).`
    );
}

module.exports = {
    ENGINE_ROOT,
    req: eng, // generic engine-module loader for src/generate.js
    HarParser,
    orchestrator,                                              // { runAgent, generateCorrelatedJmx }
    jmeterDetector,                                            // { detect, getInfo, ... }
    recordingXml,                                              // { generate }
    stripListenerFilenames: stripListenerFilenamesModule.stripListenerFilenames,
    paramAdvisor,                                              // { suggestParameterizations }
    dataSynth,                                                 // { synthesizeCsv, classifyValue, ... }
    clientSide,                                                // { detectClientSideDynamic, clientSideSnippetFor, ... }
    jmxSource,                                                 // { parseJmxToHar }
    jtlParser,                                                 // { parseJtlBuffer, pairJmxWithJtl }
    harComparator,                                             // class HarComparator { compare(har1, har2) }
    assertionMiner,                                            // { extractStableTextCandidates, ... }
};
