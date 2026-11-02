'use strict';
const { spawn } = require('child_process');

/** Run a command and resolve with its stdout. Rejects with a stderr excerpt. */
function run(cmd, args, { timeoutMs = 60_000, maxBuffer = 64 * 1024 * 1024, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
    const out = [];
    let outLen = 0;
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen > maxBuffer) child.kill('SIGKILL');
      else out.push(d);
    });
    child.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd}: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
      const msg = err.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      reject(new Error(`${cmd} failed (${signal || code}): ${msg || 'no output'}`));
    });
  });
}

async function runJson(cmd, args, opts) {
  return JSON.parse(await run(cmd, args, opts));
}

module.exports = { run, runJson };
