'use strict';
/**
 * steering.js — talk to the agent WHILE it runs, and change its course.
 *
 * The UI appends operator messages to a per-run steering file; the runner
 * polls it at every decision checkpoint (between JMeter iterations, before
 * each AI round, before each replan) and applies what it can:
 *
 *   "protect <name-or-path>"   → the sampler may never be disabled (instant —
 *                                the business guard reads it live)
 *   "disable <name-or-path>"   → folded at the next repair checkpoint and in
 *                                every regeneration this run
 *   anything else              → operator guidance, injected verbatim into
 *                                the AI escalation prompt and replan context
 *   ending in "?"              → question — the agent answers in the chat
 *                                with its current diagnosis and plan
 *
 * The file is the whole protocol (JSON lines array); no sockets, no state
 * server — same pony-tail rules as the rest of the app. Every applied
 * message is acknowledged in the chat so the operator sees exactly what
 * changed course.
 */
const fs = require('fs');
const path = require('path');

function steeringFileFor(root, runId) {
    return path.join(root, '.perfscript-state', `steering-${runId}.json`);
}

function appendMessage(file, message) {
    const list = readAll(file);
    list.push({ role: 'user', at: new Date().toISOString(), ...message });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
    return list.length;
}

function readAll(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || []; }
    catch { return []; }
}

/** Cursor-based read: returns messages the runner hasn't consumed yet. */
function readNewMessages(file, cursor = 0) {
    const list = readAll(file);
    return { messages: list.slice(cursor), nextCursor: list.length };
}

const PROTECT_RE = /^\s*(?:protect|keep|dont[' ]?touch)\s+(.+)$/i;
const DISABLE_RE = /^\s*(?:disable|fold|skip|drop)\s+(.+)$/i;

/**
 * Classify one operator message into an actionable command.
 * @returns {{kind:'protect'|'disable'|'question'|'guidance', pattern?:string, text:string}}
 */
function parseCommand(text) {
    const t = String(text || '').trim();
    let m = t.match(PROTECT_RE);
    if (m) return { kind: 'protect', pattern: m[1].trim(), text: t };
    m = t.match(DISABLE_RE);
    if (m) return { kind: 'disable', pattern: m[1].trim(), text: t };
    if (/\?\s*$/.test(t)) return { kind: 'question', text: t };
    return { kind: 'guidance', text: t };
}

/**
 * Runner-side poller. Holds the cursor; on each poll() classifies fresh
 * messages and returns them for the caller to apply. Pure I/O — application
 * lives in the runner where the guard/runCfg are in scope.
 */
function createSteeringChannel({ file, onLog = () => {} } = {}) {
    let cursor = 0;
    const active = !!file;
    return {
        active,
        poll() {
            if (!active) return [];
            const { messages, nextCursor } = readNewMessages(file, cursor);
            cursor = nextCursor;
            return messages
                .filter(m => m && m.role === 'user' && m.text)
                .map(m => parseCommand(m.text));
        },
        say(text) {
            // Agent side of the conversation — [chat] prefix is the UI contract.
            onLog(`[chat] agent: ${text}`);
        },
    };
}

module.exports = { steeringFileFor, appendMessage, readNewMessages, parseCommand, createSteeringChannel };
