#!/usr/bin/env node
/* 孤岛文明沙盘 · 轨迹调试（非门槛工具）：看部落逐年状态与事件流，调平衡用 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return (i >= 0 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : def;
}
const seed = Number(argOf('seed', 20261105));
const ticks = Math.floor(Number(argOf('ticks', 200)));
const every = Math.floor(Number(argOf('every', 10)));

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const B = '/* ===== SIM-CORE-BEGIN ===== */';
const E = '/* ===== SIM-CORE-END ===== */';
vm.runInThisContext(html.slice(html.indexOf(B), html.indexOf(E) + E.length), { filename: 'sim-core.js' });

const w = IslandSim.createWorld(seed);
const tally = {};                                   // 全程事件流分型计数（终局打印）
console.log('== 开局 ==');
console.log(w.tribes.map(t => t.id + '.' + t.name + '(' + t.color + ')@' + t.x + ',' + t.y
  + ' 人口' + Math.round(t.pop) + ' 领地' + t.tiles.length).join('\n'));
for (let i = 0; i < w.tribes.length; i++) {
  for (let j = i + 1; j < w.tribes.length; j++) {
    const a = w.tribes[i], b = w.tribes[j];
    console.log('间距 ' + a.id + '-' + b.id + ' = '
      + Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
  }
}
for (let y = 0; y < ticks; y++) {
  const fresh = w.tick();
  for (const ev of fresh) tally[ev.type] = (tally[ev.type] || 0) + 1;
  if (every > 0 && y % every === every - 1) {
    console.log('y' + w.year + ' n=' + w.tribes.length + ' ' + w.tribes.map(t =>
      t.id + ':p' + Math.round(t.pop) + '/t' + t.tiles.length + '/f' + Math.round(t.food)).join(' '));
  }
  if (every < 0) for (const ev of fresh) console.log('  [' + ev.year + ']' + ev.type + ' ' + ev.text);
}
let pop = 0, terr = 0;
for (const t of w.tribes) { pop += t.pop; terr += t.tiles.length; }
console.log('== 终局 == y' + w.year + ' 部落' + w.tribes.length + ' 总人口' + Math.round(pop) + ' 领地' + terr);
console.log('== 事件流统计（全程，不受 eventsLimit 截断）== ' + JSON.stringify(tally));
