'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const HORIZON = 1800;
const LIMIT = 240;
const groups = new Set(['风机工程', '场内交通', '集电线路', '升压站', '联合调试']);
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'INVALID_PLAN' });
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(label + '须为对象。');
  return value;
};
const list = (value, label, max, min = 0) => {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw invalid(label + '须包含 ' + min + ' 至 ' + max + ' 条记录。');
  return value;
};
const integer = (value, label, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(label + '须为 ' + min + ' 至 ' + max + ' 的整数。');
  return value;
};
const label = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw invalid(name + '须为 1 至 80 字。');
  return value.trim();
};
const id = (value, name) => {
  if (typeof value !== 'string' || !/^[\w-]{1,40}$/.test(value)) throw invalid(name + '须使用字母、数字、下划线或短横线。');
  return value;
};
const amount = (value, name) => {
  if (!Number.isFinite(value) || value < 0 || value > 1e8 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001)
    throw invalid(name + '须为 0 至 1 亿的金额，最多两位小数。');
  return Math.round(value * 100);
};

function prepare(input) {
  object(input, '计划');
  const title = label(input.name, '方案名称');
  const startDate = input.startDate ?? '';
  if (startDate && (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
    !Number.isFinite(Date.parse(startDate)) || new Date(startDate).toISOString().slice(0, 10) !== startDate))
    throw invalid('计划起算日期须为有效的 YYYY-MM-DD。');
  const overhead = amount(input.overheadPerDay ?? 0, '现场管理费');
  const deadline = integer(input.deadlineDays ?? 0, '目标工期', 0, HORIZON);
  const asOf = integer(input.asOfDay ?? 0, '进度截点', 0, HORIZON - 1);
  const resources = list(input.resources, '资源', 24, 1).map(row => {
    object(row, '资源');
    const name = label(row.name, '资源名称');
    const capacity = integer(row.capacity, name + '数量', 0, 999);
    const availability = new Uint16Array(HORIZON).fill(capacity);
    for (const w of list(row.windows ?? [], name + '产能窗口', 40)) {
      object(w, '产能窗口');
      const start = integer(w.startDay, '窗口起始日', 0, HORIZON - 1);
      const end = integer(w.endDay, '窗口结束日（不含）', start + 1, HORIZON);
      const limit = integer(w.capacity, '窗口内产能', 0, capacity);
      for (let day = start; day < end; day++) availability[day] = Math.min(availability[day], limit);
    }
    return { id: id(row.id, '资源编号'), name, capacity, availability,
      daily: amount(row.dailyCost ?? 0, name + '使用单价'), standby: amount(row.standbyCost ?? 0, name + '闲置单价') };
  });
  const resourceIndex = new Map(resources.map((r, i) => [r.id, i]));
  if (resourceIndex.size !== resources.length) throw invalid('资源编号重复。');
  const tasks = list(input.tasks, '工序', LIMIT, 1).map(row => {
    object(row, '工序');
    const name = label(row.name, '工序名称');
    if (!groups.has(row.group)) throw invalid(name + '所属专业无效。');
    const demand = Object.entries(object(row.demand ?? {}, name + '资源需求')).map(([key, quantity]) => {
      if (!resourceIndex.has(key)) throw invalid(name + '引用了不存在的资源 ' + key + '。');
      return [resourceIndex.get(key), integer(quantity, name + '资源需求', 1, 999)];
    });
    const duration = integer(row.duration, name + '工期', 1, 365);
    const direct = amount(row.directCost ?? 0, name + '固定成本');
    let actualStart = null, actualEnd = null, remaining = duration;
    if (row.progress != null) {
      const progress = object(row.progress, name + '进度');
      actualStart = integer(progress.startDay, name + '实际开工日', 0, asOf);
      if (progress.endDay != null) {
        actualEnd = integer(progress.endDay, name + '实际完工日', actualStart + 1, asOf);
        remaining = 0;
      } else {
        remaining = integer(progress.remainingDays, name + '预计剩余工期', 1, 365);
      }
    }
    return { id: id(row.id, '工序编号'), name, group: row.group, face: label(row.face, '工作面'), demand, duration: remaining, direct,
      actualStart, actualEnd, billedDays: remaining + (actualStart == null ? 0 : (actualEnd ?? asOf) - actualStart),
      release: integer(row.releaseDay ?? 0, name + '最早开工日', 0, HORIZON - 1),
      after: [...new Set(list(row.after ?? [], name + '前置工序', LIMIT).map(value => id(value, '前置工序编号')))],
      next: [] };
  });
  const byId = new Map(tasks.map((task, i) => [task.id, i]));
  if (byId.size !== tasks.length) throw invalid('工序编号重复。');
  for (const [i, task] of tasks.entries()) {
    task.after = task.after.map(key => {
      if (!byId.has(key)) throw invalid(task.id + '的前置工序 ' + key + ' 不存在。');
      const previous = byId.get(key);
      tasks[previous].next.push(i);
      return previous;
    });
  }
  const pending = tasks.map(task => task.after.length);
  const ready = tasks.flatMap((_, i) => pending[i] ? [] : [i]);
  for (let i = 0; i < ready.length; i++)
    for (const next of tasks[ready[i]].next) if (--pending[next] === 0) ready.push(next);
  if (ready.length !== tasks.length) throw invalid('前置工序存在循环依赖，请检查任务关系。');
  let lowerDays = 0;
  for (const i of ready) {
    const task = tasks[i];
    if (task.actualStart != null && task.after.some(p => tasks[p].actualEnd == null || tasks[p].actualEnd > task.actualStart))
      throw invalid(task.id + ' 的实际开工早于前置工序实际完工，请核对进度记录。');
    task.earliestFinish = task.actualEnd ??
      (Math.max(asOf, task.release, ...task.after.map(p => tasks[p].earliestFinish)) + task.duration);
    lowerDays = Math.max(lowerDays, task.earliestFinish);
  }
  for (const i of ready.reverse()) {
    const task = tasks[i];
    task.tail = task.duration + Math.max(0, ...task.next.map(n => tasks[n].tail));
  }
  const directCost = tasks.reduce((sum, t) => sum + t.direct, 0);
  const usageCost = tasks.reduce((sum, t) => sum + t.demand.reduce((c, [r, n]) => c + n * t.billedDays * resources[r].daily, 0), 0);
  if (directCost + usageCost >= Number.MAX_SAFE_INTEGER / 2) throw invalid('本方案金额超出可靠计算范围。');
  return { title, startDate: startDate || '', deadline, asOf, overhead, resources, tasks, directCost, usageCost, lowerDays, demo: input.demo === true };
}

