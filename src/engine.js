'use strict';
/**
 * engine.js — the ONLY coupling point to the existing PerfScript codebase.
 *
 * This local app REUSES the proven engine (correlation, generation, the
 * feedback loop) by requiring the existing backend modules in place. It does
 * NOT copy them (copies diverge — see the agent/ fork) and does NOT modify
 * the current app (read-only require). The backend's own require('express')
 * etc. resolve from backend/node_modules automatically, so this folder needs
 * no node_modules of its own for Phase 1.
 *
 * Point at a different checkout with the PERFSCRIPT_ENGINE env var.
 */
const path = require('path');
const fs = require('fs');

const ENGINE_ROOT = process.env.PERFSCRIPT_ENGINE
    || 'D:/Users/nagendra.bpuchala/Documents/jmeter-script-creator-main/jmeter-script-creator-main/backend';

if (!fs.existsSync(path.join(ENGINE_ROOT, 'src', 'services', 'agent-orchestrator.js'))) {
    throw new Error(
        `PerfScript engine not found at: ${ENGINE_ROOT}\n` +
        `Set PERFSCRIPT_ENGINE to the path of the repo's "backend" folder.`
    );
}

function eng(rel) { return require(path.join(ENGINE_ROOT, rel)); }

module.exports = {
    ENGINE_ROOT,
    HarParser: eng('src/modules/har-parser'),
    orchestrator: eng('src/services/agent-orchestrator'), // { runAgent, generateCorrelatedJmx }
    jmeterDetector: eng('src/services/jmeter-detector'),   // { detect, getInfo, ... }
    recordingXml: eng('src/modules/recording-xml-generator'), // { generate }
    stripListenerFilenames: eng('src/modules/strip-listener-filenames').stripListenerFilenames,
    paramAdvisor: eng('src/modules/parameterization-advisor'), // { suggestParameterizations }
    dataSynth: eng('src/modules/test-data-synthesizer'),       // { synthesizeCsv, classifyValue, ... }
};
