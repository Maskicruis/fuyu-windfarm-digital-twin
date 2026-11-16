'use strict';

function demoPlan() {
  const tasks = [];
  const add = (id, name, group, face, duration, directCost, demand, after = [], releaseDay = 0) =>
    tasks.push({ id, name, group, face, duration, directCost, demand, after, releaseDay });
  const station = '升压站';
  add('SS-civil', '土建结构工程施工', station, '站区', 32, 410000, { civil: 1 });
  add('SS-power', '主变压器安装', station, '站区', 9, 190000, { crane: 1, electric: 1 }, ['SS-civil'], 34);
  add('SS-test', '系统调试与联合试运行', station, '站区', 7, 80000, { electric: 1 }, ['SS-power']);
  const handovers = ['SS-test'];
  for (let area = 0; area < 6; area++) {
    const road = 'RD-' + (area + 1);
    const line = 'CL-' + (area + 1);
    add(road, '路基与进场道路施工', '场内交通', '道路区段 ' + (area + 1), 8 + area, 80000, { road: 1 }, [], area * 2);
    const foundations = [];
    for (let n = area * 5 + 1; n <= Math.min(area * 5 + 5, 27); n++) {
      const face = 'F' + String(n).padStart(2, '0');
      const wind = '风机工程';
      add(face + '-pile', '钻孔灌注桩施工', wind, face, 5 + n % 3, 30000, { pile: 1 }, [road]);
      add(face + '-base', '承台及基础施工', wind, face, 9 + n % 4, 46000, { civil: 1 }, [face + '-pile']);
      add(face + '-lift', '风机设备吊装', wind, face, 3 + n % 2, 72000, { crane: 1 }, [face + '-base'], 39 + 16 * (n % 4));
      add(face + '-test', '单机调试', wind, face, 2, 11000, { electric: 1 }, [face + '-lift']);
      foundations.push(face + '-base');
      handovers.push(face + '-test');
    }
    add(line + '-civil', '线路土建与保护管施工', '集电线路', '演示区段 ' + (area + 1), 13 + area, 125000, { line: 1 }, [road]);
    add(line + '-cable', '电缆敷设与试验', '集电线路', '演示区段 ' + (area + 1), 8 + area, 95000, { line: 1, electric: 1 },
      [line + '-civil', ...foundations]);
    handovers.push(line + '-cable');
  }
  add('GRID', '全场联调', '联合调试', '全场', 4, 50000, { electric: 1 }, handovers);
  return {
    name: '扶余一号 · 并行施工示例',
    demo: true,
    deadlineDays: 130,
    overheadPerDay: 13500,
    resources: [
      { id: 'road', name: '道路班组', capacity: 2, dailyCost: 9500, standbyCost: 1200 },
      { id: 'pile', name: '桩基机组', capacity: 3, dailyCost: 14000, standbyCost: 2600 },
      { id: 'civil', name: '土建班组', capacity: 4, dailyCost: 6500, standbyCost: 1100 },
      { id: 'crane', name: '吊装资源', capacity: 2, dailyCost: 46000, standbyCost: 42000,
        windows: [{ startDay: 75, endDay: 80, capacity: 0 }] },
      { id: 'line', name: '线路班组', capacity: 2, dailyCost: 13500, standbyCost: 3300 },
      { id: 'electric', name: '电气调试班组', capacity: 3, dailyCost: 7700, standbyCost: 1900 }
    ],
    tasks
  };
}

module.exports = { demoPlan };