function schedule(plan, priorities) {
  const { tasks, resources } = plan;
  const pending = tasks.map(task => task.after.length);
  const ready = tasks.flatMap((_, i) => pending[i] ? [] : [i]);
  const loads = resources.map(() => new Uint32Array(HORIZON));
  const faces = new Map(plan.tasks.map(t => [t.group + '|' + t.face, null]));
  const starts = [], ends = [], waits = [], blockers = [];
  const parallel = new Uint16Array(HORIZON);
  let days = 0;
  for (const task of tasks) {
    if (task.actualStart == null) continue;
    for (let d = task.actualStart; d < (task.actualEnd ?? plan.asOf); d++) {
      parallel[d]++;
      for (const [r, quantity] of task.demand) loads[r][d] += quantity;
    }
  }
  while (ready.length) {
    let best = 0;
    for (let j = 1; j < ready.length; j++) if (priorities[ready[j]] > priorities[ready[best]]) best = j;
    const [i] = ready.splice(best, 1);
    const task = tasks[i];
    if (task.actualEnd != null) {
      starts[i] = null;
      ends[i] = task.actualEnd;
      days = Math.max(days, task.actualEnd);
      for (const next of task.next) if (--pending[next] === 0) ready.push(next);
      continue;
    }
    const faceKey = task.group + '|' + task.face;
    if (!faces.get(faceKey)) faces.set(faceKey, new Uint8Array(HORIZON));
    const face = faces.get(faceKey);
    const earliest = Math.max(plan.asOf, task.release, ...task.after.map(p => ends[p]));
    let start = earliest;
    while (start + task.duration <= HORIZON) {
      let conflict = -1;
      for (let day = start; day < start + task.duration; day++) {
        const shortage = task.demand.find(([r, quantity]) => loads[r][day] + quantity > resources[r].availability[day]);
        if (face[day] || shortage) {
          blockers[i] = face[day] ? '工作面占用' : resources[shortage[0]].name + '容量不足';
          conflict = day;
          break;
        }
      }
      if (conflict < 0) break;
      start = conflict + 1;
    }
    if (start + task.duration > HORIZON) return null;
    const end = start + task.duration;
    starts[i] = start;
    waits[i] = start - earliest;
    ends[i] = end;
    face.fill(1, start, end);
    for (let day = start; day < end; day++) parallel[day]++;
    days = Math.max(days, end);
    for (const [r, quantity] of task.demand) for (let day = start; day < end; day++) loads[r][day] += quantity;
    for (const next of task.next) if (--pending[next] === 0) ready.push(next);
  }
  const resourceStats = resources.map((resource, r) => {
    let first = -1, last = 0, peak = 0, unitDays = 0, availableDays = 0, peakLoadPercent = 0;
    for (let day = 0; day < days; day++) {
      const used = loads[r][day], available = resource.availability[day];
      if (!used) continue;
      if (first < 0) first = day;
      last = day + 1;
      unitDays += used;
      peak = Math.max(peak, used);
      if (available) peakLoadPercent = Math.max(peakLoadPercent, Math.round(100 * used / available));
    }
    if (first >= 0) for (let day = first; day < last; day++)
      availableDays += Math.max(loads[r][day], Math.min(peak, resource.availability[day]));
    const idleUnitDays = availableDays - unitDays;
    return { id: resource.id, name: resource.name, capacity: resource.capacity, peak, peakLoadPercent, unitDays,
      idleUnitDays, firstDay: first < 0 ? null : first, lastDay: first < 0 ? null : last,
      standbyCents: idleUnitDays * resource.standby };
  });
  const standby = resourceStats.reduce((sum, r) => sum + r.standbyCents, 0);
  const overhead = days * plan.overhead;
  const total = plan.directCost + plan.usageCost + standby + overhead;
  if (!Number.isSafeInteger(total)) throw invalid('本方案排程总金额超出可靠计算范围。');
  return { starts, ends, waits, blockers, days, total, standby, overhead, resourceStats, peakParallel: Math.max(...parallel) };
}

