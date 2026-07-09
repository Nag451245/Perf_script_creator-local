'use strict';

const { spawn } = require('child_process');

function killPlanForPid(pid, platform = process.platform) {
    if (!pid) return { command: null, args: [], signal: null };
    if (platform === 'win32') {
        return {
            command: 'taskkill',
            args: ['/pid', String(pid), '/T', '/F'],
            signal: null,
        };
    }
    return { command: null, args: [], signal: 'SIGTERM' };
}

function cancelChildProcess(child, platform = process.platform) {
    if (!child || !child.pid) return { ok: false, error: 'no active run' };
    const plan = killPlanForPid(child.pid, platform);
    if (plan.command) {
        const killer = spawn(plan.command, plan.args, { stdio: 'ignore' });
        killer.on('error', () => {
            try { child.kill('SIGTERM'); } catch { /* child may have exited */ }
        });
        return { ok: true, plan };
    }
    try {
        child.kill(plan.signal || 'SIGTERM');
        return { ok: true, plan };
    } catch (e) {
        return { ok: false, error: e.message, plan };
    }
}

module.exports = { killPlanForPid, cancelChildProcess };
