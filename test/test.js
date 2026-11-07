#!/usr/bin/env node
/* 孤岛文明沙盘 · headless 断言套件（test/test.js）
   ============================================================
   风格：大量小断言；失败全部列出；全绿退出码 0，任一失败退出码 1。
   运行：node test/test.js（约 20~30 秒）

   覆盖（对应阶段五"平衡 + 测试 + 文档"任务书）：
   A. SIM-CORE 可抽取：标记恰一次、顺序正确、求值后 IslandSim 挂载齐全；
      核心区剥离注释与字符串后无任何 DOM/BOM/网络引用
   B. CONFIG 契约：键无 undefined、全为有限数字、各阶段契约键在位（防改名/删除）
   C. 地形健全：结构一致、landRatio ∈ [0.18, 0.50]、十种子地型并集覆盖七类、
      资源/肥力取值范围、海格资源恒零
   D. 确定性：同种子两次运行 2000 年——全程事件流逐位一致 + 终局世界哈希一致；
      不同种子事件流不同
   E. 运行不变量（10 种子 × 2000 年逐年）：无 NaN/负人口/负库存、库存不越上限、
      年份逐年推进、事件史不越限、事件形如 {year,type,text} 且 type 英文小写、
      领地归属互洽（部落数组 ↔ claims 双向）、id 唯一升序、总人口有硬上界
   F. 平衡门槛（10 种子 × 2000 年）：
      - 开局沉寂：首个非 founded 事件年 ≥ 4（实测最小 8）
      - 随后扩张：第 100 年总人口 ≥ 8 × 第 10 年（实测 ≥15.2×）；
                  人口峰值 ≥ 15 × 开局人口（实测 ≥34×）
      - 数十年到百年内相遇冲突：全部种子首次冲突 ≤ 200 年，且 ≥ 8/10 种子 ≤ 150 年
        （实测 41~116 年）
      - 间或有迁徙浪潮：≥ 8/10 种子"迁徙总数 ≥ 30 且任意 50 年窗 ≥ 8 次"（实测 10/10）
      - 终局几家共存：≥ 8/10 种子终局 ≥ 3 部落（实测 3~12）；全部种子终局 ≥ 1 部落
      - 全局出现过迁徙与灭亡；≥ 6/10 种子出现过冲突；≥ 5/10 种子出现过合并或分裂
      - 不允许全体灭绝（终局 ≥ 1 部落即等价——部落只能由分裂/建部产生，无重生机制）
      - 不允许世界冻结：第 100 年后最大无事件间隔 ≤ 120 年（实测 ≤ 28 年）
      - 总人口上界：任意年份 ≤ 陆地格数 × tileFoodYield × overFrac ÷ popEat × 2
   G. 性能：单种子 2000 年（含建世） < 3 秒（取两次计时较小值，防机器抖动误报）

   平衡回归种子集（10 个，调参后重跑本套件即为回归）：
     20261105, 42, 99, 1, 7, 123, 777, 2024, 314159, 9527 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ================= 断言收集器 ================= */
