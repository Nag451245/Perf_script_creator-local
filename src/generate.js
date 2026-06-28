'use strict';
/**
 * generate.js — the local app's own HAR→JMX generation.
 *
 * Mirrors the engine's generateCorrelatedJmx (filter → correlate → relevance
 * → placement → group → buildPlanFromHar → render → validate → repair →
 * UDV-inject) but adds PARAMETERIZATION: discover user-input fields, synthesize
 * a unique-per-row data pool, and wire a CSV Data Set so the script actually
 * USES that data (state-pollution defense — blueprint #1). The orchestrator
 * hardcodes empty parameterizations and can't be changed without touching the
 * current app, so we orchestrate the same reused sub-modules here.
 */
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const FilterEngine = E.req('src/modules/filter');
const CorrelationEngine = E.req('src/modules/correlation');
const placementFixer = E.req('src/modules/correlation-placement-fixer');
const { buildPlanFromHar } = E.req('src/modules/test-plan-ir');
const { getRenderer, DEFAULT_RENDERER_ID } = E.req('src/modules/renderers');
const dryRunValidator = E.req('src/modules/jmx-dry-run-validator');
const jmxAutoRepair = E.req('src/modules/jmx-auto-repair');
const udvInjector = E.req('src/modules/udv-injector');
const { filterForGeneration } = E.req('src/modules/correlation-relevance');
const { suggestParameterizations } = E.paramAdvisor;
const { synthesizeCsv } = E.dataSynth;
const { detectClientSideDynamic } = E.clientSide;

function generate(entriesRaw, pages, outDir, name, { dataRows = 10 } = {}) {
    fs.mkdirSync(outDir, { recursive: true });

    // 1. Filter noise (background auth, static assets, analytics, tunnels).
    const filter = new FilterEngine();
    const bgAuth = filter.detectBackgroundAuthIndices(entriesRaw);
    const flat = [];
    entriesRaw.forEach((e, i) => {
        const u = e.request?.url || '';
        if (bgAuth.has(i)) return;
        if (filter.isTunnelRequest(e) || filter.isStaticAsset(u) || filter.isExcludedPath(u) ||
            filter.isAnalyticsDomain(u) || filter.isBrowserNoise(u)) return;
        flat.push(e);
    });

    // 2. Correlate + relevance gate.
    const rawCorrs = new CorrelationEngine().detectCorrelations(flat);
    const { kept: corrs } = filterForGeneration(rawCorrs);
    placementFixer.fix(corrs, flat);

    // 3. Group into transactions by pageref.
    const order = []; const gbp = new Map();
    const pageById = new Map((pages || []).map(p => [p.id, p]));
    for (const e of flat) {
        const pid = e.pageref || '__u';
        if (!gbp.has(pid)) { gbp.set(pid, []); order.push(pid); }
        gbp.get(pid).push(e);
    }
    const groups = order.map(pid => ({ name: (pageById.get(pid)?.title) || 'Transaction', type: 'transaction', entries: gbp.get(pid) }));

    // Ghost sources (blueprint #2): client-minted values (UUID/timestamp/trace/
    // cache-buster) with no server origin. The JMeter renderer ALREADY rewrites
    // these inline (guid->${__UUID}, _=->${__time}, …), so this only surfaces
    // them for the report — pass correlated values as server-origin so already-
    // correlated dynamics aren't mislabeled as ghosts.
    const serverOrigin = new Set(corrs.map(c => c.value).filter(Boolean));
    const ghosts = detectClientSideDynamic(flat, serverOrigin) || [];
    if (ghosts.length) fs.writeFileSync(path.join(outDir, `${name}_ghosts.json`), JSON.stringify(ghosts, null, 2));

    // 4. Parameterization + unique data (state-pollution defense). Discover
    //    user-input fields, synthesize a multi-row pool, wire one CSV Data Set.
    const candidates = suggestParameterizations(flat) || [];
    let params = [];
    let csvFile = null;
    if (candidates.length) {
        csvFile = `${name}_data.csv`;
        fs.writeFileSync(path.join(outDir, csvFile),
            synthesizeCsv(candidates.map(c => ({ name: c.name, sample: c.value })), dataRows));
        fs.writeFileSync(path.join(outDir, `${name}_parameters.json`), JSON.stringify(candidates, null, 2));
        params = candidates.map(c => ({
            variableName: c.name, name: c.name,
            originalValue: c.value, value: c.value,
            source: 'csv', csvFilename: csvFile,
        }));
    }

    // 5. Build IR → render → validate → auto-repair → UDV-inject.
    const opts = {
        sourceFile: name, recordingFilename: `${name}.recording.xml`,
        includeThinkTimes: false, includeAssertions: false,
        parameterizations: params, userDefinedVariables: params,
        harGapValues: [], userDefinedGaps: [], stableAssertions: [],
    };
    const ir = buildPlanFromHar({
        flatEntries: flat, enrichedGroups: groups, correlations: corrs, generatorOptions: opts,
        metadata: { sourceFilename: name, recordingFilename: `${name}.recording.xml`, sourceFormat: 'har' },
        config: { correlationThreshold: 0.75 },
    });
    let xml = getRenderer(DEFAULT_RENDERER_ID).render(ir).xml;
    let vr = dryRunValidator.validate(xml, corrs);
    const rr = jmxAutoRepair.repair(xml, vr, { injectOrphanFixes: true });
    if (rr.changed) { xml = rr.xml; vr = dryRunValidator.validate(xml, corrs); }
    xml = udvInjector.inject(xml).xml;

    const jmxPath = path.join(outDir, `${name}.jmx`);
    fs.writeFileSync(jmxPath, xml);

    return {
        jmxPath, flat, csvFile, candidates, ghosts,
        stats: {
            ingested: entriesRaw.length, kept: flat.length,
            correlations: corrs.length, parameterized: params.length,
            clientSideGhosts: ghosts.length,
            samplers: vr.totalSamplers, extractors: vr.totalExtractors, orphans: vr.orphanReferences.length,
        },
    };
}

module.exports = { generate };
