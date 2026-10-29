'use strict';

const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function safeName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || '未命名';
}

function nowIso() {
  return new Date().toISOString();
}

function walkFiles(dir, predicate, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.git' && entry.name !== 'images') walkFiles(file, predicate, output);
    } else if (!predicate || predicate(file)) {
      output.push(file);
    }
  }
  return output.sort((a, b) => a.localeCompare(b));
}

function copyDirectoryFiles(source, destination) {
  if (!fs.existsSync(source)) return;
  ensureDir(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectoryFiles(from, to);
    else fs.copyFileSync(from, to);
  }
}

function resolveInside(parent, child) {
  const base = path.resolve(parent);
  const resolved = path.resolve(base, child);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('路径越界: ' + child);
  }
  return resolved;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

module.exports = {
  copyDirectoryFiles,
  ensureDir,
  nowIso,
  readJson,
  resolveInside,
  safeName,
  stripAnsi,
  walkFiles,
  writeJson
};
