'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, readJson, writeJson } = require('./utils');

let runningAsSea = false;
try {
  runningAsSea = require('node:sea').isSea();
} catch {
  runningAsSea = false;
}

const ROOT = process.env.KB_ROOT
  ? path.resolve(process.env.KB_ROOT)
  : runningAsSea
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, '..');

const DATA = path.resolve(process.env.KB_DATA_DIR || path.join(ROOT, 'data'));
const SETTINGS_FILE = path.join(DATA, 'settings.json');

function mineruCandidates(root = ROOT, env = process.env) {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const executable = process.platform === 'win32' ? 'mineru.exe' : 'mineru';
  const candidates = [];
  if (env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'knowledge-base-tool', 'mineru-venv', binDir, executable));
  }
  candidates.push(path.join(root, '.mineru-venv', binDir, executable));
  return candidates;
}

function findMineru(env = process.env, root = ROOT) {
  if (env.KB_MINERU) return env.KB_MINERU;
  const local = mineruCandidates(root, env).find(candidate => fs.existsSync(candidate));
  if (local) return local;
  return process.platform === 'win32' ? 'mineru.exe' : 'mineru';
}

function preferDiscoveredMineru(configured, discovered = findMineru()) {
  const value = String(configured || '').trim();
  if (!value || ['mineru', 'mineru.exe'].includes(value.toLowerCase())) return discovered;
  return value;
}

const DEFAULTS = Object.freeze({
  library: path.join(DATA, 'library'),
  port: 8790,
  host: '127.0.0.1',
  mineru: findMineru(),
  parser: {
    backend: 'pipeline',
    method: 'auto',
    language: 'ch',
    parseTables: true,
    parseFormula: false,
    modelSource: 'modelscope'
  },
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
    visionModel: '',
    embeddingModel: '',
    timeoutMs: 120000
  }
});

function normalizeSettings(value = {}) {
  const parser = Object.assign({}, DEFAULTS.parser, value.parser || {});
  const llm = Object.assign({}, DEFAULTS.llm, value.llm || {});
  return {
    library: path.resolve(String(value.library || DEFAULTS.library)),
    port: Number(value.port || DEFAULTS.port),
    host: String(value.host || DEFAULTS.host),
    mineru: preferDiscoveredMineru(value.mineru, DEFAULTS.mineru),
    parser,
    llm
  };
}

function loadSettings() {
  ensureDir(DATA);
  const stored = readJson(SETTINGS_FILE, {});
  const normalized = normalizeSettings(stored);
  if (stored.mineru && stored.mineru !== normalized.mineru) writeJson(SETTINGS_FILE, normalized);
  return normalized;
}

function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  writeJson(SETTINGS_FILE, normalized);
  return normalized;
}

function executableAvailable(command) {
  if (!command) return false;
  if (path.isAbsolute(command) || command.includes(path.sep)) return fs.existsSync(command);
  const pathValue = process.env.PATH || '';
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return pathValue.split(path.delimiter).some(dir => suffixes.some(ext => fs.existsSync(path.join(dir, command + ext))));
}

module.exports = {
  DATA,
  DEFAULTS,
  ROOT,
  SETTINGS_FILE,
  executableAvailable,
  findMineru,
  loadSettings,
  mineruCandidates,
  normalizeSettings,
  preferDiscoveredMineru,
  saveSettings
};
