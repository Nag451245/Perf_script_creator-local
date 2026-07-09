'use strict';

const fs = require('fs');
const path = require('path');

function createBlueprintContext({
    entries = [],
    secondaryEntries = [],
    pages = [],
    mode = '',
    outDir,
    name,
    runCfg = {},
    agentCfg = {},
} = {}) {
    return {
        name,
        mode,
        outDir,
        entriesCount: entries.length,
        secondaryEntriesCount: secondaryEntries.length,
        pagesCount: pages.length,
        runCfg: summarizeRunCfg(runCfg),
        agentCfg: summarizeAgentCfg(agentCfg),
        cleanups: [],
        lineage: { links: [], orphans: [], dynamics: [], producersByValue: {} },
        dataModel: { csvFile: null, parameters: [], protectedBusinessFields: [] },
        validation: { assertions: [], softFailureRules: [], businessGuard: null },
        seniorPe: null,
        loop: { attempts: [], firstFailure: null, patches: [] },
        ai: { promptEvidence: null, acceptedFixes: [], rejectedFixes: [] },
    };
}

function summarizeRunCfg(runCfg) {
    return {
        targetBaseUrlOverride: runCfg.targetBaseUrlOverride || '',
        targetBaseUrl: runCfg.targetBaseUrl || '',
        hasCredentials: !!(runCfg.credentials && runCfg.credentials.username),
        disableCalls: Array.isArray(runCfg.disableCalls) ? runCfg.disableCalls.slice() : [],
        businessGoal: runCfg.businessGoal || '',
    };
}

function summarizeAgentCfg(agentCfg) {
    return {
        enabled: agentCfg.enabled === true,
        maxLlmRounds: agentCfg.maxLlmRounds,
        javaSafeMode: agentCfg.javaSafeMode !== false,
    };
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
}

function writeBlueprintArtifacts(ctx) {
    if (!ctx || !ctx.outDir || !ctx.name) {
        throw new Error('blueprint context requires outDir and name');
    }
    fs.mkdirSync(ctx.outDir, { recursive: true });
    const base = path.join(ctx.outDir, ctx.name);
    return {
        contextPath: writeJson(`${base}_blueprint_context.json`, ctx),
        lineagePath: writeJson(`${base}_lineage.json`, ctx.lineage || {}),
        repairRoundsPath: writeJson(`${base}_repair_rounds.json`, ctx.loop || {}),
    };
}

module.exports = { createBlueprintContext, writeBlueprintArtifacts };
