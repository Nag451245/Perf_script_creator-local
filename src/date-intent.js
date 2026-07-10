'use strict';
/**
 * date-intent.js — recognize date/datetime fields and make them RELATIVE to
 * run time instead of shipping the stale recorded literal.
 *
 * A senior PE never hardcodes a captured date: a booking for "tomorrow", an
 * expiry "+30d", or a report window "last week" must stay valid whenever the
 * test runs — a 2024 date replayed in 2026 returns an empty/invalid result
 * that still 200s (a silent business failure). The fix is JMeter's native
 * ${__timeShift(format,,offset,,)} function (no scripting, survives the
 * java-safe strip): it reproduces the recorded date's OFFSET from the
 * recording time, in the recorded format, computed at run time.
 *
 * Conservative by design: only unambiguous date shapes are shifted; ambiguous
 * dd/MM vs MM/dd values are left literal and flagged; the whole pass is
 * gated by run.dates.shift (default on) and each shift is noted for review
 * (a genuinely FIXED historical window can be pinned back in config).
 */

// JMeter SimpleDateFormat patterns, most specific first.
const FORMATS = [
    { re: /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/, fmt: (t) => t.includes('T') ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd HH:mm:ss', time: true, iso: true },
    { re: /^(\d{4})-(\d{2})-(\d{2})$/, fmt: () => 'yyyy-MM-dd', time: false, iso: true },
    { re: /^(\d{4})\/(\d{2})\/(\d{2})$/, fmt: () => 'yyyy/MM/dd', time: false, ymd: true },
    { re: /^(\d{2})\/(\d{2})\/(\d{4})$/, fmt: () => 'MM/dd/yyyy', time: false, mdy: true },
];

/**
 * @returns {null | { date: Date, jmeterFormat: string, hasTime: boolean }}
 */
function detectDate(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s || s.length < 8 || s.length > 25) return null;
    for (const f of FORMATS) {
        const m = s.match(f.re);
        if (!m) continue;
        let y, mo, d, hh = 0, mm = 0, ss = 0;
        if (f.iso) { [, y, mo, d, hh, mm, ss] = m.map(Number); }
        else if (f.ymd) { [, y, mo, d] = m.map(Number); }
        else if (f.mdy) { const [, a, b, yy] = m.map(Number); mo = a; d = b; y = yy; }
        // Disambiguate MM/dd vs dd/MM only when a component proves it; else skip.
        if (f.mdy && mo > 12) return null;          // it's dd/MM — ambiguous, skip
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const date = new Date(Date.UTC(y, mo - 1, d, hh || 0, mm || 0, ss || 0));
        if (Number.isNaN(date.getTime())) return null;
        return { date, jmeterFormat: f.fmt(s), hasTime: !!f.time };
    }
    return null;
}

/** ISO-8601 duration for __timeShift: recorded − reference. Signed. */
function offsetIso(recorded, reference, hasTime) {
    let sec = Math.round((recorded.getTime() - reference.getTime()) / 1000);
    const sign = sec < 0 ? '-' : '';
    sec = Math.abs(sec);
    const days = Math.floor(sec / 86400); sec -= days * 86400;
    if (!hasTime) return `${sign}P${days}D`;
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const mi = Math.floor(sec / 60); const s = sec - mi * 60;
    const t = [h ? `${h}H` : '', mi ? `${mi}M` : '', s ? `${s}S` : ''].join('');
    return `${sign}P${days}D${t ? 'T' + t : ''}`;
}

function timeShiftExpr(jmeterFormat, iso) {
    return `\${__timeShift(${jmeterFormat},,${iso},,)}`;
}

/**
 * Plan which parameterization candidates are dates to shift.
 * @param {Array} candidates  {name, value}
 * @param {Date}  reference   recording reference time
 * @param {Object} opts       run.dates: { shift?:bool, maxRelativeDays?:number }
 * @returns {{ shifts: Array<{name,value,expr,offsetDays,jmeterFormat}>, skippedAmbiguous: string[] }}
 */
function planDateShifts(candidates = [], reference = new Date(), opts = {}) {
    if (opts.shift === false) return { shifts: [], skippedAmbiguous: [] };
    const maxRel = Number.isFinite(Number(opts.maxRelativeDays)) ? Number(opts.maxRelativeDays) : 730;
    const shifts = [];
    const skippedAmbiguous = [];
    const skippedFixed = [];
    // Runtime-relative date inputs; and fields that are FIXED references we
    // must never make float (fiscal-year constants, defaults, min/max bounds).
    const RELATIVE_NAME = /date|from|to|start|end|expiry|expire|effective|due|book|schedule|visit|check|dob|birth|begin|until|period/i;
    const FIXED_NAME = /constant|fiscal|default|min\b|max\b|template|threshold/i;
    for (const c of candidates) {
        const raw = String(c.value == null ? '' : c.value).trim();
        const det = detectDate(raw);
        if (!det) {
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) skippedAmbiguous.push(c.name);
            continue;
        }
        // Shift only genuinely relative date inputs: a date-ish field name (and
        // not a fixed-reference name), OR any value carrying a time component
        // (a full datetime is almost always a live instant). This keeps fiscal
        // constants and date-shaped IDs literal.
        const nameRelative = RELATIVE_NAME.test(c.name) && !FIXED_NAME.test(c.name);
        if (!nameRelative && !det.hasTime) { if (FIXED_NAME.test(c.name)) skippedFixed.push(c.name); continue; }
        if (FIXED_NAME.test(c.name)) { skippedFixed.push(c.name); continue; }
        const offsetDays = Math.round((det.date.getTime() - reference.getTime()) / 86400000);
        if (Math.abs(offsetDays) > maxRel) continue;
        shifts.push({
            name: c.name, value: raw, offsetDays, jmeterFormat: det.jmeterFormat,
            expr: timeShiftExpr(det.jmeterFormat, offsetIso(det.date, reference, det.hasTime)),
        });
    }
    return { shifts, skippedAmbiguous, skippedFixed };
}

/** The recording's reference instant = earliest usable entry timestamp. */
function recordingReference(entries = []) {
    const times = entries
        .map(e => Date.parse(e.startedDateTime || (e.request && e.request.startedDateTime) || ''))
        .filter(Number.isFinite);
    return times.length ? new Date(Math.min(...times)) : new Date();
}

/**
 * Replace each recorded date literal with its __timeShift expression, scoped
 * to sampler send-fields (path / Argument.value / Header.value) only.
 * @returns {{ xml: string, applied: number }}
 */
function injectDateShifts(xml, shifts = []) {
    let out = xml;
    let applied = 0;
    for (const s of shifts) {
        const re = /(<stringProp\s+name="(?:HTTPSampler\.path|Argument\.value|Header\.value)">)([^<]*)(<\/stringProp>)/g;
        out = out.replace(re, (_m, open, content, close) => {
            if (!content.includes(s.value)) return _m;
            applied++;
            return open + content.split(s.value).join(s.expr) + close;
        });
    }
    return { xml: out, applied };
}

module.exports = {
    detectDate, planDateShifts, injectDateShifts, recordingReference, timeShiftExpr,
    _internal: { offsetIso },
};
