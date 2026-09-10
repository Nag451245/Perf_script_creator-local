'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeInputFiles } = require('./ingest');

function buildInputModel(inputDir) {
    const fullFiles = listInputFiles(inputDir);
    const analysis = analyzeInputFiles(fullFiles);
    const units = (analysis.units || []).map(unit => projectUnit(unit, analysis, inputDir));
    return {
        // Every file, with what it is paired to. The picker only ever listed
        // grouped UNITS, so a folder of 21 files showed 13 entries and the
        // recording XMLs were nowhere — which reads as "my files were not
        // picked up" even though they were consumed into the units.
        files: fullFiles.map(file => projectFile(file, analysis, fullFiles)),
        units,
        issues: (analysis.issues || []).map(issue => projectIssue(issue, inputDir)),
    };
}

/**
 * Which script is this recording attached to, or which recording does this
 * script have? Derived from the units the grouper actually built, so the panel
 * shows the real pairing rather than a second guess at it.
 */
function pairingFor(file, analysis) {
    const key = pathKey(file);
    for (const unit of analysis.units || []) {
        if (unit.individual) continue;   // the same files, listed twice
        const sidecars = unit.sidecars || {};
        if (pathKey(unit.primary) === key) {
            const rec = sidecars.primary || (unit.kind === 'jmx' ? unit.secondary : '');
            return { role: 'script', pairedWith: rec ? path.basename(rec) : '', unit: unit.name };
        }
        if (pathKey(unit.secondary) === key) {
            if (unit.kind === 'jmx') return { role: 'recording', pairedWith: path.basename(unit.primary), unit: unit.name };
            return { role: 'script', pairedWith: sidecars.secondary ? path.basename(sidecars.secondary) : '', unit: unit.name };
        }
        if (pathKey(sidecars.primary) === key) return { role: 'recording', pairedWith: path.basename(unit.primary), unit: unit.name };
        if (pathKey(sidecars.secondary) === key) return { role: 'recording', pairedWith: path.basename(unit.secondary || unit.primary), unit: unit.name };
        if (pathKey(unit.golden) === key) return { role: 'golden', pairedWith: path.basename(unit.primary), unit: unit.name };
    }
    return { role: 'unused', pairedWith: '', unit: '' };
}

