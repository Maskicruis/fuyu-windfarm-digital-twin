'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const root = $('engineeringSection');
  const names = { baseline: '排序基准', cheapest: '最低成本候选', fastest: '最短工期候选' };
  const groups = ['风机工程', '场内交通', '集电线路', '升压站', '联合调试'];
  const storageKey = 'specflow-engineering-draft-v1';
  const currency = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dayNumber = new Intl.NumberFormat('zh-CN');
  let plan, report, previousReport, calculatedPlan, previousPlan, editing, selected = 'cheapest',
    loading = false, initialized = false, review, recalc, focusTask;
  const projectFields = { engProject: 'name', engStart: 'startDate', engAsOf: 'asOfDay', engDeadline: 'deadlineDays', engOverhead: 'overheadPerDay' };

  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  async function request(action, payload, signal) {
    const options = payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal } : {};
    const response = await fetch('/api/v1/engineering/' + action, options);
    const value = await response.json();
    if (!response.ok) throw Error(value.error?.message || 'HTTP ' + response.status);
    return value.data;
  }

  function workfaceCount() {
    return new Set(plan.tasks.map(task => task.group + '/' + task.face)).size;
  }

  function saveDraft() {
    try { localStorage.setItem(storageKey, JSON.stringify(plan)); } catch { /* JSON export also preserves the draft */ }
  }

  function status(message, error = false) {
    $('engStatus').textContent = message;
    $('engStatus').classList.toggle('eng-error', error);
  }

  function tab(name) {
    root.querySelectorAll('[data-eng-panel]').forEach(el => { el.hidden = el.dataset.engPanel !== name; });
    root.querySelectorAll('[data-eng-tab]').forEach(el => {
      const active = el.dataset.engTab === name;
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', String(active));
    });
  }

  function clearReview() {
    review?.abort();
    review = null;
    $('engAsk').disabled = false;
    $('engAnswer').hidden = true;
    $('engAskStatus').textContent = '';
  }

  function renderPlan() {
    $('engName').textContent = plan.name || '未命名计划';
    $('engScope').textContent = (plan.demo ? '演示数据 · 工期、费率及线路区段为假设' : '导入计划 · 费用按录入参数测算')
      + ' / ' + workfaceCount() + ' 个工作面 / ' + plan.tasks.length + ' 道工序';
    for (const [key, field] of Object.entries(projectFields)) $(key).value = plan[field] ?? '';
    const taskEdit = task => editButton(() => edit('tasks', task));
    displayTable('engTaskTable', ['编号', '专业 / 工作面', '工序', '工期', '前置工序', '资源需求', ''],
      plan.tasks.map(task => [task.id, task.group + ' / ' + task.face, task.name, task.duration + ' 天',
        task.after?.join('、') || '—', Object.entries(task.demand || {}).map(([key, n]) => key + ' × ' + n).join('、') || '—', taskEdit(task)]));
    displayTable('engResourceTable', ['编号', '共享资源', '数量', '使用费 / 台班日', '闲置费 / 台班日', '产能窗口', ''],
      plan.resources.map(resource => [resource.id, resource.name, resource.capacity, money(resource.dailyCost || 0),
        money(resource.standbyCost || 0), (resource.windows || []).map(w => w.startDay + '–' + w.endDay + '：' + w.capacity).join('、') || '—',
        editButton(() => edit('resources', resource))]));
  }

  function markDirty() {
    if (report) {
      previousReport = report;
      previousPlan = calculatedPlan;
    }
    report = null;
    clearReview();
    saveDraft();
    renderPlan();
    renderResults();
    status('条件已更新，正在准备重排…');
    clearTimeout(recalc);
    recalc = setTimeout(() => run(plan, false, true), 250);
  }

  function money(number) { return '¥' + currency.format(number); }
  function signed(number) { return (number > 0 ? '+' : number < 0 ? '−' : '') + money(Math.abs(number)); }
  function editButton(onclick) {
    const button = element('button', '编辑', 'btn eng-mini');
    button.type = 'button';
    button.addEventListener('click', onclick);
    return button;
  }

  function displayTable(id, columns, rows) {
    const table = element('table');
    const head = table.createTHead().insertRow();
    for (const name of columns) head.append(element('th', name));
    const body = table.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const value of row) {
        const td = tr.insertCell();
        if (value instanceof Node) td.append(value);
        else td.textContent = value;
      }
    }
    $(id).replaceChildren(table);
  }

  function date(day) {
    if (!report.startDate) return 'D' + day;
    const dt = new Date(report.startDate + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + day);
    return dt.toISOString().slice(0, 10);
  }

  function renderResults() {
    const cards = $('engCards');
    cards.replaceChildren();
    const active = report?.[selected];
    $('engSchedule').hidden = !active;
    $('engNetworkPanel').hidden = !active;
    $('engAgent').hidden = !active;
    if (!report) {
      cards.append(element('p', '计算后可查看方案、工作面甘特图和资源费用。', 'muted'));
      return;
    }
    for (const [key, name] of Object.entries(names)) {
      const candidate = report[key];
      const card = element('button', null, 'eng-card' + (active && key === selected ? ' active' : ''));
      card.type = 'button';
      card.disabled = !candidate;
      card.setAttribute('aria-pressed', String(Boolean(active && key === selected)));
      card.append(element('span', name, 'eng-kicker'));
      if (candidate) {
        card.append(element('strong', money(candidate.cost.total)), element('span',
          candidate.days + ' 天 · 峰值并行 ' + candidate.peakParallel + ' 面' + (report.deadlineDays ? candidate.meetsDeadline ? ' · 满足目标' : ' · 超期' : ''),
          'eng-card-detail'));
        if (key !== 'baseline' && report.baseline)
          card.append(element('span', '比排序基准 ' + signed(candidate.cost.total - report.baseline.cost.total), 'eng-card-delta'));
      } else card.append(element('span', key === 'cheapest' ? '未找到满足目标的方案' : '未找到可展示的方案', 'eng-card-detail'));
      card.onclick = () => { selected = key; renderResults(); };
      cards.append(card);
    }
    if (!active) return;
    renderNetwork();
    $('engTimeLabel').textContent = names[selected] + ' · ' + date(0) + ' 至 ' + date(active.days) + '（结束边界）'
      + ' · 固定 ' + money(active.cost.direct) + ' / 使用 ' + money(active.cost.usage) + ' / 管理 ' + money(active.cost.overhead) + ' / 闲置 ' + money(active.cost.standby);
    renderTimeline();
    displayTable('engUsage', ['资源', '峰值 / 数量', '最高占用率', '使用台班日', '闲置台班日', '闲置费用'],
      active.resources.map(r => [r.name, r.peak + ' / ' + r.capacity, r.peakLoadPercent + '%', r.unitDays, r.idleUnitDays, money(r.standbyCost)]));
  }

  function renderTimeline() {
    const active = report?.[selected];
    if (!active) return;
    const query = $('engSearch').value.trim().toLowerCase();
    const group = $('engGroup').value;
    const tasks = active.tasks.filter(t => (!group || t.group === group) &&
      (!query || [t.id, t.face, t.name].some(value => value.toLowerCase().includes(query))));
    const axis = element('div', null, 'eng-axis');
    for (let i = 0; i <= 4; i++) axis.append(element('span', 'D' + Math.round(i * active.days / 4)));
    displayTable('engTimeline', ['工作面 / 工序', '开始 → 结束', '时序'], tasks.length ? tasks.map(task => {
      const name = element('div', null, 'eng-timeline-name');
      name.append(element('strong', task.face + ' · ' + task.name), element('small', task.id + ' / ' + task.group, 'muted'));
      const track = element('div', null, 'eng-track');
      const bar = element('span', null, 'eng-bar');
      bar.dataset.group = String(groups.indexOf(task.group));
      if (task.actualStartDay != null) {
        const actual = element('span', null, 'eng-bar eng-actual');
        actual.style.left = (task.actualStartDay * 100 / active.days) + '%';
        actual.style.width = (((task.actualEndDay ?? report.asOfDay) - task.actualStartDay) * 100 / active.days) + '%';
        track.append(actual);
      }
      if (task.plannedStartDay != null) {
        bar.style.left = (task.plannedStartDay * 100 / active.days) + '%';
        bar.style.width = ((task.endDay - task.plannedStartDay) * 100 / active.days) + '%';
        track.append(bar);
      }
      return [name, date(task.startDay) + ' → ' + date(task.endDay), track];
    }) : [['当前筛选没有工序', '—', '—']]);
    $('engTimeline').querySelector('thead th:last-child').replaceChildren(axis);
  }

  function renderNetwork() {
    const active = report?.[selected];
    if (!active) return;
    const container = $('engNetwork');
    const positions = new Map(), levels = new Map(), rows = new Map();
    const byId = new Map(active.tasks.map(task => [task.id, task]));
    if (!byId.has(focusTask)) {
      focusTask = active.finishChain.find(id => byId.get(id).progress !== 'done') || active.tasks[0].id;
    }
    const focus = byId.get(focusTask);
    const before = previousReport?.[selected] || previousReport?.cheapest || previousReport?.fastest;
    const old = new Map(before?.tasks.map(task => [task.id, task]) || []);
    const changed = task => {
      const prior = old.get(task.id);
      return prior && task.progress !== 'done' && (prior.plannedStartDay !== task.plannedStartDay || prior.endDay !== task.endDay);
    };
    const next = active.tasks.filter(task => task.after.includes(focusTask));
    const all = $('engNetworkMode').value === 'all';
    const tasks = all ? active.tasks : [...focus.after.map(id => byId.get(id)), focus, ...next];
    function level(task) {
      if (!levels.has(task.id)) levels.set(task.id, Math.max(-1, ...task.after.map(id => level(byId.get(id)))) + 1);
      return levels.get(task.id);
    }
    let width = 252, height = 96;
    for (const task of tasks) {
      const column = all ? level(task) : task === focus ? 1 : task.after.includes(focusTask) ? 2 : 0;
      const row = rows.get(column) || 0;
      rows.set(column, row + 1);
      const point = { x: column * 236 + 16, y: row * 85 + 12 };
      positions.set(task.id, point);
      width = Math.max(width, point.x + 212);
      height = Math.max(height, point.y + 79);
    }
    if (!all) width = Math.max(width, 710);
    const svg = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);
    const graph = element('div', null, 'eng-network-graph');
    graph.style.width = width + 'px';
    graph.style.height = height + 'px';
    const lines = svg('svg');
    lines.setAttribute('width', width);
    lines.setAttribute('height', height);
    lines.setAttribute('aria-hidden', 'true');
    const chain = active.finishChain;
    for (const task of tasks) {
      const to = positions.get(task.id);
      for (const id of task.after) {
        const from = positions.get(id);
        if (!from) continue;
        const line = svg('path');
        const mid = (from.x + 198 + to.x) / 2;
        line.setAttribute('d', 'M' + (from.x + 198) + ',' + (from.y + 31) + ' H' + mid + ' V' + (to.y + 31) + ' H' + to.x);
        if (chain.includes(id) && chain[chain.indexOf(id) + 1] === task.id) line.classList.add('eng-chain');
        lines.append(line);
      }
    }
    graph.append(lines);
    for (const task of tasks) {
      const point = positions.get(task.id);
      const node = element('button', null, 'eng-node ' + task.progress + (changed(task) ? ' changed' : ''));
      node.type = 'button';
      node.style.left = point.x + 'px';
      node.style.top = point.y + 'px';
      node.setAttribute('aria-pressed', String(task === focus));
      node.append(element('strong', task.face + ' · ' + task.name), element('small', task.id + ' · D' + task.startDay + ' → D' + task.endDay));
      node.onclick = () => { focusTask = task.id; renderNetwork(); };
      graph.append(node);
    }
    const scroll = [container.scrollLeft, container.scrollTop];
    container.replaceChildren(graph);
    [container.scrollLeft, container.scrollTop] = scroll;
    const delta = before ? ' · ' + active.tasks.filter(changed).length + ' 道工序改期 · 工期变化 ' +
      (active.days - before.days) + ' 天 · 费用变化 ' + signed(active.cost.total - before.cost.total) : '';
    $('engRouteSummary').textContent = '当前 D' + report.asOfDay + ' · 预计 D' + active.days + ' 完工' + delta;
    const detail = $('engNodeDetail');
    const state = { done: '已完工', active: '施工中', pending: '待开工' }[focus.progress];
    const prior = old.get(focus.id);
    const line = element('p', focus.id + ' · ' + state + ' · ' + date(focus.startDay) + ' → ' + date(focus.endDay)
      + (focus.progress === 'active' ? ' · 预计续作 D' + focus.plannedStartDay : '')
      + (focus.waitDays ? ' · 比最早可开工日晚 ' + focus.waitDays + ' 天（' + focus.waitReason + '）' : '')
      + (changed(focus) ? ' · 上版 D' + prior.startDay + ' → D' + prior.endDay : ''));
    const button = editButton(() => edit('tasks', plan.tasks.find(task => task.id === focus.id)));
    button.textContent = '登记进度 / 调整工序';
    detail.replaceChildren(line, button);
  }

  function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = element('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function run(next = plan, replace = false, automatic = false) {
    if (!next) return;
    if (loading) {
      if (automatic) recalc = setTimeout(() => run(plan, false, true), 200);
      return;
    }
    clearTimeout(recalc);
    loading = true;
    for (const id of ['engRun', 'engImport', 'engDemo']) $(id).disabled = true;
    const snapshot = structuredClone(next);
    status('正在检查约束并比较排程方案…');
    try {
      const result = await request('solve', { plan: snapshot });
      if (!replace && JSON.stringify(snapshot) !== JSON.stringify(plan)) return;
      if (replace) { plan = snapshot; previousReport = null; previousPlan = null; focusTask = null; saveDraft(); renderPlan(); }
      calculatedPlan = snapshot;
      report = result;
      clearReview();
      selected = report.cheapest ? 'cheapest' : 'fastest';
      renderResults();
      if (!automatic) tab('results');
      const notices = {
        capacity_conflict: '资源不足。' + report.blocked.slice(0, 5).join('；'),
        deadline_impossible: '目标工期低于工序依赖下限 ' + report.lowerBoundDays + ' 天，需调整目标或工序条件。',
        deadline_not_met: '本轮未找到满足目标工期的方案，已展示搜索到的最短工期。',
        horizon_exhausted: '未找到 1800 天内的可行排程，请检查资源、窗口和工期。'
      };
      status(notices[report.status] || ('已完成 ' + dayNumber.format(report.attempts) + ' 次候选排程 · 结果为当前输入下的候选解。'), report.status !== 'scheduled');
      initialized = true;
    } catch (error) {
      status(error.message, true);
    } finally {
      loading = false;
      for (const id of ['engRun', 'engImport', 'engDemo']) $(id).disabled = false;
    }
  }

  const taskFields = [
    ['id', '工序编号', 'text'], ['group', '工程专业', 'select'], ['face', '工作面', 'text'], ['name', '工序名称', 'text'],
    ['duration', '工期（天）', 'number'], ['releaseDay', '最早开工日（D0 起算）', 'number'],
    ['directCost', '固定成本（元）', 'money'], ['after', '前置工序编号（逗号分隔）', 'text'],
    ['demand', '资源需求 JSON，如 {"crane":1}', 'json'],
    ['actualStart', '实际开工 D（未开工留空）', 'optionalNumber'], ['actualEnd', '实际完工 D（施工中留空）', 'optionalNumber'],
    ['remaining', '预计剩余工期（施工中必填）', 'optionalNumber']
  ];
  const resourceFields = [
    ['id', '资源编号', 'text'], ['name', '资源名称', 'text'], ['capacity', '共享数量', 'number'],
    ['dailyCost', '使用费（元 / 台班日）', 'money'], ['standbyCost', '闲置费（元 / 台班日）', 'money'],
    ['windows', '产能窗口 JSON，如 [{"startDay":75,"endDay":80,"capacity":0}]', 'json']
  ];

  function edit(kind, item) {
    const isTask = kind === 'tasks';
    const fields = isTask ? taskFields : resourceFields;
    $('engEditorTitle').textContent = (item ? '编辑' : '新增') + (isTask ? '工序' : '资源');
    $('engEditStatus').textContent = '';
    $('engDelete').hidden = !item;
    editing = { kind, item, fields };
    $('engFields').replaceChildren(...fields.map(([key, title, type]) => {
      const label = element('label', title);
      const input = element(type === 'json' ? 'textarea' : type === 'select' ? 'select' : 'input');
      input.name = key;
      if (type === 'select') input.append(...groups.map(value => new Option(value, value)));
      else if (type !== 'json') input.type = ['money', 'optionalNumber'].includes(type) ? 'number' : type;
      if (type === 'json') { input.rows = 2; label.classList.add('eng-full'); }
      if (input.type === 'number') { input.step = type === 'money' ? '0.01' : '1'; input.min = ['duration','remaining'].includes(key) ? '1' : '0'; }
      input.required = type !== 'optionalNumber' && !['after', 'demand', 'windows'].includes(key);
      input.readOnly = key === 'id' && Boolean(item);
      const progressKeys = { actualStart: 'startDay', actualEnd: 'endDay', remaining: 'remainingDays' };
      const value = type === 'optionalNumber' ? item?.progress?.[progressKeys[key]] : item?.[key];
      if (type === 'json') input.value = JSON.stringify(value || (key === 'windows' ? [] : {}));
      else if (key === 'after') input.value = value?.join(', ') || '';
      else input.value = value ?? (type === 'optionalNumber' ? '' : type === 'select' ? groups[0] : key === 'duration' ? 1 : input.type === 'number' ? 0 : '');
      label.append(input);
      return label;
    }));
    $('engEditor').showModal();
  }

  $('engEditorForm').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const { kind, fields, item } = editing;
      const form = new FormData(event.currentTarget);
      const row = {};
      for (const [key, , type] of fields) {
        const value = form.get(key).trim();
        if (key === 'id' && !/^[\w-]{1,40}$/.test(value)) throw Error('编号须使用字母、数字、下划线或短横线。');
        if (key === 'after') row[key] = value.split(/[,，\s]+/).filter(Boolean);
        else if (type === 'json') {
          const parsed = JSON.parse(value || (key === 'windows' ? '[]' : '{}'));
          if (key === 'windows' && (!Array.isArray(parsed) || parsed.some(w => !w || typeof w !== 'object' || Array.isArray(w))))
            throw Error('产能窗口须为 JSON 对象数组。');
          if (key === 'demand' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))
            throw Error('资源需求须为 JSON 对象。');
          row[key] = parsed;
        }
        else if (type === 'optionalNumber') row[key] = value === '' ? null : Number(value);
        else row[key] = ['number', 'money'].includes(type) ? Number(value) : value;
      }
      if (kind === 'tasks') {
        const { actualStart, actualEnd, remaining } = row;
        if ((actualEnd != null || remaining != null) && actualStart == null) throw Error('请先填写实际开工日。');
        if (actualStart != null) {
          if (actualStart > (plan.asOfDay || 0) || (actualEnd != null && (actualEnd <= actualStart || actualEnd > plan.asOfDay)))
            throw Error('实际日期须按开工、完工、当前进度日的顺序填写。');
          if (actualEnd == null && remaining == null) throw Error('施工中请填写预计剩余工期。');
          row.progress = { startDay: actualStart, ...(actualEnd == null ? { remainingDays: remaining } : { endDay: actualEnd }) };
        }
        for (const key of ['actualStart','actualEnd','remaining']) delete row[key];
      }
      if (!item && plan[kind].some(candidate => candidate.id === row.id)) throw Error('编号已存在。');
      const index = plan[kind].indexOf(item);
      if (index >= 0) plan[kind][index] = row;
      else plan[kind].push(row);
      $('engEditor').close();
      markDirty();
    } catch (error) { $('engEditStatus').textContent = error.message; }
  });

  $('engDelete').onclick = () => {
    const { kind, item } = editing;
    const linked = plan.tasks.find(task => kind === 'tasks' ? task.after?.includes(item.id) : Object.hasOwn(task.demand || {}, item.id));
    if (linked) { $('engEditStatus').textContent = '请先解除工序 ' + linked.id + ' 对该项的引用。'; return; }
    plan[kind] = plan[kind].filter(row => row !== item);
    $('engEditor').close();
    markDirty();
  };
  $('engCancel').onclick = () => $('engEditor').close();
  $('engNetworkMode').onchange = renderNetwork;
  $('engOutage').onclick = () => {
    const form = $('engOutageForm');
    form.elements.resource.replaceChildren(...plan.resources.map(resource => new Option(resource.name, resource.id)));
    form.elements.start.value = plan.asOfDay || 0;
    form.elements.end.value = (plan.asOfDay || 0) + 1;
    $('engOutageStatus').textContent = '';
    $('engOutageDialog').showModal();
  };
  $('engOutageCancel').onclick = () => $('engOutageDialog').close();
  $('engOutageForm').onsubmit = event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const startDay = Number(data.get('start')), endDay = Number(data.get('end'));
    if (startDay < (plan.asOfDay || 0) || endDay <= startDay) {
      $('engOutageStatus').textContent = '停用须从当前进度日或之后开始，恢复日须在停用日之后。';
      return;
    }
    const resource = plan.resources.find(r => r.id === data.get('resource'));
    if (!resource || (resource.windows || []).length >= 40) {
      $('engOutageStatus').textContent = '该资源的停用窗口已达上限。';
      return;
    }
    resource.windows = [...(resource.windows || []), { startDay, endDay, capacity: 0 }];
    $('engOutageDialog').close();
    markDirty();
  };
  $('engAddTask').onclick = () => { if (plan) edit('tasks'); };
  $('engAddResource').onclick = () => { if (plan) edit('resources'); };
  $('engRun').onclick = () => run();
  $('engSave').onclick = () => { if (plan) download('specflow-plan.json', plan); };
  $('engExport').onclick = () => { if (report) download('specflow-schedule.json', { ...report, selected }); };
  $('engImport').onclick = () => $('engFile').click();
  $('engDemo').onclick = async () => {
    if (plan && !window.confirm('载入示例将替换当前草稿，已导出的计划文件会保留。继续？')) return;
    try { await run(await request('demo'), true); } catch (error) { status(error.message, true); }
  };
  $('engFile').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    try {
      if (file.size > 2 * 1024 * 1024) throw Error('计划 JSON 最大 2 MB。');
      await run(JSON.parse((await file.text()).replace(/^\uFEFF/, '')), true);
    } catch (error) { status(error.message, true); }
  };
  for (const [key, field] of Object.entries(projectFields)) $(key).onchange = event => {
    if (!plan) return;
    plan[field] = event.target.type === 'number' ? Number(event.target.value) : event.target.value.trim();
    markDirty();
  };
  $('engAskForm').onsubmit = async event => {
    event.preventDefault();
    clearReview();
    if (!report) return;
    const question = $('engQuestion').value.trim();
    if (!question) { $('engAskStatus').textContent = '请输入排程问题。'; return; }
    const controller = new AbortController();
    review = controller;
    $('engAsk').disabled = true;
    $('engAskStatus').textContent = '正在分析费率、工序和各方案…';
    try {
      const result = await request('review', { plan, question, selected, priorPlan: previousPlan }, controller.signal);
      if (controller.signal.aborted) return;
      $('engAnswer').textContent = result.answer;
      $('engAnswer').hidden = false;
      $('engAskStatus').textContent = '分析完成 · ' + result.model;
    } catch (error) {
      if (!controller.signal.aborted) $('engAskStatus').textContent = error.message;
    } finally {
      if (review === controller) { review = null; $('engAsk').disabled = false; }
    }
  };
  $('engGroup').append(new Option('全部专业', ''), ...groups.map(value => new Option(value, value)));
  $('engGroup').onchange = renderTimeline;
  $('engSearch').oninput = renderTimeline;
  root.querySelectorAll('[data-eng-tab]').forEach(el => { el.onclick = () => tab(el.dataset.engTab); });

  async function open() {
    if (initialized || loading) return;
    let draft;
    try { draft = JSON.parse(localStorage.getItem(storageKey)); } catch { /* restore the example */ }
    try {
      if (draft && Array.isArray(draft.tasks) && Array.isArray(draft.resources)) {
        plan = draft;
        renderPlan();
        initialized = true;
        await run();
      } else {
        await run(await request('demo'), true);
      }
    }
    catch (error) { status(error.message, true); }
  }
  window.addEventListener('specflow-engineering-open', open);
  if (root.classList.contains('active')) open();
})();