function describe(plan, item) {
  if (!item) return null;
  const chain = [];
  let cursor = item.ends.indexOf(item.days);
  while (cursor >= 0) {
    const task = plan.tasks[cursor];
    chain.unshift(task.id);
    cursor = task.after.reduce((latest, p) => latest < 0 || item.ends[p] > item.ends[latest] ? p : latest, -1);
  }
  return { days: item.days, peakParallel: item.peakParallel, meetsDeadline: !plan.deadline || item.days <= plan.deadline,
    finishChain: chain,
    cost: { total: item.total / 100, direct: plan.directCost / 100, usage: plan.usageCost / 100,
      overhead: item.overhead / 100, standby: item.standby / 100 },
    resources: item.resourceStats.map(({ standbyCents, ...r }) => ({ ...r, standbyCost: standbyCents / 100 })),
    tasks: plan.tasks.map((t, i) => ({ id: t.id, group: t.group, face: t.face, name: t.name, startDay: t.actualStart ?? item.starts[i],
      endDay: item.ends[i], actualStartDay: t.actualStart, actualEndDay: t.actualEnd, plannedStartDay: item.starts[i],
      progress: t.actualEnd != null ? 'done' : t.actualStart != null ? 'active' : 'pending',
      waitDays: item.waits[i] || 0, waitReason: item.blockers[i] || '', after: t.after.map(p => plan.tasks[p].id),
      resources: Object.fromEntries(t.demand.map(([r, n]) => [plan.resources[r].id, n])) }))
      .sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay) };
}

function optimize(input) {
  const plan = prepare(input);
  const blocked = plan.tasks.filter(t => t.duration).flatMap(t => t.demand.filter(([r, n]) => n > plan.resources[r].capacity)
    .map(([r, n]) => t.id + ' 需要 ' + n + ' × ' + plan.resources[r].name + '，可用上限为 ' + plan.resources[r].capacity));
  const meta = { name: plan.title, startDate: plan.startDate, demo: plan.demo, asOfDay: plan.asOf, deadlineDays: plan.deadline, lowerBoundDays: plan.lowerDays };
  if (blocked.length) return { ...meta, status: 'capacity_conflict', blocked, attempts: 0, baseline: null, cheapest: null, fastest: null };
  let seed = 713057;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const baseline = schedule(plan, plan.tasks.map((task, i) => task.actualStart != null ? 100000 - i : -i));
  let cheapest = null, fastest = null, attempts = 1;
  function consider(item) {
    if (!item) return;
    if (!fastest || item.days < fastest.days || (item.days === fastest.days && item.total < fastest.total)) fastest = item;
    if (plan.deadline && item.days > plan.deadline) return;
    if (!cheapest || item.total < cheapest.total || (item.total === cheapest.total && item.days < cheapest.days)) cheapest = item;
  }
  consider(baseline);
  for (let trial = 0; trial < 79; trial++) {
    const weights = plan.tasks.map(t => {
      if (t.actualStart != null) return 100000;
      if (trial === 0) return t.tail;
      if (trial === 1) return -t.duration;
      if (trial === 2) return t.next.length;
      const bias = trial % 4 === 0 ? 0 : trial % 4 === 1 ? t.tail : trial % 4 === 2 ? t.duration : -t.release;
      return bias + random() * (12 + trial);
    });
    consider(schedule(plan, weights));
    attempts++;
  }
  const status = cheapest ? 'scheduled' : fastest ? (plan.lowerDays > plan.deadline ? 'deadline_impossible' : 'deadline_not_met') : 'horizon_exhausted';
  return { ...meta, status, blocked, attempts, baseline: describe(plan, baseline), cheapest: describe(plan, cheapest),
    fastest: describe(plan, fastest) };
}

function solve(input, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const worker = new Worker(__filename, { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 96 } });
    const abort = () => { worker.terminate(); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(Object.assign(new Error('计算超时，请缩小计划规模后重试。'), { status: 503, code: 'PLANNER_TIMEOUT' }));
    }, 8000);
    worker.once('message', message => message.error ? reject(Object.assign(new Error(message.error), message)) : resolve(message.result));
    worker.once('error', reject);
    worker.once('exit', code => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (code) reject(new Error('排程进程提前结束。'));
    });
  });
}

if (!isMainThread) {
  try { parentPort.postMessage({ result: optimize(workerData) }); }
  catch (e) { parentPort.postMessage({ error: e.message, status: e.status || 500, code: e.code || 'PLANNER_ERROR' }); }
}

module.exports = { optimize, solve };
