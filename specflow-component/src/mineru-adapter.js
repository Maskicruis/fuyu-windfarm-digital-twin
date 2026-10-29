'use strict';

const { spawn } = require('node:child_process');

const BACKENDS = new Set([
  'pipeline',
  'vlm',
  'hybrid',
  'vlm-engine',
  'hybrid-engine',
  'vlm-http-client',
  'hybrid-http-client',
  'hybrid-auto-engine'
]);
const METHODS = new Set(['auto', 'txt', 'ocr']);

function normalizeOptions(options = {}) {
  const backend = String(options.backend || 'pipeline');
  const method = String(options.method || 'auto');
  if (!BACKENDS.has(backend)) throw new Error('不支持的 MinerU backend: ' + backend);
  if (!METHODS.has(method)) throw new Error('不支持的 MinerU method: ' + method);
  return {
    backend,
    method,
    language: String(options.language || 'ch'),
    parseTables: options.parseTables !== false,
    parseFormula: options.parseFormula === true,
    modelSource: String(options.modelSource || 'modelscope'),
    effort: options.effort ? String(options.effort) : ''
  };
}

function buildArgs(inputPath, outputDir, options = {}) {
  const o = normalizeOptions(options);
  const args = [
    '-p', inputPath,
    '-o', outputDir,
    '-b', o.backend,
    '-m', o.method,
    '-t', String(o.parseTables),
    '-f', String(o.parseFormula),
    '-l', o.language
  ];
  if (o.effort && o.backend.startsWith('hybrid')) {
    args.push('--effort', o.effort);
  }
  return args;
}

function withLocalProxyBypass(env = process.env) {
  const entries = [env.NO_PROXY, env.no_proxy]
    .filter(Boolean)
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!entries.includes(host)) entries.push(host);
  }
  const noProxy = entries.join(',');
  return Object.assign({}, env, { NO_PROXY: noProxy, no_proxy: noProxy });
}

function runMineru({ executable, inputPath, outputDir, options, onProgress, onLog }) {
  const normalized = normalizeOptions(options);
  const args = buildArgs(inputPath, outputDir, normalized);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      env: Object.assign(withLocalProxyBypass(), { MINERU_MODEL_SOURCE: normalized.modelSource })
    });
    let output = '';
    let maximum = 0;
    let lastEmission = 0;
    const consume = chunk => {
      output += chunk.toString();
      if (output.length > 200000) output = output.slice(-100000);
      const percentages = chunk.toString().match(/(?:^|\D)(\d{1,3})%/g) || [];
      for (const match of percentages) maximum = Math.max(maximum, Number(match.match(/\d+/)[0]));
      if (onProgress && percentages.length) onProgress(Math.min(100, maximum));
      if (onLog && Date.now() - lastEmission > 500) {
        lastEmission = Date.now();
        onLog(output.slice(-1200));
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', reject);
    child.once('close', code => {
      if (onLog) onLog(output.slice(-1200));
      if (code === 0) resolve({ output, args });
      else reject(new Error('MinerU 退出码 ' + code + '\n' + output.slice(-3000)));
    });
  });
}

module.exports = { buildArgs, normalizeOptions, runMineru, withLocalProxyBypass };