const failures = [];
let passCount = 0;
let section = '';
function ok(cond, msg) {
  if (cond) { passCount++; return true; }
  failures.push('[' + section + '] ' + msg);
  return false;
}
function eq(actual, want, msg) {
  return ok(actual === want, msg + '（实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(want) + '）');
}
function banner(t) { section = t; console.log('\n---- ' + t + ' ----'); }

/* ================= A. SIM-CORE 抽取与纪律 ================= */
const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const BEGIN = '/* ===== SIM-CORE-BEGIN ===== */';
const END = '/* ===== SIM-CORE-END ===== */';

banner('A. SIM-CORE 抽取与纪律');
eq(html.split(BEGIN).length - 1, 1, 'A1 SIM-CORE-BEGIN 标记恰出现一次');
eq(html.split(END).length - 1, 1, 'A2 SIM-CORE-END 标记恰出现一次');
const bi = html.indexOf(BEGIN);
const ei = html.indexOf(END);
ok(bi >= 0 && ei > bi, 'A3 两标记都存在且 END 在 BEGIN 之后');
const core = html.slice(bi + BEGIN.length, ei);
ok(core.length > 1000, 'A4 核心区非空（' + core.length + ' 字符）');

/* 剥离注释与字符串字面量后再扫违禁词（避免注释里"禁止 document"这类说明误报） */
function stripCommentsAndStrings(src) {
  let out = '';
  let state = 'code';                           // code | line | block | str1 | str2 | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i++; out += ' '; continue; }
      if (c === '/' && n === '*') { state = 'block'; i++; out += ' '; continue; }
      if (c === "'") { state = 'str1'; out += ' '; continue; }
      if (c === '"') { state = 'str2'; out += ' '; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; continue; }
      out += c;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; }
    } else if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i++; out += ' '; }
    } else if (state === 'str1') {
      if (c === '\\') i++;
      else if (c === "'") state = 'code';
    } else if (state === 'str2') {
      if (c === '\\') i++;
      else if (c === '"') state = 'code';
    } else if (state === 'tpl') {
      if (c === '\\') i++;
      else if (c === '`') state = 'code';
    }
  }
  return out;
}
const coreCode = stripCommentsAndStrings(core);
const BANNED = ['document', 'window', 'navigator', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'alert', 'confirm', 'prompt', 'fetch',
  'XMLHttpRequest', 'WebSocket', 'import', 'require', 'module', 'exports',
  'getElementById', 'querySelector', 'createElement', 'addEventListener',
  'getContext', 'canvas', 'HTMLElement', 'performance', 'location', 'history',
  'Image', 'Audio'];
for (const word of BANNED) {
  const re = new RegExp('\\b' + word + '\\b');
  ok(!re.test(coreCode), 'A5 核心区无 DOM/BOM/网络引用：' + word);
}

/* 求值核心区 */
vm.runInThisContext(BEGIN + core + END, { filename: 'sim-core.js' });
const IS = globalThis.IslandSim;
ok(typeof IS === 'object' && IS !== null, 'A6 globalThis.IslandSim 已挂载');
if (IS) {
  ok(typeof IS.CONFIG === 'object', 'A7 IslandSim.CONFIG 是对象');
  ok(typeof IS.createWorld === 'function', 'A8 IslandSim.createWorld 是函数');
  ok(typeof IS.mulberry32 === 'function', 'A9 IslandSim.mulberry32 导出在位');
  ok(typeof IS.createPerlin === 'function', 'A10 IslandSim.createPerlin 导出在位');
  ok(typeof IS.fbm === 'function', 'A11 IslandSim.fbm 导出在位');
  ok(typeof IS.TERRAIN_NAMES === 'object', 'A12 IslandSim.TERRAIN_NAMES 导出在位');
}

/* ================= B. CONFIG 契约 ================= */
banner('B. CONFIG 契约');
const C = IS.CONFIG;
{
  const keys = Object.keys(C);
  ok(keys.length >= 80, 'B1 CONFIG 键数量合理（' + keys.length + ' 个）');
  for (const k of keys) {
    ok(C[k] !== undefined, 'B2 CONFIG.' + k + ' 非 undefined');
    if (C[k] !== undefined) {
      ok(typeof C[k] === 'number' && Number.isFinite(C[k]), 'B3 CONFIG.' + k + ' 是有限数字');
    }
  }
  const CONTRACT_KEYS = [        // 接口契约键（阶段一~三确立，不许改名/删除）
    'seed', 'mapW', 'mapH', 'tilePx', 'startYear', 'eventsLimit', 'landTarget',
    'initialTribes', 'popInitMin', 'popInitMax', 'popEat', 'popPerTile',
    'migrateRadius', 'fertCollapse', 'conflictBase', 'mergePopFrac', 'peaceYears',
    'splitThreshold', 'contactBreakGap', 'stockCapFood', 'extinctPop',
  ];
  for (const k of CONTRACT_KEYS) ok(C[k] !== undefined, 'B4 契约键在位：CONFIG.' + k);
}

