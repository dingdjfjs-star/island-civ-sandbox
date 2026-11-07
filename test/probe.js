#!/usr/bin/env node
/* 孤岛文明沙盘 · SIM-CORE 探针
   用法：node test/probe.js [--seed 20261105 | --seeds 20261105,42,99] [--ticks 2000]
   默认三种子 20261105/42/99，每个种子完整跑两遍。
   输出：每个种子一行 JSON；最后一行 {"summary":true,...} 汇总；任一门槛不过 → 退出码 1。
   门槛（每种子）：
     1. landRatio ∈ [0.18, 0.50]
     2. 无 NaN：地形（elev/moist/forest/fert/res/base）与部落（pop/food/wood/stone/x/y）
     3. 归属一致：claims 无悬空 id、部落领地与归属表互洽、部落 id 不重不乱序
     4. 年份推进正确；world.events 不越 CONFIG.eventsLimit
     5. 总人口 ≤ 全岛承载力硬上界（陆地格数 × tileFoodYield × overFrac ÷ popEat × 2，抓失控爆炸）
     6. 同种子两遍逐位一致：全程事件流哈希 + 终局世界哈希 + 史册 JSON 三重比对
     7. --ticks ≥ 2000（节奏自检）：contact/conflict/merge/migrated/split/extinct 六类事件
        必须都出现在全程事件流中——事件流取自每年 tick 的返回值，不受 eventsLimit 截断
        （史册只保留最近 400 条，早年事件会被挤出，故节奏断言不读 world.events） */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function argVal(name) {
  const i = process.argv.indexOf('--' + name);
  return (i >= 0 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : null;
}

const ticksRaw = argVal('ticks');
const ticks = Math.max(0, Math.floor(ticksRaw === null ? 200 : Number(ticksRaw)));
const seedsRaw = argVal('seeds');
const seedRaw = argVal('seed');
const seeds = seedsRaw !== null
  ? seedsRaw.split(',').map(Number).filter(s => Number.isFinite(s))
  : seedRaw !== null
    ? [Math.floor(Number(seedRaw))]
    : [20261105, 42, 99];             // 默认三种子：节奏自检（--ticks 2000）的最小样本
if (seeds.length === 0) { console.error('FAIL: 未提供有效种子'); process.exit(2); }

/* ---- 抽出并求值 SIM-CORE ---- */
const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const BEGIN = '/* ===== SIM-CORE-BEGIN ===== */';
const END = '/* ===== SIM-CORE-END ===== */';
const bi = html.indexOf(BEGIN);
const ei = html.indexOf(END);
if (bi < 0 || ei < 0 || ei < bi) {
  console.error('FAIL: index.html 缺少 SIM-CORE 标记');
  process.exit(2);
}
vm.runInThisContext(html.slice(bi, ei + END.length), { filename: 'sim-core.js' });

const IS = globalThis.IslandSim;
if (!IS || typeof IS.CONFIG !== 'object' || typeof IS.createWorld !== 'function') {
  console.error('FAIL: globalThis.IslandSim 未正确挂载');
  process.exit(2);
}

/* ---- 哈希工具（FNV-1a）---- */
function fnv(str, h) {
  h = h >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function hashWorld(w) {                           // 终局世界哈希：地形（含 fert/res 演化）+ 史册
  let h = 2166136261 >>> 0;
  h = fnv('seed=' + w.seed + ';year=' + w.year + ';sea=' + w.terrain.seaLevel.toFixed(9) + ';', h);
  for (const tl of w.terrain.tiles) {
    h = fnv(tl.x + ',' + tl.y + ',' + tl.elev.toFixed(7) + ',' + tl.moist.toFixed(7) + ',' + tl.type + ','
      + tl.forest.toFixed(5) + ',' + tl.fert.toFixed(5) + ','
      + tl.res.food.toFixed(5) + ',' + tl.res.wood.toFixed(5) + ',' + tl.res.stone.toFixed(5) + ';', h);
  }
  h = fnv('events=' + JSON.stringify(w.events), h);
  return h >>> 0;
}

/* ---- 单次运行：推进 ticks 年，收集全程事件流并逐步哈希 ---- */
function runOnce(seed, collect) {
  const w = IS.createWorld(seed);
  const stream = [];
  let h = 2166136261 >>> 0;
  for (let i = 0; i < ticks; i++) {
    const fresh = w.tick();
    for (const ev of fresh) {
      h = fnv(ev.year + '\u0001' + ev.type + '\u0001' + ev.text, h);
      if (collect) stream.push(ev);
    }
  }
  return { w, stream, streamHash: h >>> 0 };
}

/* ---- 终局体检：NaN / 归属一致性 / 总量统计 ---- */
function inspect(w) {
  let nanCount = 0, claimBad = 0, idDup = 0;
  let land = 0, forest = 0;
  const typeCounts = {};
  for (const tile of w.terrain.tiles) {
    typeCounts[tile.type] = (typeCounts[tile.type] || 0) + 1;
    if (tile.type === 'deepsea' || tile.type === 'shallowsea') continue;
    land++;
    if (tile.type === 'forest') forest++;
    if (!Number.isFinite(tile.elev) || !Number.isFinite(tile.moist)
      || !Number.isFinite(tile.forest) || !Number.isFinite(tile.fert)) nanCount++;
    const r = tile.res || {}, b = tile.base || {};
    for (const k of ['food', 'wood', 'stone']) {
      if (!Number.isFinite(r[k])) nanCount++;
      if (!Number.isFinite(b[k])) nanCount++;
    }
  }
  const alive = {};
  const ids = new Set();
  for (const tr of w.tribes) {
    if (ids.has(tr.id)) idDup++;
    ids.add(tr.id);
    alive[tr.id] = 1;
    for (const k of ['pop', 'food', 'wood', 'stone', 'x', 'y']) {
      if (!Number.isFinite(tr[k])) nanCount++;
    }
  }
  for (let i = 1; i < w.tribes.length; i++) {     // world.tribes 约定按 id 升序
    if (w.tribes[i].id <= w.tribes[i - 1].id) idDup++;
  }
  for (let i = 0; i < w.claims.length; i++) {     // 归属表不得指向已不存在的部落
    const c = w.claims[i];
    if (c !== 0 && !alive[c]) claimBad++;
  }
  for (const tr of w.tribes) {                    // 领地数组与归属表互洽
    for (const idx of tr.tiles) if (w.claims[idx] !== tr.id) claimBad++;
  }
  let totalPop = 0, territory = 0;
  for (const tr of w.tribes) { totalPop += tr.pop; territory += tr.tiles.length; }
  return { nanCount, claimBad, idDup, land, forest, typeCounts, totalPop, territory };
}

const NEED_TYPES = ['contact', 'conflict', 'merge', 'migrated', 'split', 'extinct'];
const results = [];
for (const seed of seeds) {
  const A = runOnce(seed, true);
  const B = runOnce(seed, false);
  const t = A.w.terrain;
  const ins = inspect(A.w);
  const total = t.tiles.length;
  const landRatio = total ? ins.land / total : 0;
  const forestOfLand = ins.land ? ins.forest / ins.land : 0;

  const deterministic = A.streamHash === B.streamHash
    && hashWorld(A.w) === hashWorld(B.w)
    && JSON.stringify(A.w.events) === JSON.stringify(B.w.events);
  const yearOk = A.w.year === IS.CONFIG.startYear + ticks;
  const eventsOk = Array.isArray(A.w.events) && A.w.events.length <= IS.CONFIG.eventsLimit;
  const ratioOk = landRatio >= 0.18 && landRatio <= 0.50;
  const popCeil = t.landIdxs.length * IS.CONFIG.tileFoodYield * IS.CONFIG.overFrac
    / IS.CONFIG.popEat * 2;                       // 承载力粗估 ×2 的宽松上界，只为抓失控爆炸
  const popOk = Number.isFinite(ins.totalPop) && ins.totalPop <= popCeil;

  const streamByType = {};
  for (const ev of A.stream) streamByType[ev.type] = (streamByType[ev.type] || 0) + 1;
  const eventsByType = {};
  for (const ev of A.w.events) eventsByType[ev.type] = (eventsByType[ev.type] || 0) + 1;
  const missingTypes = ticks >= 2000 ? NEED_TYPES.filter(tp => !streamByType[tp]) : [];
  const rhythmOk = missingTypes.length === 0;

  const ok = ratioOk && ins.nanCount === 0 && ins.claimBad === 0 && ins.idDup === 0
    && yearOk && eventsOk && deterministic && popOk && rhythmOk;

  console.log(JSON.stringify({
    ok, seed, ticks, year: A.w.year,
    landRatio: Number(landRatio.toFixed(4)),
    forestOfLand: Number(forestOfLand.toFixed(4)),
    typeCounts: ins.typeCounts,
    seaLevel: Number(t.seaLevel.toFixed(4)),
    nanCount: ins.nanCount,
    claimBad: ins.claimBad,
    idDup: ins.idDup,
    deterministic,
    popCeil: Math.round(popCeil),
    totalPop: Number(ins.totalPop.toFixed(1)),
    territory: ins.territory,
    tribes: A.w.tribes.length,
    events: A.w.events.length,
    streamEvents: A.stream.length,
    eventsByType,                                 // 史册内保留事件的分型计数（受 eventsLimit 截断）
    streamByType,                                 // 全程事件流分型计数（节奏自检用）
    missingTypes,
  }));
  results.push({ seed, ok });
}

const failed = results.filter(r => !r.ok).map(r => r.seed);
console.log(JSON.stringify({ summary: true, ok: failed.length === 0, ticks, ran: results.length, failedSeeds: failed }));
process.exit(failed.length === 0 ? 0 : 1);
