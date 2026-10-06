'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startChild } = require('../src/combined');

test('serve child launcher starts forward and mcp with the same entry script', () => {
  const calls = [];
  const spawnImpl = (execPath, args, options) => {
    calls.push({ execPath, args, options });
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    return child;
  };
  const opts = { spawnImpl, execPath: '/node', scriptPath: '/app/src/pilot.js' };
  startChild('forward', opts);
  startChild('archive-bridge', opts);
  startChild('mcp', opts);
  assert.deepEqual(calls.map(c => c.args), [
    ['/app/src/pilot.js', 'forward'],
    ['/app/src/pilot.js', 'archive-bridge'],
    ['/app/src/pilot.js', 'mcp'],
  ]);
  assert.ok(calls.every(c => c.options.stdio === 'inherit'));
});