/* ================= C. 地形健全 ================= */
banner('C. 地形健全');
const ALL_TYPES = ['deepsea', 'shallowsea', 'beach', 'plain', 'forest', 'mountain', 'snow'];
{
  const w = IS.createWorld(20261105);
  const t = w.terrain;
  eq(t.w, C.mapW, 'C1 terrain.w = CONFIG.mapW');
  eq(t.h, C.mapH, 'C2 terrain.h = CONFIG.mapH');
  eq(t.tiles.length, C.mapW * C.mapH, 'C3 tiles 数 = w×h');
  let land = 0, sea = 0, badRange = 0, seaBad = 0;
  const seen = new Set();
  for (const tile of t.tiles) {
    seen.add(tile.type);
    if (tile.type === 'deepsea' || tile.type === 'shallowsea') { sea++; continue; }
    land++;
    if (!(tile.fert >= 0 && tile.fert <= 1)) badRange++;
    for (const k of ['food', 'wood', 'stone']) {
      if (!(tile.res[k] >= 0 && tile.res[k] <= 1)) badRange++;
      if (!(tile.base[k] >= 0 && tile.base[k] <= 1)) badRange++;
    }
  }
  eq(land, t.stats.land, 'C4 stats.land 与 tiles 一致');
  eq(sea, t.stats.sea, 'C5 stats.sea 与 tiles 一致');
  ok(t.stats.landRatio >= 0.18 && t.stats.landRatio <= 0.50,
    'C6 landRatio ∈ [0.18, 0.50]（实际 ' + t.stats.landRatio.toFixed(4) + '）');
  eq(t.landIdxs.length, land, 'C7 landIdxs 长度 = 陆地格数');
  eq(badRange, 0, 'C8 陆地资源/肥力都在 [0,1]');
  let seaRes = 0;
  for (const tile of t.tiles) {
    if (tile.type === 'deepsea' || tile.type === 'shallowsea') {
      if (tile.res.food !== 0 || tile.res.wood !== 0 || tile.res.stone !== 0 || tile.fert !== 0) seaRes++;
    }
  }
  eq(seaRes, 0, 'C9 海格资源与肥力恒零');
  ok(t.seaLevel >= C.seaLevelMin && t.seaLevel <= C.seaLevelMax,
    'C10 海平面在钳制区间内（' + t.seaLevel.toFixed(4) + '）');
  ok(seen.has('deepsea') && seen.has('shallowsea') && seen.has('beach') && seen.has('plain')
    && seen.has('mountain'), 'C11 本种子含深海/浅海/沙滩/平原/山地');
}
const BAL_SEEDS = [20261105, 42, 99, 1, 7, 123, 777, 2024, 314159, 9527];
{
  const union = new Set();
  let minRatio = 1, maxRatio = 0;
  for (const s of BAL_SEEDS) {
    const st = IS.createWorld(s).terrain.stats;
    for (const k of Object.keys(st.counts)) union.add(k);
    minRatio = Math.min(minRatio, st.landRatio);
    maxRatio = Math.max(maxRatio, st.landRatio);
  }
  for (const tp of ALL_TYPES) ok(union.has(tp), 'C12 十种子并集含地型 ' + tp);
  ok(minRatio >= 0.18 && maxRatio <= 0.50,
    'C13 十种子 landRatio 全在 [0.18, 0.50]（' + minRatio.toFixed(3) + '~' + maxRatio.toFixed(3) + '）');
}

