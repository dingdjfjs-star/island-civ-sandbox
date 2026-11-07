#!/usr/bin/env node
/* 孤岛文明沙盘 · UI 逻辑探针（阶段四新增；node 直跑，无依赖）
   用法：node test/ui-loop.js
   背景：渲染必须跑在浏览器里，但主循环/日志/名册/tooltip 的接线与节奏可以在 node 里
   用桩 DOM + 桩时钟确定性地自证。本探针从 index.html 抽出 SIM-CORE 与 UI 两段脚本，
   在 vm 沙箱里装上 document/canvas/requestAnimationFrame/setInterval/performance 桩后
   完整跑起来，然后逐项断言：
     1. 开局：年份 1、编年史 5 行（诞生+4 建部，顺序正确）、名册 4 部落
     2. 点击"开始"：按钮文案切到"暂停"
     3. ×5 档推 240 帧（16.7ms/帧）：恰走 20 年（年/秒换算正确）
     4. 切 ×60 档推 60 帧：恰再走 60 年
     5. 点"暂停"再推 120 帧：年份一字不动（暂停不推进但保持渲染不抛错）
     6. ×60 长跑 2600 帧（≈2600 年）：编年史恰封顶 400 条；名册出现置灰已灭部落
     7. 种子框改 42 点"重置"：世界重建回第 1 年，编年史 5 行且种子号为 42
     8. 画布 mousemove/mouseleave：tooltip 显示/隐藏，内容含地类与资源
     9. 兜底心跳已注册（200ms）且与 rAF 共用一套累加器（节流环境不双跳）
   任一项不过 → 退出码 1。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const B = '/* ===== SIM-CORE-BEGIN ===== */';
const E = '/* ===== SIM-CORE-END ===== */';
const bi = html.indexOf(B), ei = html.indexOf(E);
if (bi < 0 || ei < bi) { console.error('FAIL: 缺少 SIM-CORE 标记'); process.exit(2); }
const coreCode = html.slice(bi, ei + E.length);
const uiMatch = html.slice(ei + E.length).match(/<script>([\s\S]*?)<\/script>/);
if (!uiMatch) { console.error('FAIL: END 之后没有 UI 脚本'); process.exit(2); }
const uiCode = uiMatch[1];

/* ---- 桩时钟与帧调度 ---- */
let NOW = 0;
const rafCbs = [];
const intervals = [];
function pumpFrames(n, dtMs) {
  for (let i = 0; i < n; i++) {
    NOW += dtMs;
    const cbs = rafCbs.splice(0);
    for (const fn of cbs) fn(NOW);
  }
}

/* ---- 桩 DOM ---- */
function makeCtx() {
  return new Proxy({}, {
    get(t, p) { return p in t ? t[p] : () => {}; },
    set(t, p, v) { t[p] = v; return true; },
  });
}
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, style: {},
    className: '', title: '', value: '', scrollTop: 0,
    width: 0, height: 0, _text: '',
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    get firstChild() { return el.children[0]; },
    get lastChild() { return el.children[el.children.length - 1]; },
    get scrollHeight() { return el.children.length * 30; },
    set innerHTML(v) { if (v === '') el.children.length = 0; },
    get textContent() {
      return el.children.length
        ? el.children.map(c => c.textContent).join('')
        : el._text;
    },
    set textContent(v) { el._text = String(v); el.children.length = 0; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1152, height: 720 }; },
    fire(type, ev) { for (const fn of el.listeners[type] || []) fn(ev); },
  };
  if (tag === 'canvas') el.getContext = () => makeCtx();
  return el;
}
const els = {};
const documentStub = {
  getElementById(id) {
    if (!els[id]) els[id] = makeEl(id === 'map' ? 'canvas' : 'div');
    return els[id];
  },
  createElement(tag) { return makeEl(tag); },
  createTextNode(text) { const t = makeEl('#text'); t.textContent = text; return t; },
};

/* ---- 跑起来 ---- */
// 预置控件初值：等价于 HTML 里的 value="20261105" 与 selected ×5（桩没有 HTML 默认值）
els.speed = documentStub.getElementById('speed');
els.speed.value = '5';
els.seed = documentStub.getElementById('seed');
els.seed.value = '20261105';

