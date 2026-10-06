'use strict';

const { spawn } = require('node:child_process');

function startChild(role, { spawnImpl = spawn, execPath = process.execPath, scriptPath }) {
  return spawnImpl(execPath, [scriptPath, role], {
    env: process.env,
    stdio: 'inherit',
  });
}

async function runCombined(options = {}) {
  const scriptPath = options.scriptPath || require.resolve('./pilot');
  const children = [
    startChild('forward', { ...options, scriptPath }),
    startChild('archive-bridge', { ...options, scriptPath }),
    startChild('mcp', { ...options, scriptPath }),
  ];
  let stopping = false;
  const stopAll = signal => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (!child.killed) child.kill(signal);
  };
  process.once('SIGTERM', () => stopAll('SIGTERM'));
  process.once('SIGINT', () => stopAll('SIGINT'));
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (child, code, signal) => {
      if (settled) return;
      settled = true;
      stopAll('SIGTERM');
      if (code === 0 && stopping) { resolve(); return; }
      const error = new Error('combined_child_exit:' + child + ':' + (code ?? 'null') + ':' + (signal || 'none'));
      error.code = code;
      reject(error);
    };
    children[0].once('exit', (code, signal) => finish('forward', code, signal));
    children[1].once('exit', (code, signal) => finish('archive-bridge', code, signal));
    children[2].once('exit', (code, signal) => finish('mcp', code, signal));
    children[0].once('error', reject);
    children[1].once('error', reject);
    children[2].once('error', reject);
  });
}

module.exports = { runCombined, startChild };