/* ================= D. 确定性 ================= */
banner('D. 确定性（同种子两次运行逐位一致）');
function fnv(str, h) {
  h = h >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function hashWorld(w) {                          // 终局世界哈希：地形演化 + 归属 + 部落 + 史册
  let h = 2166136261 >>> 0;
  h = fnv('year=' + w.year + ';sea=' + w.terrain.seaLevel.toFixed(9) + ';', h);
  for (const tl of w.terrain.tiles) {
    h = fnv(tl.type + ',' + tl.fert.toFixed(7) + ',' + tl.res.food.toFixed(7)
      + ',' + tl.res.wood.toFixed(7) + ',' + tl.res.stone.toFixed(7) + ';', h);
  }
  for (let i = 0; i < w.claims.length; i++) h = fnv(w.claims[i] + ',', h);
  for (const tr of w.tribes) {
    h = fnv(tr.id + ',' + tr.name + ',' + tr.color + ',' + tr.x + ',' + tr.y + ','
      + tr.pop.toFixed(6) + ',' + tr.food + ',' + tr.wood + ',' + tr.stone + ','
      + JSON.stringify(tr.tiles) + ';', h);
  }
  h = fnv('events=' + JSON.stringify(w.events), h);
  return h;
}
function runStream(seed, ticks) {                // 返回 {stream, world, hash}
  const w = IS.createWorld(seed);
  const stream = [];
  for (let i = 0; i < ticks; i++) {
    const fresh = w.tick();
    for (const ev of fresh) stream.push(ev);
  }
  return { w, stream, hash: hashWorld(w) };
}
{
  const A = runStream(20261105, 2000);
  const B = runStream(20261105, 2000);
  eq(JSON.stringify(A.stream), JSON.stringify(B.stream), 'D1 同种子事件流逐位一致');
  eq(A.hash, B.hash, 'D2 同种子终局世界哈希一致');
  const X = runStream(42, 2000);
  ok(A.hash !== X.hash, 'D3 不同种子终局世界不同');
  ok(JSON.stringify(A.stream) !== JSON.stringify(X.stream), 'D4 不同种子事件流不同');
}

/* ================= E+F. 运行不变量 + 平衡门槛（10 种子 × 2000 年） ================= */
banner('E. 运行不变量（10 种子 × 2000 年）');
const KNOW_TYPES = /^(founded|contact|conflict|peace|merge|split|famine|migrated|extinct|note)$/;
const perSeed = [];
{
  const ticks = 2000;
  const popCeil = null;                          // 每种子按其陆地格数现算
  for (const seed of BAL_SEEDS) {
    const w = IS.createWorld(seed);
    const t = w.terrain;
    const hardCeil = t.landIdxs.length * C.tileFoodYield * C.overFrac / C.popEat * 2;
    const stat = {
      seed, hardCeil,
      initPop: Math.round(w.tribes.reduce((a, x) => a + x.pop, 0)),
      pop10: -1, pop100: -1, maxPop: 0,
      firstNonFounded: -1, firstConflict: -1,
      maxGapAfter100: 0, lastEvYear: 1,
      migrated: 0, extinct: 0, conflict: 0, merge: 0, split: 0,
      waveMax: 0,
    };
    const waveBuckets = new Array(Math.ceil(ticks / 50)).fill(0);
    const typeSeen = new Set();
    for (let i = 0; i < ticks; i++) {
      const fresh = w.tick();
      /* —— 事件形状（全程）—— */
      for (const ev of fresh) {
        ok(ev !== null && typeof ev === 'object', 'E1 事件是对象（seed ' + seed + ' y' + w.year + '）');
        ok(Number.isInteger(ev.year) && ev.year === w.year, 'E2 事件年份 = 当前年（seed ' + seed + '）');
        ok(typeof ev.type === 'string' && /^[a-z]+$/.test(ev.type),
          'E3 事件 type 英文小写（实际 ' + JSON.stringify(ev.type) + '）');
        ok(typeof ev.text === 'string' && ev.text.length > 0, 'E4 事件 text 非空中文（seed ' + seed + ' y' + w.year + '）');
        ok(KNOW_TYPES.test(ev.type), 'E5 事件 type 属已知集合（实际 ' + ev.type + '）');
        typeSeen.add(ev.type);
        if (ev.type !== 'founded' && stat.firstNonFounded < 0) stat.firstNonFounded = ev.year;
        if (ev.type === 'conflict' && stat.firstConflict < 0) stat.firstConflict = ev.year;
        if (ev.year - stat.lastEvYear > stat.maxGapAfter100 && stat.lastEvYear >= 100) {
          stat.maxGapAfter100 = ev.year - stat.lastEvYear;
        }
        stat.lastEvYear = ev.year;
        if (ev.type === 'migrated') { stat.migrated++; waveBuckets[Math.min(waveBuckets.length - 1, ((ev.year - 1) / 50) | 0)]++; }
        if (ev.type === 'extinct') stat.extinct++;
        if (ev.type === 'conflict') stat.conflict++;
        if (ev.type === 'merge') stat.merge++;
        if (ev.type === 'split') stat.split++;
      }
      /* —— 逐年不变量：人口/库存/年份/上界 —— */
      let pop = 0;
      for (const tr of w.tribes) {
        ok(Number.isFinite(tr.pop) && tr.pop >= 0, 'E6 人口有限非负（seed ' + seed + ' y' + w.year + '）');
        ok(Number.isFinite(tr.food) && tr.food >= 0 && Number.isFinite(tr.wood) && tr.wood >= 0
          && Number.isFinite(tr.stone) && tr.stone >= 0,
          'E7 三库存有限非负（seed ' + seed + ' y' + w.year + '）');
        ok(tr.food <= C.stockCapFood && tr.wood <= C.stockCapWood && tr.stone <= C.stockCapStone,
          'E8 库存不越上限（seed ' + seed + ' y' + w.year + '）');
        ok(Number.isInteger(tr.x) && Number.isInteger(tr.y), 'E9 据点坐标为整数（seed ' + seed + ' y' + w.year + '）');
        pop += tr.pop;
      }
      ok(Number.isFinite(pop) && pop <= hardCeil,
        'E10 总人口 ≤ 硬上界 ' + Math.round(hardCeil) + '（seed ' + seed + ' y' + w.year + ' pop ' + Math.round(pop) + '）');
      eq(w.year, C.startYear + i + 1, 'E11 年份逐年 +1（seed ' + seed + ' 第 ' + (i + 1) + ' tick）');
      ok(w.events.length <= C.eventsLimit, 'E12 事件史不越限（seed ' + seed + ' y' + w.year + '）');
      if (pop > stat.maxPop) stat.maxPop = pop;
      if (w.year === 10) stat.pop10 = Math.round(pop);
      if (w.year === 100) stat.pop100 = Math.round(pop);
      /* —— 每 100 年与终局：归属互洽 + 地形有限 —— */
      if ((i + 1) % 100 === 0 || i === ticks - 1) {
        const alive = new Set(w.tribes.map(x => x.id));
        let lastId = 0, claimBad = 0, orderBad = 0;
        for (const tr of w.tribes) {
          if (!(Number.isInteger(tr.id) && tr.id > lastId)) orderBad++;
          lastId = tr.id;
          for (const idx of tr.tiles) if (w.claims[idx] !== tr.id) claimBad++;
        }
        for (let ci = 0; ci < w.claims.length; ci++) {
          const cid = w.claims[ci];
          if (cid !== 0 && !alive.has(cid)) claimBad++;
        }
        eq(claimBad, 0, 'E14 领地归属互洽（seed ' + seed + ' y' + w.year + '）');
        eq(orderBad, 0, 'E13 部落 id 唯一且升序（seed ' + seed + ' y' + w.year + '）');
        let nanTiles = 0;
        for (const tile of t.tiles) {
          if (!Number.isFinite(tile.fert) || tile.fert < 0 || tile.fert > 1) nanTiles++;
          for (const k of ['food', 'wood', 'stone']) {
            if (!Number.isFinite(tile.res[k]) || tile.res[k] < 0 || tile.res[k] > 1) nanTiles++;
            if (!Number.isFinite(tile.base[k]) || tile.base[k] < 0 || tile.base[k] > 1) nanTiles++;
          }
        }
        eq(nanTiles, 0, 'E16 地形肥力/资源有限且在域内（seed ' + seed + ' y' + w.year + '）');
      }
    }
    stat.waveMax = Math.max.apply(null, waveBuckets);
    stat.endTribes = w.tribes.length;
    stat.endPop = Math.round(w.tribes.reduce((a, x) => a + x.pop, 0));
    stat.types = Array.from(typeSeen);
    perSeed.push(stat);
    console.log('  seed ' + seed + '：终局 ' + stat.endTribes + ' 部落 / ' + stat.endPop + ' 人，峰值 '
      + Math.round(stat.maxPop) + '，首冲突 y' + stat.firstConflict + '，迁徙 ' + stat.migrated
      + '（50 年窗峰值 ' + stat.waveMax + '），灭绝 ' + stat.extinct + '，年百后最大事件间隔 '
      + stat.maxGapAfter100 + ' 年');
  }
}

/* ---- E 组汇总断言 ---- */
{
  const bad = perSeed.filter(s => s.endTribes === 0);
  eq(bad.length, 0, 'E17 无任何种子全体灭绝');
}

/* ================= F. 平衡门槛 ================= */
banner('F. 平衡门槛（好玩标准，阈值见文件头注释）');
{
  const n = perSeed.length;
  const cnt = (f) => perSeed.filter(f).length;

  ok(cnt(s => s.firstNonFounded >= 4) === n, 'F1 开局沉寂：全部种子首个非建部事件年 ≥ 4');
  ok(cnt(s => s.pop100 >= 8 * s.pop10) === n, 'F2 随后扩张：第 100 年人口 ≥ 8 × 第 10 年');
  ok(cnt(s => s.maxPop >= 15 * s.initPop) === n, 'F3 随后扩张：人口峰值 ≥ 15 × 开局人口');
  ok(cnt(s => s.firstConflict > 0 && s.firstConflict <= 200) === n, 'F4 全部种子 200 年内发生过冲突');
  ok(cnt(s => s.firstConflict > 0 && s.firstConflict <= 150) >= 8, 'F5 ≥ 8/10 种子 150 年内发生首场冲突');
  ok(cnt(s => s.endTribes >= 1) === n, 'F6 全部种子终局仍有存活部落（不允许 2000 年内全体灭绝）');
  ok(cnt(s => s.endTribes >= 3) >= 8, 'F7 ≥ 8/10 种子终局 ≥ 3 部落（终局几家共存）');
  ok(cnt(s => s.conflict > 0) >= 6, 'F8 ≥ 6/10 种子出现过冲突');
  ok(cnt(s => s.merge > 0 || s.split > 0) >= 5, 'F9 ≥ 5/10 种子出现过合并或分裂');
  ok(cnt(s => s.migrated > 0) === n || perSeed.some(s => s.migrated > 0), 'F10 全局出现过迁徙');
  ok(perSeed.reduce((a, s) => a + s.extinct, 0) >= 1, 'F11 全局出现过灭亡');
  ok(cnt(s => s.migrated >= 30 && s.waveMax >= 8) >= 8, 'F12 ≥ 8/10 种子有成规模迁徙浪潮（总数 ≥ 30 且 50 年窗 ≥ 8）');
  ok(cnt(s => s.maxGapAfter100 <= 120) === n, 'F13 不冻结：第 100 年后最大无事件间隔 ≤ 120 年');
  ok(cnt(s => s.maxPop <= s.hardCeil) === n, 'F14 人口峰值 ≤ 硬上界');
}

/* ================= G. 性能 ================= */
banner('G. 性能（单种子 2000 年 < 3 秒）');
{
  const t0 = Date.now();
  const w1 = IS.createWorld(20261105);
  for (let i = 0; i < 2000; i++) w1.tick();
  const ms1 = Date.now() - t0;
  const t1 = Date.now();
  const w2 = IS.createWorld(20261105);
  for (let i = 0; i < 2000; i++) w2.tick();
  const ms2 = Date.now() - t1;
  const best = Math.min(ms1, ms2);
  console.log('  两次计时：' + ms1 + ' ms / ' + ms2 + ' ms（取较小值 ' + best + ' ms 评判，防机器抖动）');
  ok(best < 3000, 'G1 单种子 2000 年 < 3000 ms（实际 ' + best + ' ms）');
}

/* ================= H. 建世契约杂项 ================= */
banner('H. 建世契约杂项');
{
  const w0 = IS.createWorld();
  eq(w0.seed, C.seed, 'H1 createWorld() 不传参回退 CONFIG.seed');
  const wN = IS.createWorld(NaN);
  eq(wN.seed, C.seed, 'H2 createWorld(NaN) 回退 CONFIG.seed');
  const wF = IS.createWorld(1.9);
  eq(wF.seed, 1, 'H3 createWorld(1.9) 取整为 1');
  ok(typeof w0.tick === 'function' && Array.isArray(w0.tribes) && Array.isArray(w0.events)
    && w0.terrain && typeof w0.year === 'number', 'H4 world 结构齐备（tick/tribes/events/terrain/year）');
  const fresh0 = w0.tick();
  ok(Array.isArray(fresh0), 'H5 tick() 返回数组');
  eq(w0.year, C.startYear + 1, 'H6 tick() 后年份推进一年');
}

/* ================= 汇总 ================= */
console.log('\n================ 汇总 ================');
console.log('断言总数 ' + (passCount + failures.length) + '，通过 ' + passCount + '，失败 ' + failures.length);
if (failures.length) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('FAIL  ' + f);
  process.exit(1);
} else {
  console.log('全部通过 ✔  退出码 0');
  process.exit(0);
}
