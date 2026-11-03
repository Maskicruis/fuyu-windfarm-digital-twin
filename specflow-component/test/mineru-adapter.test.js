'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildArgs, withLocalProxyBypass } = require('../src/mineru-adapter');
const { mineruCandidates, preferDiscoveredMineru } = require('../src/config');
const { runMineru } = require('../src/mineru-adapter');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

test('layout and OCR window percentages never masquerade as whole-document completion', async () => {
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const progress=[],logs=[];
  const operation=runMineru({executable:'fake-mineru',inputPath:'input.pdf',outputDir:'output',onProgress:p=>progress.push(p),onLog:l=>logs.push(l),spawnProcess:()=>child});
  child.stderr.write('Layout Predict: 100% 8/8\rOCR-rec Predict: 78% 156/200\r');
  child.stderr.write('OCR-rec Predict: 100% 200/200\rLayout Predict: 25% 2/8\r');
  child.emit('close',0);
  await operation;
  assert.ok(progress.length>0);
  assert.ok(progress.every(p=>p===null));
  assert.match(logs.at(-1),/78% 156\/200/);
});

test('builds explicit MinerU arguments without a shell command string', () => {
  assert.deepEqual(buildArgs('input.pdf', 'output', {
    backend: 'hybrid-engine',
    method: 'auto',
    language: 'ch',
    parseTables: true,
    parseFormula: false,
    effort: 'high'
  }), [
    '-p', 'input.pdf', '-o', 'output', '-b', 'hybrid-engine', '-m', 'auto',
    '-t', 'true', '-f', 'false', '-l', 'ch', '--effort', 'high'
  ]);
});

test('rejects unknown MinerU backends before spawning', () => {
  assert.throws(() => buildArgs('input.pdf', 'output', { backend: 'shell-command' }), /不支持/);
});

test('bypasses proxies for the local MinerU API without discarding existing hosts', () => {
  const env = withLocalProxyBypass({ NO_PROXY: 'internal.example', HTTP_PROXY: 'http://proxy' });
  assert.equal(env.HTTP_PROXY, 'http://proxy');
  assert.deepEqual(env.NO_PROXY.split(','), ['internal.example', '127.0.0.1', 'localhost', '::1']);
  assert.equal(env.no_proxy, env.NO_PROXY);
});

test('prefers the per-user ASCII-safe MinerU runtime over a project-local environment', () => {
  const candidates = mineruCandidates('C:\\project', { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' });
  assert.match(candidates[0], /knowledge-base-tool/);
  assert.match(candidates[0], /mineru-venv/);
  assert.match(candidates[1], /project/);
});

test('migrates the legacy bare MinerU setting but keeps a custom executable path', () => {
  const discovered = 'C:\\runtime\\mineru.exe';
  assert.equal(preferDiscoveredMineru('mineru.exe', discovered), discovered);
  assert.equal(preferDiscoveredMineru('mineru', discovered), discovered);
  assert.equal(preferDiscoveredMineru('D:\\custom\\mineru.exe', discovered), 'D:\\custom\\mineru.exe');
});
