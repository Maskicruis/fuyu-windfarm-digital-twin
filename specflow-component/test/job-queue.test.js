'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JobQueue } = require('../src/job-queue');

test('runs queued jobs once and respects concurrency', async () => {
  const queue = new JobQueue({ concurrency: 1 });
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  assert.equal(queue.enqueue('a', async () => { events.push('a:start'); await gate; events.push('a:end'); }), true);
  assert.equal(queue.enqueue('a', async () => {}), false);
  assert.equal(queue.enqueue('b', async () => { events.push('b'); }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(queue.snapshot().active, ['a']);
  assert.deepEqual(queue.snapshot().pending, ['b']);
  release();
  await new Promise(resolve => queue.on('changed', state => {
    if (!state.active.length && !state.pending.length) resolve();
  }));
  assert.deepEqual(events, ['a:start', 'a:end', 'b']);
});
