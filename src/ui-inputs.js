'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeInputFiles } = require('./ingest');

function buildInputModel(inputDir) {
    const fullFiles = listInputFiles(inputDir);
    const analysis = analyzeInputFiles(fullFiles);
    return {
        files: fullFiles.map(file => projectFile(file)),
        units: (analysis.units || []).map(unit => projectUnit(unit, analysis, inputDir)),
        issues: (analysis.issues || []).map(issue => projectIssue(issue, inputDir)),
    };
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
        files: unitFiles.map(file => projectUnitFile(unit, file, rootDir)),
        runnable: true,
        warnings,
    };
}

function projectFile(file) {
    return {
        name: path.basename(file),
        path: file,
        size: safeStat(file).size,
        mtime: safeStat(file).mtimeMs,
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
    _internal: { listInputFiles, projectUnit, filesForUnit, unitMatches },
};