function listInputFiles(inputDir) {
    if (!inputDir || !fs.existsSync(inputDir)) return [];
    return fs.readdirSync(inputDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
        .map(entry => path.join(inputDir, entry.name));
}

function projectUnit(unit, analysis, rootDir) {
    const unitFiles = filesForUnit(unit);
    const inventoryByPath = new Map((analysis.inventory || []).map(item => [pathKey(item.file), item]));
    const fingerprints = unitFiles.map(file => inventoryByPath.get(pathKey(file))?.fingerprint).filter(Boolean);
    const warnings = (analysis.issues || [])
        .filter(issue => issueBelongsToFiles(issue, unitFiles))
        .map(issue => projectIssue(issue, rootDir));
    return {
        id: unitId(unit),
        name: unit.name,
        kind: unit.kind,
        individual: !!unit.individual,
        derivedFrom: unit.derivedFrom || undefined,
        primary: unit.primary,
        secondary: unit.secondary,
        sidecars: unit.sidecars || undefined,
        golden: unit.golden,
        requestCount: fingerprints.reduce((max, fp) => Math.max(max, Number(fp.requestCount) || 0), 0),
        hosts: unique(fingerprints.flatMap(fp => fp.hosts || [])),
        // The app under test. `hosts[0]` was alphabetical, so a WebPT script
        // was labelled "api.anthropic.com" and looked like somebody else's.
        primaryHost: primaryHostForUnit(fingerprints),
        recording: recordingStateFor(unit),
        files: unitFiles.map(file => projectUnitFile(unit, file, rootDir)),
        runnable: true,
        warnings,
    };
}

function projectFile(file, analysis, allFiles) {
    const ext = path.extname(file).toLowerCase();
    const pairing = analysis ? pairingFor(file, analysis) : { role: 'unused', pairedWith: '' };
    return {
        name: path.basename(file),
        path: file,
        size: safeStat(file).size,
        mtime: safeStat(file).mtimeMs,
        type: ext === '.har' ? 'har' : ext === '.jmx' ? 'jmx'
            : (ext === '.xml' || ext === '.jtl') ? 'recording' : 'other',
        role: pairing.role,
        pairedWith: pairing.pairedWith,
        unit: pairing.unit,
    };
}

function projectUnitFile(unit, file, rootDir) {
    return {
        role: roleForUnitFile(unit, file),
        name: path.basename(file),
        path: file,
        relativePath: rootDir ? path.relative(rootDir, file) : path.basename(file),
        size: safeStat(file).size,
    };
}

function projectIssue(issue, rootDir) {
    return {
        code: issue.code || 'input_issue',
        severity: issue.severity || 'info',
        message: issue.message || '',
        file: issue.file ? displayPath(issue.file, rootDir) : undefined,
        files: Array.isArray(issue.files) ? issue.files.map(file => displayPath(file, rootDir)) : undefined,
    };
}

function selectUnits(units, selectors) {
    const requested = (selectors || []).map(value => String(value || '').trim()).filter(Boolean);
    if (!requested.length) return { selected: units.slice(), missing: [] };
    const selected = [];
    const selectedIds = new Set();
    const missing = [];
    for (const selector of requested) {
        const match = units.find(unit => unitMatches(unit, selector));
        if (!match) {
            missing.push(selector);
            continue;
        }
        const key = match.id || unitId(match);
        if (!selectedIds.has(key)) {
            selected.push(match);
            selectedIds.add(key);
        }
    }
    return { selected, missing };
}

function unitMatches(unit, selector) {
    const wanted = normalizeSelector(selector);
    if (!wanted) return false;
    return matchCandidates(unit).some(candidate => normalizeSelector(candidate) === wanted);
}

function matchCandidates(unit) {
    const files = filesForUnit(unit).map(file => path.basename(file));
    const projectedFiles = Array.isArray(unit.files) ? unit.files.map(file => file.name || file.path).filter(Boolean) : [];
    return [
        // The UI sends the synthetic unit id. The UI's projected units carry
        // `.id`, but index.js selects against RAW ingest units that don't —
        // so ALWAYS include the computed id, or the dropdown selection never
        // matches and --pair then sees zero units.
        unit.id || unitId(unit),
        unit.name,
        unit.primary,
        unit.secondary,
        unit.golden,
        ...(unit.sidecars ? Object.values(unit.sidecars) : []),
        ...files,
        ...projectedFiles,
    ].filter(Boolean);
}

function filesForUnit(unit) {
    const files = [unit.primary, unit.secondary, unit.golden];
    if (unit.sidecars) files.push(unit.sidecars.primary, unit.sidecars.secondary);
    if (Array.isArray(unit.files)) files.push(...unit.files.map(file => file.path || file.name));
    return unique(files.filter(Boolean));
}

function unitId(unit) {
    return `${safeId(unit.kind)}-${safeId(unit.name)}-${safeId(path.basename(unit.primary || 'input'))}`;
}

/** The busiest non-telemetry host across the unit's files. */
function primaryHostForUnit(fingerprints = []) {
    const ranked = fingerprints
        .filter(fp => fp && fp.primaryHost)
        .sort((a, b) => (Number(b.requestCount) || 0) - (Number(a.requestCount) || 0));
    return ranked.length ? ranked[0].primaryHost : '';
}

/**
 * Does this unit have the response side, and does it need one?
 *
 * A HAR carries requests AND responses. A JMX carries only REQUESTS — without
 * its recording XML/JTL there is nothing to correlate FROM, so every token and
 * session id ships hardcoded and the script fails on the second run. The picker
 * used to look identical either way, which is why "upload the XML for a JMX"
 * was not obviously already possible.
 */
function recordingStateFor(unit) {
    const kind = String(unit.kind || '');
    if (kind === 'har' || kind === 'dual-har') {
        return { needed: false, have: 2, of: 2, label: 'responses included' };
    }
    if (kind === 'dual-jmx') {
        const sidecars = unit.sidecars || {};
        const have = [sidecars.primary, sidecars.secondary].filter(Boolean).length;
        return {
            needed: true, have, of: 2,
            label: have === 2 ? 'both recordings attached'
                : have === 1 ? 'only 1 of 2 recordings — add the missing XML/JTL'
                    : 'NO recordings — add the XML/JTL captured with these scripts',
        };
    }
    if (kind === 'jmx') {
        const have = unit.secondary ? 1 : 0;
        return {
            needed: true, have, of: 1,
            label: have ? 'recording attached' : 'NO recording — add its XML/JTL',
        };
    }
    return { needed: false, have: 0, of: 0, label: '' };
}

function roleForUnitFile(unit, file) {
    const key = pathKey(file);
    if (pathKey(unit.primary) === key) return 'primary';
    if (pathKey(unit.sidecars?.primary) === key || pathKey(unit.sidecars?.secondary) === key) return 'sidecar';
    if (pathKey(unit.secondary) === key) return unit.kind === 'jmx' ? 'sidecar' : 'secondary';
    if (pathKey(unit.golden) === key) return 'golden';
    return 'support';
}

function issueBelongsToFiles(issue, files) {
    const keys = new Set(files.map(pathKey));
    if (issue.file && keys.has(pathKey(issue.file))) return true;
    return Array.isArray(issue.files) && issue.files.some(file => keys.has(pathKey(file)));
}

function safeStat(file) {
    try { return fs.statSync(file); }
    catch { return { size: 0, mtimeMs: 0 }; }
}

function displayPath(file, rootDir) {
    return rootDir ? path.relative(rootDir, file) || path.basename(file) : path.basename(file);
}

function pathKey(file) {
    return path.normalize(String(file || '')).replace(/\\/g, '/').toLowerCase();
}

function normalizeSelector(value) {
    return path.basename(String(value || '')).trim().toLowerCase();
}

function safeId(value) {
    return String(value || 'input').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'input';
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

module.exports = {
    buildInputModel,
    selectUnits,
    unitId,
    _internal: { listInputFiles, projectUnit, filesForUnit, unitMatches, recordingStateFor, primaryHostForUnit },
};
