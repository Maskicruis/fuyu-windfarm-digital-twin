(function () {
  'use strict';
  var pending = [], sequence = 0, busy = false;
  var maxCount = 8, maxBytes = 8 * 1024 * 1024, maxTotal = 24 * 1024 * 1024;
  var composer = document.getElementById('chatComposer');
  var list = document.getElementById('chatAttachments');
  var state = document.getElementById('chatAttachmentState');
  var picker = document.getElementById('chatImagePicker');
  var attach = document.getElementById('attachImageButton');
  var question = document.getElementById('q');
  var viewer = document.getElementById('chatImageViewer');
  var previousFocus = null;

  function escape(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function size(value) { return value >= 1024 * 1024 ? (value / (1024 * 1024)).toFixed(1) + ' MB' : Math.ceil(value / 1024) + ' KB'; }
  function message(text) { state.textContent = text || ''; }
  function imageUrl(image) { return /^\/api\/v1\/chat\/images\/img_[0-9a-f-]+$/.test(image.previewUrl || '') ? image.previewUrl : ''; }
  function render() {
    list.hidden = !pending.length;
    list.innerHTML = pending.map(function (image) {
      var status = image.status === 'uploading' ? '正在添加…' : image.status === 'error' ? image.error : size(image.size);
      return '<div class="chat-attachment ' + (image.status === 'error' ? 'error' : '') + '"><button type="button" class="attachment-thumbnail" data-preview-key="' + image.key + '" aria-label="预览 ' + escape(image.name) + '"><img src="' + escape(image.localUrl || imageUrl(image)) + '" alt="' + escape(image.name) + '"></button><span class="attachment-copy"><b>' + escape(image.name) + '</b><small>' + escape(status) + '</small></span>' + (image.status === 'error' ? '<button type="button" class="attachment-retry" data-retry-image="' + image.key + '" aria-label="重新添加图片">重试</button>' : '') + '<button type="button" class="attachment-remove" data-remove-image="' + image.key + '" aria-label="移除 ' + escape(image.name) + '"' + (busy ? ' disabled' : '') + '>×</button></div>';
    }).join('');
    attach.disabled = busy || pending.length >= maxCount;
    attach.title = pending.length >= maxCount ? '每条消息最多 8 张图片' : '添加图片 · 可粘贴或拖入';
    composer.classList.toggle('has-attachments', !!pending.length);
  }
  function releasePreview(image) { if (image.localUrl) { URL.revokeObjectURL(image.localUrl); image.localUrl = ''; } }
  async function discard(id) {
    if (!id) return;
    try { await fetch('/api/v1/chat/images/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (_) {}
  }
  async function upload(image) {
    image.status = 'uploading'; render();
    try {
      var response = await fetch('/api/v1/chat/images', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(image.name) }, body: image.file });
      var body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.error && body.error.message || '添加图片失败');
      var metadata = body.data || body;
      if (pending.indexOf(image) < 0) { await discard(metadata.id); return; }
      Object.assign(image, metadata, { status: 'ready' });
      releasePreview(image);
    } catch (error) { if (pending.indexOf(image) >= 0) { image.status = 'error'; image.error = error.message; } }
    render();
  }
  function isImage(file) { return /^image\/(png|jpeg|gif|webp)$/i.test(file.type) || (!file.type && /\.(png|jpe?g|gif|webp)$/i.test(file.name)); }
  function addFiles(files) {
    if (busy) { message('请等待当前回答完成后再添加图片。'); return; }
    var input = Array.from(files || []);
    if (!input.length) return;
    var total = pending.reduce(function (sum, image) { return sum + image.size; }, 0), added = [], errors = [];
    input.forEach(function (file) {
      if (!isImage(file)) { errors.push('支持 PNG、JPEG、GIF、WebP 图片'); return; }
      if (pending.length >= maxCount) { errors.push('每条消息最多 8 张图片'); return; }
      if (file.size > maxBytes) { errors.push('每张图片不能超过 8 MB'); return; }
      if (total + file.size > maxTotal) { errors.push('图片总大小不能超过 24 MB'); return; }
      var image = { key: ++sequence, name: file.name || '粘贴图片.png', size: file.size, file: file, localUrl: URL.createObjectURL(file), status: 'uploading' };
      total += file.size; pending.push(image); added.push(image);
    });
    message(Array.from(new Set(errors)).join('；')); render();
    added.forEach(upload);
    question.focus();
  }
  function remove(key) {
    if (busy) return;
    var index = pending.findIndex(function (image) { return image.key === Number(key); });
    if (index < 0) return;
    var image = pending.splice(index, 1)[0]; releasePreview(image); discard(image.id); message(''); render();
  }
  function preview(url, name) {
    if (!url) return;
    previousFocus = document.activeElement;
    document.getElementById('chatImageFull').src = url;
    document.getElementById('chatImageFull').alt = name || '图片预览';
    document.getElementById('chatImageTitle').textContent = name || '图片预览';
    viewer.hidden = false; document.getElementById('closeChatImage').focus();
  }
  function closePreview() {
    if (viewer.hidden) return;
    viewer.hidden = true; document.getElementById('chatImageFull').removeAttribute('src');
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  }
  attach.addEventListener('click', function () { picker.click(); });
  picker.addEventListener('change', function () { addFiles(picker.files); picker.value = ''; });
  composer.addEventListener('paste', function (event) {
    if (event.target !== question) return;
    var data = event.clipboardData;
    if (!data) return;
    var files = Array.from(data.items || []).filter(function (item) { return item.kind === 'file'; }).map(function (item) { return item.getAsFile(); }).filter(Boolean);
    if (!files.length) files = Array.from(data.files || []);
    if (!files.length) return; // Let ordinary text paste keep its native behavior.
    event.preventDefault(); addFiles(files);
    var text = data.getData('text/plain');
    if (text && !busy) { question.setRangeText(text, question.selectionStart, question.selectionEnd, 'end'); question.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  var dragDepth = 0;
  ['dragenter', 'dragover'].forEach(function (type) {
    composer.addEventListener(type, function (event) {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
      event.preventDefault(); if (type === 'dragenter') dragDepth++;
      composer.classList.add('image-dragging'); event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    });
  });
  composer.addEventListener('dragleave', function (event) { event.preventDefault(); if (--dragDepth <= 0) composer.classList.remove('image-dragging'); });
  composer.addEventListener('drop', function (event) { event.preventDefault(); dragDepth = 0; composer.classList.remove('image-dragging'); if (event.dataTransfer) addFiles(event.dataTransfer.files); });
  // Prevent Chromium from navigating away when an image is dropped outside the composer.
  document.addEventListener('dragover', function (event) { if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', function (event) { if (event.dataTransfer && event.dataTransfer.files.length) event.preventDefault(); });
  list.addEventListener('click', function (event) {
    var removeButton = event.target.closest('[data-remove-image]'), retry = event.target.closest('[data-retry-image]'), thumbnail = event.target.closest('[data-preview-key]');
    if (removeButton) remove(removeButton.dataset.removeImage);
    if (retry && !busy) { var failed = pending.find(function (image) { return image.key === Number(retry.dataset.retryImage); }); if (failed) upload(failed); }
    if (thumbnail) { var image = pending.find(function (image) { return image.key === Number(thumbnail.dataset.previewKey); }); if (image) preview(image.localUrl || imageUrl(image), image.name); }
  });
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-chat-image]');
    if (button) preview(imageUrl({ previewUrl: button.dataset.chatImage }), button.dataset.imageName);
    if (event.target.closest('[data-close-chat-image]')) closePreview();
  });
  document.addEventListener('keydown', function (event) {
    if (viewer.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closePreview(); }
    if (event.key === 'Tab') { event.preventDefault(); document.getElementById('closeChatImage').focus(); }
  }, true);
  window.SpecFlowChatImages = {
    addFiles: addFiles,
    count: function () { return pending.length; },
    ready: function () {
      if (pending.some(function (image) { return image.status === 'uploading'; })) { message('图片正在添加，请稍候。'); return false; }
      if (pending.some(function (image) { return image.status === 'error'; })) { message('请重试或移除添加失败的图片。'); return false; }
      return true;
    },
    take: function () {
      var images = pending.map(function (image) { releasePreview(image); return { id: image.id, name: image.name, size: image.size, mime: image.mime, width: image.width, height: image.height, previewUrl: image.previewUrl }; });
      pending = []; message(''); render(); return images;
    },
    restore: function (images) { images.forEach(function (image) { pending.push(Object.assign({}, image, { key: ++sequence, status: 'ready' })); }); render(); },
    clear: function () { pending.slice().forEach(function (image) { remove(image.key); }); message(''); },
    setBusy: function (value) { busy = !!value; render(); },
    turnHtml: function (images) {
      if (!images || !images.length) return '';
      return '<div class="chat-turn-images">' + images.map(function (image) { var url = imageUrl(image); return url ? '<button type="button" data-chat-image="' + escape(url) + '" data-image-name="' + escape(image.name) + '" aria-label="预览 ' + escape(image.name) + '"><img src="' + escape(url) + '" alt="' + escape(image.name) + '" loading="lazy"></button>' : ''; }).join('') + '</div>';
    }
  };
  render();
})();
