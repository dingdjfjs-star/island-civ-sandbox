#!/usr/bin/env node
/* 孤岛文明沙盘 · UI 静态冒烟（阶段四新增；node 直跑，无依赖）
   用法：node test/ui-smoke.js
   检查（全部静态，不开浏览器）：
     1. SIM-CORE 标记存在且顺序正确；核心区无 DOM/BOM API、无网络调用（纯逻辑纪律）
     2. END 之后的渲染/UI 脚本可被 vm 编译（语法自证）
     3. UI 无 fetch/import/XHR/require、整页无外链（file:// 直开纪律）
     4. UI 里 $('id') 引用的元素都真实存在于 HTML
     5. 速度档 ×1/×2/×5/×20/×60 齐全；编年史配色覆盖全部 9 类事件；tooltip 就位
     6. 核心仍可挂载 IslandSim 并 createWorld + tick 冒烟（与 probe 同法抽核心） */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const B = '/* ===== SIM-CORE-BEGIN ===== */';
const E = '/* ===== SIM-CORE-END ===== */';
const bi = html.indexOf(B), ei = html.indexOf(E);
let fails = 0;
const check = (ok, name) => { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) fails++; };

check(bi >= 0 && ei > bi, 'SIM-CORE 标记存在且顺序正确');
if (bi < 0 || ei < bi) process.exit(2);

const core = html.slice(bi, ei);
// 按"调用形态"查（document. / window. / localStorage. / rAF( )），措辞提及（如纪律注释）不算违例
check(!/\bdocument\s*\./.test(core) && !/\bwindow\s*\./.test(core)
  && !/\blocalStorage\s*[.[(]/.test(core) && !/\brequestAnimationFrame\s*\(/.test(core)
  && !/\bHTMLElement\b/.test(core), '核心区无 DOM/BOM API 调用');
check(!/\bfetch\s*\(|XMLHttpRequest/.test(core), '核心区无网络调用');

const after = html.slice(ei + E.length);
const scripts = Array.from(after.matchAll(/<script>([\s\S]*?)<\/script>/g), m => m[1]);
check(scripts.length >= 1, 'END 之后存在渲染/UI 脚本段');
const ui = scripts.join('\n;\n');
try { new vm.Script(ui, { filename: 'ui.js' }); check(true, 'UI 脚本语法可编译'); }
catch (e) { check(false, 'UI 脚本语法可编译（' + e.message + '）'); }
check(!/\bfetch\s*\(|XMLHttpRequest|\bimport\s*\(|\brequire\s*\(/.test(ui), 'UI 无网络/模块依赖（file:// 纪律）');
check(!/https?:\/\//.test(html), '整页无外链');
check(/\brequestAnimationFrame\s*\(/.test(ui), 'UI 使用 rAF 主循环');
check(/\bsetInterval\s*\(/.test(ui), 'UI 具备节流兜底心跳（后台标签页 rAF 停摆时仍推进）');

const ids = Array.from(new Set(Array.from(ui.matchAll(/\$\('([\w-]+)'\)/g), m => m[1]))).sort();
for (const id of ids) check(html.includes('id="' + id + '"'), '元素 #' + id + ' 存在');

const speedSel = html.match(/<select id="speed"[^>]*>([\s\S]*?)<\/select>/);
const speedOk = !!speedSel
  && Array.from(speedSel[1].matchAll(/value="(\d+)"/g), m => m[1]).join(',') === '1,2,5,20,60';
check(speedOk, '速度档 ×1/×2/×5/×20/×60 齐全');

for (const tp of ['founded', 'contact', 'conflict', 'peace', 'merge', 'split', 'famine', 'migrated', 'extinct'])
  check(ui.includes("'" + tp + "'"), '编年史配色覆盖 ' + tp);
check(/id="tip"/.test(html) && /\$\('tip'\)/.test(ui), '悬停 tooltip 元素就位');

/* 核心冒烟：与 probe 同法抽核心，确认 IslandSim 仍可挂载并推进 */
vm.runInThisContext(html.slice(bi, ei + E.length), { filename: 'sim-core.js' });
const IS = globalThis.IslandSim;
check(!!IS && typeof IS.CONFIG === 'object' && typeof IS.createWorld === 'function', 'IslandSim 挂载完好');
if (IS) {
  const w = IS.createWorld(20261105);
  const fresh = w.tick();
  check(Array.isArray(fresh) && w.year === IS.CONFIG.startYear + 1, 'createWorld + tick 冒烟通过');
}

console.log(fails === 0
  ? '{"summary":true,"ok":true}'
  : '{"summary":true,"ok":false,"fails":' + fails + '}');
process.exit(fails === 0 ? 0 : 1);
