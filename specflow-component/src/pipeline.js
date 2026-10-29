'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runMineru } = require('./mineru-adapter');
const { applyCorrections, buildDocument, documentToMarkdown, toLegacyItems } = require('./transform');
const { copyDirectoryFiles, ensureDir, readJson, safeName, walkFiles, writeJson } = require('./utils');

function findArtifacts(workDir) {
  const jsonFiles = walkFiles(workDir, file => file.toLowerCase().endsWith('.json'));
  const markdownFiles = walkFiles(workDir, file => file.toLowerCase().endsWith('.md'));
  const legacyContent = jsonFiles.find(file => /_content_list\.json$/i.test(file));
  const v2Content = jsonFiles.find(file => /_content_list_v2\.json$/i.test(file));
  const contentList = legacyContent || v2Content;
  if (!contentList) throw new Error('MinerU 未生成 *_content_list.json 或 *_content_list_v2.json');
  const middle = jsonFiles.find(file => /_middle\.json$/i.test(file));
  const markdown = markdownFiles[0] || null;
  const images = markdown && fs.existsSync(path.join(path.dirname(markdown), 'images'))
    ? path.join(path.dirname(markdown), 'images')
    : null;
  return { contentList, middle, markdown, images };
}

function writePackage({ document, outputDir, sourcePath, rawMarkdownPath, imagesDir, corrections = {} }) {
  ensureDir(outputDir);
  applyCorrections(document, corrections);
  const title = safeName(document.document.title);
  if (imagesDir) copyDirectoryFiles(imagesDir, ensureDir(path.join(outputDir, 'images')));
  if (sourcePath) fs.copyFileSync(sourcePath, path.join(outputDir, title + path.extname(sourcePath).toLowerCase()));
  if (rawMarkdownPath) fs.copyFileSync(rawMarkdownPath, path.join(outputDir, 'raw.mineru.md'));
  fs.writeFileSync(path.join(outputDir, title + '.md'), documentToMarkdown(document), 'utf8');
  writeJson(path.join(outputDir, 'document.json'), document);
  writeJson(path.join(outputDir, 'view.json'), toLegacyItems(document));
  return {
    outputDir,
    documentFile: path.join(outputDir, 'document.json'),
    markdownFile: path.join(outputDir, title + '.md'),
    sourceFile: sourcePath ? path.join(outputDir, title + path.extname(sourcePath).toLowerCase()) : null
  };
}

function convertArtifacts({ id, title, sourceName, workDir, outputDir, sourcePath, corrections = {}, options = {} }) {
  const artifacts = findArtifacts(workDir);
  const rawContent = readJson(artifacts.contentList, null);
  const contentList = Array.isArray(rawContent)
    ? rawContent
    : rawContent && Array.isArray(rawContent.items)
      ? rawContent.items
      : rawContent && Array.isArray(rawContent.pages)
        ? rawContent.pages.map(page => page.items || page.blocks || [])
        : null;
  if (!Array.isArray(contentList)) throw new Error('content_list JSON 格式无效: ' + artifacts.contentList);
  const middle = artifacts.middle ? readJson(artifacts.middle, {}) : {};
  const document = buildDocument({ id, title, sourceName, contentList, middle, options });
  if (!document.items.length) throw new Error('MinerU 内容列表为空，未生成可入库内容');
  const files = writePackage({
    document,
    outputDir,
    sourcePath,
    rawMarkdownPath: artifacts.markdown,
    imagesDir: artifacts.images,
    corrections
  });
  return { document, artifacts, files };
}

async function parseFile({
  id,
  title,
  sourceName,
  inputPath,
  workDir,
  outputDir,
  executable,
  parserOptions,
  corrections,
  onProgress,
  onLog
}) {
  ensureDir(workDir);
  await runMineru({
    executable,
    inputPath,
    outputDir: workDir,
    options: parserOptions,
    onProgress,
    onLog
  });
  return convertArtifacts({
    id,
    title,
    sourceName,
    workDir,
    outputDir,
    sourcePath: inputPath,
    corrections
  });
}

module.exports = { convertArtifacts, findArtifacts, parseFile, writePackage };
