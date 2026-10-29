'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, readJson, writeJson } = require('./utils');

const IMAGE_LIMITS = Object.freeze({ maxImages: 8, maxImageBytes: 8 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024, maxDimension: 8192 });
const IMAGE_ID = /^img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_IMAGE_QUESTION = '请分析这些图片中的内容。';

class ImageInputError extends Error {
  constructor(message, code = 'INVALID_IMAGE', status = 400) { super(message); this.code = code; this.status = status; }
}

// Inspect actual bytes rather than trusting a file extension or client MIME type.
function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImageInputError('图片内容为空');
  if (buffer.length > IMAGE_LIMITS.maxImageBytes) throw new ImageInputError('每张图片不能超过 8 MB', 'IMAGE_TOO_LARGE', 413);
  let mime = '', extension = '', width = 0, height = 0;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'; extension = '.png'; width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else if (buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) {
    mime = 'image/gif'; extension = '.gif'; width = buffer.readUInt16LE(6); height = buffer.readUInt16LE(8);
  } else if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp'; extension = '.webp';
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + buffer.readUIntLE(24, 3); height = 1 + buffer.readUIntLE(27, 3); }
    else if (kind === 'VP8 ' && buffer[23] === 157 && buffer[24] === 1 && buffer[25] === 42) { width = buffer.readUInt16LE(26) & 0x3fff; height = buffer.readUInt16LE(28) & 0x3fff; }
    else if (kind === 'VP8L' && buffer[20] === 47) { const bits = buffer.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  } else if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216) {
    mime = 'image/jpeg'; extension = '.jpg';
    for (let offset = 2; offset + 3 < buffer.length;) {
      if (buffer[offset] !== 255) break;
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!mime || !width || !height) throw new ImageInputError('请使用有效的 PNG、JPEG、GIF 或 WebP 图片');
  if (width > IMAGE_LIMITS.maxDimension || height > IMAGE_LIMITS.maxDimension) throw new ImageInputError('图片的宽度或高度不能超过 8192 像素', 'IMAGE_DIMENSIONS_EXCEEDED', 413);
  return { mime, extension, width, height, size: buffer.length };
}

function imageIds(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) throw new ImageInputError('images 必须是图片 ID 数组');
  if (images.length > IMAGE_LIMITS.maxImages) throw new ImageInputError('每条消息最多添加 8 张图片', 'TOO_MANY_IMAGES');
  return [...new Set(images.map(image => {
    const id = typeof image === 'string' ? image : image && image.id;
    if (!IMAGE_ID.test(String(id || ''))) throw new ImageInputError('图片 ID 无效');
    return id;
  }))];
}

class ChatImages {
  constructor(dataDir) { this.directory = ensureDir(path.join(dataDir, 'chat-images')); }
  upload(buffer, filename) {
    const info = inspectImage(buffer);
    const id = 'img_' + crypto.randomUUID();
    const name = path.basename(String(filename || '图片' + info.extension).replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').slice(0, 160) || '图片' + info.extension;
    const metadata = { id, name, ...info, createdAt: new Date().toISOString(), previewUrl: '/api/v1/chat/images/' + id };
    fs.writeFileSync(path.join(this.directory, id + info.extension), buffer, { flag: 'wx' });
    writeJson(path.join(this.directory, id + '.json'), metadata);
    return metadata;
  }
  get(id) {
    if (!IMAGE_ID.test(String(id || ''))) throw new ImageInputError('图片 ID 无效');
    const metadata = readJson(path.join(this.directory, id + '.json'), null);
    if (!metadata || !['.png', '.jpg', '.gif', '.webp'].includes(metadata.extension)) throw new ImageInputError('图片不存在，请重新添加', 'IMAGE_NOT_FOUND', 404);
    const file = path.join(this.directory, id + metadata.extension);
    if (!fs.existsSync(file)) throw new ImageInputError('图片不存在，请重新添加', 'IMAGE_NOT_FOUND', 404);
    return { metadata, file };
  }
  resolve(images) {
    const result = imageIds(images).map(id => this.get(id).metadata);
    if (result.reduce((total, item) => total + item.size, 0) > IMAGE_LIMITS.maxTotalBytes) throw new ImageInputError('每条消息的图片总大小不能超过 24 MB', 'IMAGES_TOO_LARGE', 413);
    return result;
  }
  hydrate(images) {
    return this.resolve(images).map(image => ({ ...image, dataUrl: 'data:' + image.mime + ';base64,' + fs.readFileSync(this.get(image.id).file).toString('base64') }));
  }
  remove(id) {
    const { file } = this.get(id);
    fs.unlinkSync(file); fs.unlinkSync(path.join(this.directory, id + '.json'));
    return { id };
  }
}

function userContent(text, images = []) {
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } }))];
}

function contentText(content) {
  return Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : String(content || '');
}

module.exports = { ChatImages, ImageInputError, IMAGE_LIMITS, DEFAULT_IMAGE_QUESTION, inspectImage, imageIds, userContent, contentText };
