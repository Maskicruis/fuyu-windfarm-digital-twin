'use strict';

const { EventEmitter } = require('node:events');

class JobQueue extends EventEmitter {
  constructor({ concurrency = 1 } = {}) {
    super();
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.pending = [];
    this.active = new Map();
  }

  enqueue(id, run) {
    if (this.has(id)) return false;
    this.pending.push({ id, run });
    this.emit('changed', this.snapshot());
    queueMicrotask(() => this.pump());
    return true;
  }

  has(id) {
    return this.active.has(id) || this.pending.some(job => job.id === id);
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      pending: this.pending.map(job => job.id),
      active: [...this.active.keys()]
    };
  }

  pump() {
    while (this.active.size < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      const promise = Promise.resolve().then(job.run);
      this.active.set(job.id, promise);
      this.emit('changed', this.snapshot());
      promise
        .catch(error => this.emit('jobError', { id: job.id, error }))
        .finally(() => {
          this.active.delete(job.id);
          this.emit('changed', this.snapshot());
          this.pump();
        });
    }
  }
}

module.exports = { JobQueue };
