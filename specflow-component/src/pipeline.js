'use strict';

const fs = require('node:fs');
const {Worker}=require('node:worker_threads');
const path = require('node:path');
const { runMineru, stopMineru } = require('./mineru-adapter');
const { applyCorrections, buildDocument, documentToMarkdown, toLegacyItems } = require('./transform');
const { copyDirectoryFiles, ensureDir, readJson, safeName, walkFiles, writeJson } = require('./utils');
const {workerJob}=require('./worker-job');

const activeWorkers=new Set();
function track(worker){activeWorkers.add(worker);worker.once('exit',()=>activeWorkers.delete(worker));return worker;}
async function stopParsing(){await Promise.all([stopMineru(),...Array.from(activeWorkers,w=>w.terminate())]);}
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
  if (sourcePath) {const destination=path.join(outputDir,title+path.extname(sourcePath).toLowerCase());if(path.resolve(sourcePath)!==path.resolve(destination))fs.copyFileSync(sourcePath,destination);}
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
  checkpointDir,
  outputDir,
  executable,
  parserOptions,
  nativeOnly=false,
  corrections,
  onProgress,
  onLog,
  onStatus
}) {
  ensureDir(workDir);
  if (parserOptions?.method !== 'ocr') {
    const document = await (async()=>{
      const worker=track(new Worker(path.join(__dirname,'pdf-text-worker.js'),{workerData:{id,title,sourceName,inputPath,outputDir,corrections}}));
      return workerJob(worker,{onMessage:m=>{if(m.progress!=null)onProgress?.(m.progress);}});
    })().catch(error=>{onLog?.('文字层无法直接读取，将使用 OCR：'+error.message);return null;});
    if(document)return document;
    onLog?.('扫描件或文字层不完整，转入 MinerU OCR。');
  }
  if(nativeOnly)return {needsOCR:true};
  const attemptDir=ensureDir(path.join(workDir,'a-'+require('node:crypto').randomBytes(6).toString('hex')));
  const bundled=path.basename(executable||'').toLowerCase()==='python.exe'&&fs.existsSync(path.join(path.dirname(executable),'../run_mineru.py'));
  // The user's title remains in metadata; native tools only see a short ASCII name.
  const parserInput=bundled?path.join(workDir,'input.pdf'):inputPath;
  if(parserInput!==inputPath){const temporary=parserInput+'.tmp';try{await fs.promises.copyFile(inputPath,temporary);await fs.promises.rename(temporary,parserInput);}finally{await fs.promises.rm(temporary,{force:true});}}
  await runMineru({
    executable,
    inputPath:parserInput,
    outputDir: attemptDir,
    checkpointDir:ensureDir(checkpointDir||path.join(workDir,'checkpoints')),
    options: parserOptions,
    onProgress,
    onLog,
    onStatus
  });
  onStatus?.({phase:'打包解析内容与原文坐标'});
  const worker=track(new Worker(path.join(__dirname,'package-worker.js'),{workerData:{id,title,sourceName,workDir:attemptDir,outputDir,inputPath,corrections}}));
  return workerJob(worker);
}

module.exports = { convertArtifacts, findArtifacts, parseFile, writePackage, stopParsing };
