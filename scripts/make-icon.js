#!/usr/bin/env node
'use strict';
/**
 * make-icon.js — generate assets/perfscript.ico with zero image dependencies.
 * Draws an AUTONOMOUS AGENT mark: a friendly bot head (antenna + rounded head)
 * whose visor shows a live PERFORMANCE PULSE — i.e. an AI agent that watches
 * and builds performance scripts. Rendered on the brand gradient tile into a
 * 256x256 RGBA buffer, PNG-encoded (Node's zlib), wrapped in an ICO container.
 *
 * Run: node scripts/make-icon.js   → writes assets/perfscript.ico
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;
const RADIUS = 58;                 // tile corner radius

// Brand gradient: #4f7cff (top-left) → #7c5cff (bottom-right).
const C1 = [0x4f, 0x7c, 0xff];
const C2 = [0x7c, 0x5c, 0xff];
const WHITE = [250, 250, 253];
const VISOR = [25, 32, 56];        // dark screen
const PULSE = [45, 224, 178];      // teal performance signal

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function roundedAlpha(x, y, cx, cy, hx, hy, r) {
    const dx = Math.abs(x - cx) - (hx - r);
    const dy = Math.abs(y - cy) - (hy - r);
    const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
    const sdf = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
    return clamp(0.5 - sdf, 0, 1);
}
function tileAlpha(x, y) { return roundedAlpha(x, y, N / 2, N / 2, N / 2 - 2, N / 2 - 2, RADIUS); }
function rectCov(px, py, x0, y0, x1, y1, r) {
    return roundedAlpha(px, py, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, r);
}
function circleCov(px, py, cx, cy, r) { return clamp(r + 0.5 - Math.hypot(px - cx, py - cy), 0, 1); }
function segDist(px, py, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const t = clamp(((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy || 1), 0, 1);
    return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}
function polyCov(px, py, pts, half) {
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(px, py, pts[i], pts[i + 1]));
    return clamp(half + 0.5 - d, 0, 1);
}

// Head + antenna + visor geometry.
const HEAD = [64, 66, 192, 196], HEAD_R = 34;   // x0,y0,x1,y1
const EAR_Y0 = 108, EAR_Y1 = 150;
const VIS = [86, 96, 170, 152], VIS_R = 20;
const ANT = { x: 128, y0: 40, y1: 66, dot: 12 };
const PULSE_PTS = [[95, 124], [110, 124], [119, 106], [129, 146], [139, 112], [149, 124], [161, 124]];

function comp(base, color, cov) {
    if (cov <= 0) return;
    base[0] += (color[0] - base[0]) * cov;
    base[1] += (color[1] - base[1]) * cov;
    base[2] += (color[2] - base[2]) * cov;
}

function render() {
    const buf = Buffer.alloc(N * N * 4);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const o = (y * N + x) * 4;
            const px = x + 0.5, py = y + 0.5;
            const tA = tileAlpha(px, py);
            if (tA <= 0) continue;
            const g = clamp((x + y) / (2 * N), 0, 1);
            const hi = clamp(1 - Math.hypot(px - 72, py - 60) / 210, 0, 1) * 24;
            const col = [C1[0] + (C2[0] - C1[0]) * g + hi, C1[1] + (C2[1] - C1[1]) * g + hi, C1[2] + (C2[2] - C1[2]) * g + hi];

            // antenna (stalk + dot), behind the head top
            comp(col, WHITE, polyCov(px, py, [[ANT.x, ANT.y0], [ANT.x, ANT.y1]], 3.5));
            comp(col, PULSE, circleCov(px, py, ANT.x, ANT.y0 - 2, ANT.dot));
            // side ears
            comp(col, WHITE, rectCov(px, py, 52, EAR_Y0, 68, EAR_Y1, 7));
            comp(col, WHITE, rectCov(px, py, 188, EAR_Y0, 204, EAR_Y1, 7));
            // head
            comp(col, WHITE, rectCov(px, py, HEAD[0], HEAD[1], HEAD[2], HEAD[3], HEAD_R));
            // visor screen
            comp(col, VISOR, rectCov(px, py, VIS[0], VIS[1], VIS[2], VIS[3], VIS_R));
            // performance pulse inside the visor
            comp(col, PULSE, polyCov(px, py, PULSE_PTS, 3.2));

            buf[o] = Math.round(clamp(col[0], 0, 255));
            buf[o + 1] = Math.round(clamp(col[1], 0, 255));
            buf[o + 2] = Math.round(clamp(col[2], 0, 255));
            buf[o + 3] = Math.round(tA * 255);
        }
    }
    return buf;
}

// ── PNG encoding ────────────────────────────────────────────────────────
const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(b) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}
function encodePng(rgba) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((N * 4 + 1) * N);
    for (let y = 0; y < N; y++) {
        raw[y * (N * 4 + 1)] = 0; // no filter
        rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── ICO container (single embedded PNG) ─────────────────────────────────
function wrapIco(png) {
    const dir = Buffer.alloc(6);
    dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
    const entry = Buffer.alloc(16);
    entry[0] = 0; entry[1] = 0;          // 0 = 256 px
    entry[2] = 0; entry[3] = 0;
    entry.writeUInt16LE(1, 4);           // planes
    entry.writeUInt16LE(32, 6);          // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(6 + 16, 12);
    return Buffer.concat([dir, entry, png]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePng(render());
fs.writeFileSync(path.join(outDir, 'perfscript.png'), png);
fs.writeFileSync(path.join(outDir, 'perfscript.ico'), wrapIco(png));
console.log(`wrote assets/perfscript.ico (${png.length} bytes PNG) + assets/perfscript.png`);