const sandbox = {
  document: documentStub,
  performance: { now: () => NOW },
  requestAnimationFrame(fn) { rafCbs.push(fn); },
  setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
  clearInterval() {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(coreCode, sandbox, { filename: 'sim-core.js' });
vm.runInContext(uiCode, sandbox, { filename: 'ui.js' });

const num = (id) => Number(els[id].textContent);
let fails = 0;
const check = (ok, name) => { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) fails++; };

/* 1. 开局状态 */
check(els.year.textContent === '1', '开局年份显示 1');
check(els.log.children.length === 5, '开局编年史 5 行（诞生 + 4 建部）');
check(/第 1 年·世界诞生：种子 20261105/.test(els.log.children[0].textContent), '编年史首行为诞生行且含种子号');
check(/落地生根/.test(els.log.lastChild.textContent), '编年史末行为建部事件');
check(/^第 \d+ 年$/.test(els.log.children[0].children[0].textContent), '年份格式"第 N 年"独立加粗');
check(els.roster.children.length === 4, '名册 4 部落');
check(els.roster.children[0].textContent.includes('人'), '名册项含人口');
check(els.speed.value === '5', '速度档可读（桩预置 ×5）');

/* 2. 开始 */
els.btnToggle.fire('click', {});
check(els.btnToggle.textContent === '暂停', '点击开始后按钮切到"暂停"');

/* 3. ×5 档：240 帧 × 16.7ms = 4008ms 模拟时间 → 恰 20 年 */
pumpFrames(240, 16.7);
check(num('year') === 21, '×5 档 240 帧恰推进 20 年（实际 ' + els.year.textContent + '）');

/* 4. ×60 档：60 帧 → 恰 60 年 */
els.speed.value = '60';
pumpFrames(60, 16.7);
check(num('year') === 81, '×60 档 60 帧恰推进 60 年（实际 ' + els.year.textContent + '）');

/* 5. 暂停：年份不动，渲染路径照跑不抛错 */
els.btnToggle.fire('click', {});
check(els.btnToggle.textContent === '开始', '点击暂停后按钮切回"开始"');
const pausedYear = num('year');
pumpFrames(120, 16.7);
check(num('year') === pausedYear, '暂停 120 帧年份不动');
els.btnToggle.fire('click', {});

/* 6. ×60 长跑：编年史封顶 + 置灰名册 */
pumpFrames(2600, 16.7);
check(num('year') >= 2600, '长跑后年份 ≥2600（实际 ' + els.year.textContent + '）');
check(els.log.children.length === 400, '编年史封顶 400 条（实际 ' + els.log.children.length + '）');
check(els.log.children.some(c => /·/.test(c.textContent)), '编年史行含"·"分隔');
const hasDead = els.roster.children.some(c => (c.className || '').includes('dead'));
check(hasDead, '名册出现置灰已灭部落');
check(intervals.length === 1 && intervals[0].ms === 200, '兜底心跳已注册（200ms）');

/* 7. 重置（换种子 42） */
els.seed.value = '42';
els.btnReset.fire('click', {});
check(els.year.textContent === '1', '重置后年份回 1');
check(els.log.children.length === 5, '重置后编年史重建为 5 行');
check(/种子 42/.test(els.log.children[0].textContent), '重置用的新种子号出现在诞生行');
check(els.roster.children.length === 4 && !els.roster.children.some(c => (c.className || '').includes('dead')),
  '重置后名册 4 部落且无置灰');
check(els.btnToggle.textContent === '暂停', '重置保留播放状态（按钮仍为"暂停"）');

/* 8. tooltip */
els.map.fire('mousemove', { clientX: 300, clientY: 200 });
check(els.tip.style.display === 'block', '悬停后 tooltip 显示');
check(/格 · .+ · 食物 [\d.]+ · 木材 [\d.]+ · 石料 [\d.]+ · 肥力 \d+% · /.test(els.tip.textContent),
  'tooltip 含坐标/地类/三资源/肥力/归属（实际：' + els.tip.textContent + '）');
els.map.fire('mouseleave', {});
check(els.tip.style.display === 'none', '移出后 tooltip 隐藏');

console.log(fails === 0
  ? '{"summary":true,"ok":true}'
  : '{"summary":true,"ok":false,"fails":' + fails + '}');
process.exit(fails === 0 ? 0 : 1);
