'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function defaultStatePath(rootDir = process.cwd()) {
    return path.join(rootDir, '.perfscript-state', 'processed-inputs.json');
}

function loadProcessedState(statePath = defaultStatePath()) {
    if (!fs.existsSync(statePath)) return { schemaVersion: 1, units: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/, ''));
        return {
            schemaVersion: 1,
            units: parsed && parsed.units && typeof parsed.units === 'object' ? parsed.units : {},
        };
    } catch {
        return { schemaVersion: 1, units: {} };
    }
}

function saveProcessedState(state, statePath = defaultStatePath()) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        units: state && state.units && typeof state.units === 'object' ? state.units : {},
    }, null, 2));
}

function shouldProcessUnit(unit, state) {
    const signature = unitSignature(unit);
    if (!signature) return false;
    const units = state && state.units ? state.units : {};
    return units[signature.id] !== signature.hash;
}

function markUnitProcessed(unit, state, statePath = defaultStatePath()) {
    const signature = unitSignature(unit);
    if (!signature) return null;
    if (!state.units) state.units = {};
    state.units[signature.id] = signature.hash;
    saveProcessedState(state, statePath);
    return signature;
}

function unitSignature(unit) {
    const files = unitFiles(unit);
    if (!files.length) return null;
    const normalized = files.map(fileSignature).filter(Boolean);
    if (!normalized.length) return null;
    const id = sha256(normalized.map(f => f.path).join('|'));
    const hash = sha256(JSON.stringify({ kind: unit.kind || 'unknown', files: normalized }));
    return { id, hash, files: normalized };
}

function unitFiles(unit) {
    if (!unit) return [];
    return [
        unit.primary,
        unit.secondary,
        unit.sidecars && unit.sidecars.primary,
        unit.sidecars && unit.sidecars.secondary,
    ].filter(Boolean);
}

function fileSignature(file) {
    try {
        const stat = fs.statSync(file);
        return {
            path: path.resolve(file).toLowerCase(),
            size: stat.size,
            mtimeMs: Math.floor(stat.mtimeMs),
        };
    } catch {
        return null;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
    defaultStatePath,
    loadProcessedState,
    saveProcessedState,
    shouldProcessUnit,
    markUnitProcessed,
    unitSignature,
    _internal: { unitFiles, fileSignature },
};
