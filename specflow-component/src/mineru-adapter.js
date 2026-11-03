'use strict';

const { spawn } = require('node:child_process');
const fs=require('node:fs'),path=require('node:path');

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

const activeChildren=new Set();
function stopMineru(){for(const child of activeChildren){if(process.platform==='win32'&&child.pid)spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();}activeChildren.clear();}
function runMineru({ executable, inputPath, outputDir, options, onProgress, onLog }) {
  const normalized = normalizeOptions(options);
  const args = buildArgs(inputPath, outputDir, normalized);
  const bundledEntry=path.join(path.dirname(executable),'..','run_mineru.py');
  if(path.basename(executable).toLowerCase()==='python.exe'&&fs.existsSync(bundledEntry)){
   if(normalized.backend!=='pipeline'||normalized.parseFormula)throw Error('内置离线引擎提供 pipeline 中文OCR、版面与表格解析。高级公式或VLM请指定相应的外部引擎。');
   args.unshift(bundledEntry);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      env: Object.assign(withLocalProxyBypass(), { MINERU_MODEL_SOURCE: normalized.modelSource })
    });
    activeChildren.add(child);child.once('close',()=>activeChildren.delete(child));
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

module.exports = { buildArgs, normalizeOptions, runMineru, stopMineru, withLocalProxyBypass };
