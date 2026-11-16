'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-planner-'));
process.env.KB_DATA_DIR = path.join(data, 'data');
const { createHttpServer } = require('../src/http-server');
const { demoPlan } = require('../src/engineering-demo');
const { optimize } = require('../src/engineering-planner');
const { createStubLlm } = require('./stub-llm-server');

test.after(() => fs.rmSync(data, { recursive: true, force: true }));

test('Fuyu comparison reconciles costs and each candidate respects workface capacity, resource windows and dependencies', () => {
  const input = demoPlan();
  const result = optimize(input);
  assert.equal(result.status, 'scheduled');
  assert.equal(result.cheapest.tasks.length, 130);
  assert.equal(new Set(input.tasks.filter(t => t.group === '风机工程').map(t => t.face)).size, 27);
  assert.ok(result.cheapest.cost.total < result.baseline.cost.total);
  assert.ok(result.fastest.days < result.cheapest.days);
  assert.ok(result.cheapest.meetsDeadline);
  for (const plan of [result.baseline, result.cheapest, result.fastest]) {
    const byId = new Map(plan.tasks.map(t => [t.id, t]));
    const work = new Map();
    for (const task of input.tasks) {
      const slot = byId.get(task.id);
      assert.ok(slot.startDay >= task.releaseDay);
      assert.equal(slot.endDay - slot.startDay, task.duration);
      assert.ok(task.after.every(id => byId.get(id).endDay <= slot.startDay));
      const face = task.group + '/' + task.face;
      if (!work.has(face)) work.set(face, new Set());
      for (let d = slot.startDay; d < slot.endDay; d++) {
        assert.ok(!work.get(face).has(d));
        work.get(face).add(d);
      }
    }
    for (const r of input.resources) {
      for (let d = 0; d < plan.days; d++) {
        const capacity = Math.min(r.capacity, ...(r.windows || []).filter(w => w.startDay <= d && d < w.endDay).map(w => w.capacity));
        const usage = plan.tasks.filter(t => t.startDay <= d && d < t.endDay).reduce((sum, t) => sum + (t.resources[r.id] || 0), 0);
        assert.ok(usage <= capacity);
      }
    }
    const cost = plan.cost;
    assert.equal(cost.total, cost.direct + cost.usage + cost.standby + cost.overhead);
    assert.equal(cost.overhead, input.overheadPerDay * plan.days);
  }
});

test('no candidate is advertised as meeting an impossible date or exceeding capacity', () => {
  const fixture = demoPlan();
  assert.equal(optimize({ ...fixture, deadlineDays: 1 }).status, 'deadline_impossible');
  fixture.resources[0].capacity = 0;
  const result = optimize(fixture);
  assert.equal(result.status, 'capacity_conflict');
  assert.equal(result.cheapest, null);
  assert.match(result.blocked[0], /RD-1/);
});

test('engineering HTTP endpoints validate invalid plans and provide the actual computed snapshot to the agent', async t => {
  const stub = createStubLlm({ answer: '识别到吊装资源有闲置，请在修改数量后复算。' });
  const modelPort = await stub.listen();
  const { server, service } = createHttpServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.shutdown();
    server.closeAllConnections();
    await Promise.all([stub.close(), new Promise(resolve => server.close(resolve))]);
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/engineering/';
  const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const { data: plan } = await (await fetch(base + 'demo')).json();
  const response = await post('solve', { plan });
  assert.equal(response.status, 200);
  const { data: comparison } = await response.json();
  const withCycle = structuredClone(plan);
  withCycle.tasks[0].after = [withCycle.tasks[0].id];
  const invalid = await post('solve', { plan: withCycle });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error.message, /循环依赖/);
  service.updateSettings({ llm: { baseUrl: 'http://127.0.0.1:' + modelPort, model: 'stub' } });
  const review = await post('review', { plan, question: '最贵的闲置资源是什么？' });
  assert.equal(review.status, 200);
  assert.match((await review.json()).data.answer, /吊装资源/);
  const messages = stub.state.lastBody.messages;
  const snapshot = JSON.parse(messages.at(-1).content).schedule;
  assert.equal(snapshot.cheapest.cost.total, comparison.cheapest.cost.total);
  assert.equal(snapshot.selectedTasks.length, 130);
  assert.equal(snapshot.demo, true);
});
