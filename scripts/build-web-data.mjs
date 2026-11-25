// BIG CYCLE 4단계: 화면용 데이터 묶음 만들기
// 실행: node scripts/build-web-data.mjs            (받아둔 자료를 쓰고, 없는 시리즈만 새로 받음)
//       node scripts/build-web-data.mjs --refresh  (FRED 자료를 전부 새로 받음. FRED_API_KEY 필요)
// 결과: web/data.js  (화면이 읽는 파일. web/index.html 을 브라우저로 열면 된다)

import { readFile, writeFile, mkdir, access, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ym, ymStr, loadSeries, toMonthly, toArray, parseFormula, combine, transform, percentileScores, weightedGroup } from "./build-scores.mjs";
import "../web/engine.js";

const E = globalThis.BCEngine;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const REFRESH = args.includes("--refresh");
const OFFLINE = args.includes("--offline");
const WITH_CDS = args.includes("--with-cds");   // CDS는 기본으로 뺀다. 넣으려면 이 옵션을 붙인다
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const RAW_DIR = argVal("--data-dir", join(ROOT, "data", "raw"));
const MANUAL_DIR = argVal("--manual-dir", join(ROOT, "data", "manual"));
const OUT_FILE = argVal("--out", join(ROOT, "web", "data.js"));
const exists = (p) => access(p).then(() => true, () => false);
const START = "1971-01";   // 화면에 싣는 자료의 시작
const notes = [];

async function getSeries(id, apiKey, required) {
  const file = join(RAW_DIR, `${id}.json`);
  const cached = await exists(file);
  try {
    if (cached && !REFRESH) return JSON.parse(await readFile(file, "utf8")).observations;
    if (OFFLINE) throw new Error("받아둔 자료 없음(--offline)");
    if (!apiKey) throw new Error("FRED_API_KEY 없음");
    return await loadSeries(id, apiKey);
  } catch (e) {
    if (cached) { notes.push(`${id}: 새로 받지 못해 받아둔 자료를 씀 (${e.message})`); return JSON.parse(await readFile(file, "utf8")).observations; }
    if (required) throw new Error(`${id}: ${e.message}`);
    notes.push(`${id}: 자료 없음, 화면에서 빈칸으로 표시 (${e.message})`);
    return null;
  }
}

// ---------- 발표 일정(전광판) ----------
const FRED = "https://api.stlouisfed.org/fred/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fredGet(path, params, apiKey) {
  const qs = new URLSearchParams({ ...params, api_key: apiKey, file_type: "json" });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(FRED + path + "?" + qs);
    if (res.status === 429) { await sleep(5000 * attempt); continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_message ?? `HTTP ${res.status}`);
    return body;
  }
  throw new Error("요청 한도 초과");
}
const readJson = async (file, fallback) => { try { return (await exists(file)) ? JSON.parse(await readFile(file, "utf8")) : fallback; } catch { return fallback; } };
const isoDay = (d) => d.toISOString().slice(0, 10);

// FRED 발표 달력에서 우리 지표가 속한 발표만 골라 3주치 일정을 만든다. 키가 없으면 지난번에 받아둔 일정을 그대로 쓴다.
async function buildSchedule(inds, apiKey) {
  const dir = join(ROOT, "data", "state");
  await mkdir(dir, { recursive: true });
  const mapFile = join(dir, "release-map.json"), schedFile = join(dir, "schedule.json");
  const prev = await readJson(schedFile, null);
  if (OFFLINE || !apiKey) { if (!prev) notes.push("발표 일정: FRED 키가 없어 받지 못함. 키를 넣고 실행하면 표시됨"); return prev; }
  try {
    const map = await readJson(mapFile, {});
    const sids = new Set();
    for (const x of inds) for (const s of x.series || []) sids.add(s);
    for (const s of sids) {
      if (map[s]) continue;
      const b = await fredGet("series/release", { series_id: s }, apiKey);
      const r = (b.releases || [])[0];
      map[s] = r ? { id: r.id, name: r.name } : { id: null, name: null };
      await sleep(150);
    }
    await writeFile(mapFile, JSON.stringify(map, null, 1), "utf8");

    const now = new Date(), mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7) - 1);   // 한국 시각과의 차이를 감안해 하루 앞에서 시작
    const end = new Date(mon); end.setUTCDate(end.getUTCDate() + 22);
    const from = isoDay(mon), to = isoDay(end);
    const inWindow = (list) => (list || []).filter((r) => r.date >= from && r.date <= to);
    const base = { include_release_dates_with_no_data: "true", realtime_start: from, realtime_end: "9999-12-31", order_by: "release_date", limit: "1000" };
    let rows = inWindow((await fredGet("releases/dates", { ...base, sort_order: "asc" }, apiKey)).release_dates);
    if (!rows.length) rows = inWindow((await fredGet("releases/dates", { ...base, sort_order: "desc" }, apiKey)).release_dates);

    const perRelease = new Map();
    for (const r of rows) perRelease.set(r.release_id, (perRelease.get(r.release_id) || 0) + 1);
    const byRelease = new Map();   // 발표 번호 -> 우리 지표
    for (const x of inds) for (const s of x.series || []) { const m = map[s]; if (m && m.id !== null) { if (!byRelease.has(m.id)) byRelease.set(m.id, new Set()); byRelease.get(m.id).add(x.id); } }
    const items = [];
    for (const r of rows) {
      if (!byRelease.has(r.release_id)) continue;
      if (perRelease.get(r.release_id) > 9) continue;   // 거의 매일 나오는 발표(금리 등)는 일정에서 뺀다
      items.push({ date: r.date, release: r.release_name, ids: [...byRelease.get(r.release_id)] });
    }
    const schedule = { fetched: new Date().toISOString(), from, to, items };
    await writeFile(schedFile, JSON.stringify(schedule, null, 1), "utf8");
    console.log(`발표 일정: ${from} ~ ${to} 사이 달력 ${rows.length}건 중 우리 지표 관련 ${items.length}건`);
    if (!rows.length) notes.push("발표 일정: FRED 달력에서 해당 기간 일정을 받지 못함");
    return schedule;
  } catch (e) {
    notes.push(`발표 일정을 새로 받지 못해 ${prev ? "지난번 일정을 씀" : "빈칸으로 둠"} (${e.message})`);
    return prev;
  }
}

async function loadShiller() {
  const file = join(MANUAL_DIR, "shiller.csv");
  if (!(await exists(file))) { notes.push("data/manual/shiller.csv 없음: 실러 PER과 S&P500 장기 차트를 뺌"); return null; }
  const lines = (await readFile(file, "utf8")).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].toLowerCase().split(",").map((s) => s.trim());
  const iD = head.indexOf("date"), iC = head.indexOf("cape"), iP = head.indexOf("sp500");
  const cape = new Map(), price = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (!/^\d{4}-\d{2}/.test(c[iD] ?? "")) continue;
    const m = ym(c[iD]), cv = Number(c[iC]), pv = Number(c[iP]);
    if (c[iC] !== "" && Number.isFinite(cv) && cv > 0) cape.set(m, cv);
    if (c[iP] !== "" && Number.isFinite(pv) && pv > 0) price.set(m, pv);
  }
  let source = "";
  const sf = join(MANUAL_DIR, "shiller-source.txt");
  if (await exists(sf)) source = (await readFile(sf, "utf8")).split(/\r?\n/).slice(0, 12).join("\n");
  return { cape, price, source };
}

function rollingPct(arr, minHist, window) {
  const out = new Array(arr.length).fill(null), buf = [];
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x === null) continue;
    buf.push(x);
    if (buf.length > window) buf.shift();
    if (buf.length < minHist) continue;
    let less = 0, eq = 0;
    for (const v of buf) { if (v < x) less++; else if (v === x) eq++; }
    out[i] = ((less + 0.5 * eq) / buf.length) * 100;
  }
  return out;
}

const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const lastIdxOf = (arr) => { let i = arr.length - 1; while (i >= 0 && arr[i] === null) i--; return i; };

async function main() {
  const config = JSON.parse(await readFile(join(ROOT, "config", "indicators.json"), "utf8"));
  const rules = config.rules;
  const apiKey = process.env.FRED_API_KEY;
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(MANUAL_DIR, { recursive: true });
  await mkdir(dirname(OUT_FILE), { recursive: true });
  if (REFRESH && !apiKey) { console.error("--refresh 에는 FRED_API_KEY 가 필요합니다."); process.exit(1); }

  // 1. 자료 모으기
  for (const ind of config.indicators) ind.calc = parseFormula(ind.formula);
  const need = new Map();   // 시리즈 ID -> 꼭 필요한가
  for (const ind of config.indicators) for (const id of ind.calc.ids) need.set(id, need.get(id) || ind.role !== "display");
  for (const id of ["USREC", "NASDAQCOM"]) need.set(id, true);
  for (const id of ["NCBEILQ027S", "GDP", "VIXCLS"]) if (!need.has(id)) need.set(id, false);
  console.log(`시리즈 ${need.size}개를 준비합니다${REFRESH ? "(전부 새로 받음)" : "(받아둔 자료 우선)"}.`);
  const raw = {};
  for (const [id, required] of need) { const obs = await getSeries(id, apiKey, required); if (obs) raw[id] = obs; }
  const shiller = await loadShiller();

  // 2. 월간 배열로 통일
  const monthly = {};
  let M0 = Infinity, M1 = -Infinity;
  for (const id of Object.keys(raw)) { monthly[id] = toMonthly(raw[id]); for (const m of monthly[id].keys()) { if (m < M0) M0 = m; if (m > M1) M1 = m; } }
  if (shiller) for (const m of shiller.cape.keys()) if (m < M0) M0 = m;
  const n = M1 - M0 + 1;
  const arrays = {};
  for (const id of Object.keys(raw)) arrays[id] = toArray(monthly[id], M0, M1, id === "USREC" ? 0 : rules.ffill_cap_months);
  const usrec = arrays.USREC;
  let lr = n - 1; while (lr >= 0 && usrec[lr] === null) lr--;
  for (let i = lr + 1; i < n; i++) usrec[i] = 0;
  const S0 = Math.max(ym(START) - M0, 0);          // 화면에 싣기 시작하는 위치
  const cut = (arr, f) => arr.slice(S0).map(f);
  const N = n - S0, bt0 = ym(rules.backtest_start) - M0 - S0, lastIdx = N - 1;

  // 3. 지표
  const fillZero = rules.fill_zero_series ?? [];
  // 지표마다 "실제로 발표된 마지막 달"을 따로 구한다. 달력 칸에 이어 붙인 값의 달과 구별하기 위해서다.
  const genMonth = ym(new Date().toISOString().slice(0, 7));
  const seriesInfo = (id) => {
    const keys = [...monthly[id].keys()], last = Math.max(...keys);
    const valid = raw[id].filter(([, v]) => v !== "." && v !== "" && Number.isFinite(Number(v)));
    const lastDate = valid.length ? new Date(valid[valid.length - 1][0]) : null;
    const cnt = lastDate ? valid.filter(([d]) => (lastDate - new Date(d)) / 86400000 <= 365).length : 0;
    return { id, last, cnt, lastDate: valid.length ? valid[valid.length - 1][0] : null };
  };
  const realInfo = (ids) => {
    const infos = ids.filter((id) => monthly[id] && raw[id] && !fillZero.includes(id)).map(seriesInfo);
    if (!infos.length) return null;
    const d = infos.sort((a, b) => a.last - b.last || a.cnt - b.cnt)[0];
    const freq = d.cnt >= 40 ? "D" : d.cnt <= 5 ? "Q" : "M";
    let m0 = null;
    for (const k of monthly[d.id].keys()) if (k < d.last && (m0 === null || k > m0)) m0 = k;
    return { m1: d.last, m0, freq, partial: freq === "D" && d.last === genMonth, daily: d.cnt >= 150, lastDate: d.lastDate };
  };
  const whenOf = (info, li) => (info ? { month: ymStr(Math.min(info.m1, M0 + li)), freq: info.freq, partial: info.partial, daily: !!info.daily, lastDate: info.lastDate ?? null, prevMonth: info.m0 === null ? null : ymStr(info.m0) } : { month: ymStr(M0 + li), freq: "M", partial: false, prevMonth: null });
  const deltaOf = (sc, info) => {
    if (!info || info.m0 === null) return null;
    const a = lastIdxOf(sc), b = info.m0 - M0;
    return a >= 0 && b >= 0 && sc[b] !== null && sc[b] !== undefined ? r1(sc[a] - sc[b]) : null;
  };
  const indicators = [];
  const fullScores = {};
  for (const ind of config.indicators) {
    const have = ind.calc.ids.every((id) => arrays[id] || fillZero.includes(id));
    const out = { id: ind.id, name: ind.name, category: ind.category, group: ind.group, stars: ind.stars, standard: ind.standard, role: ind.role,
      formula: ind.formula, transform: ind.transform, series: ind.calc.ids, source: "FRED", score: null, latest: null, start: null, note: ind.limited_history ?? "" };
    if (have) {
      const combined = combine(ind.calc, arrays, n, fillZero);
      const vals = transform(combined, ind.tf);
      const li = lastIdxOf(vals);
      const info = realInfo(ind.calc.ids);
      if (li >= 0) out.latest = { value: r2(vals[li]), ...whenOf(info, li), prevValue: info && info.m0 !== null && info.m0 - M0 >= 0 && vals[info.m0 - M0] != null ? r2(vals[info.m0 - M0]) : null };
      const fi = vals.findIndex((v) => v !== null);
      if (fi >= 0) out.start = ymStr(M0 + fi);
      if (ind.role !== "display") {
        // 점수는 "높을수록 여건이 좋음"으로 통일한다. 물가는 압력이 높을수록 나쁘므로 뒤집는다.
        const dir = ind.group === "물가" ? -ind.direction : ind.direction;
        const sc = percentileScores(vals, dir, rules.min_history_months);
        fullScores[ind.id] = sc;
        out.score = cut(sc, r1);
        out.delta = deltaOf(sc, info);
      }
    } else out.note = "자료를 받지 못함";
    indicators.push(out);
  }

  // 4. 가격·심리
  const priceInds = [];
  const addPrice = (id, name, group, arr, unit, series, source, formula, info) => {
    if (!arr) return;
    const pctFull = percentileScores(arr, 1, rules.min_history_months), pct20 = rollingPct(arr, rules.min_history_months, 240);
    const li = lastIdxOf(arr), fi = arr.findIndex((v) => v !== null);
    const sc = pctFull.map((v) => (v === null ? null : 100 - v));   // 비쌀수록·공포가 클수록 점수가 낮다
    fullScores[id] = sc;
    priceInds.push({ id, name, category: "가격·심리", group, stars: null, standard: false, role: "level", formula, transform: "수준", series, source,
      score: cut(sc, r1), latest: { value: r2(arr[li]), ...whenOf(info, li), prevValue: info && info.m0 !== null && info.m0 - M0 >= 0 && arr[info.m0 - M0] != null ? r2(arr[info.m0 - M0]) : null, unit }, start: ymStr(M0 + fi),
      pctFull: r1(pctFull[li]), pct20: r1(pct20[li]), note: "" });
  };
  if (shiller) addPrice("cape", "실러 PER", "가격 수준", toArray(shiller.cape, M0, M1, 3), "배", [], "로버트 실러 교수 공개 자료", "CAPE", (() => { const ks = [...shiller.cape.keys()].sort((a, b) => a - b); return { m1: ks[ks.length - 1], m0: ks.length > 1 ? ks[ks.length - 2] : null, freq: "M", partial: false }; })());
  if (arrays.NCBEILQ027S && arrays.GDP) {
    const eq = toArray(monthly.NCBEILQ027S, M0, M1, 5), gdp = toArray(monthly.GDP, M0, M1, 5);
    addPrice("mcap_gdp", "시가총액/GDP", "가격 수준", eq.map((v, i) => (v !== null && gdp[i] ? v / 1000 / gdp[i] : null)), "배", ["NCBEILQ027S", "GDP"], "FRED", "NCBEILQ027S / 1000 / GDP", realInfo(["NCBEILQ027S", "GDP"]));
  }
  if (arrays.VIXCLS) addPrice("vix", "변동성 지수 (VIX)", "심리", toArray(monthly.VIXCLS, M0, M1, 1), "", ["VIXCLS"], "FRED", "VIXCLS", realInfo(["VIXCLS"]));

  // 4-2. 새 발표 기록: 직전 실행 때와 비교해 자료의 달이 바뀐 지표에 오늘 날짜를 적어 둔다(매일 나오는 지표는 제외)
  const stateFile = join(ROOT, "data", "state", "releases.json");
  await mkdir(dirname(stateFile), { recursive: true });
  let relState = {};
  if (await exists(stateFile)) { try { relState = JSON.parse(await readFile(stateFile, "utf8")); } catch { relState = {}; } }
  const today = new Date().toISOString().slice(0, 10);
  for (const x of [...indicators, ...priceInds]) {
    if (!x.latest || x.latest.daily) continue;   // 매일 나오는 지표만 제외. 주간·월간·분기 지표는 새 자료가 들어온 날을 기록한다
    const obs = x.latest.lastDate ?? x.latest.month, prev = relState[x.id];
    if (!prev) relState[x.id] = { obs, seen: null };
    else if (prev.obs !== obs) relState[x.id] = { obs, seen: prev.obs.length === 7 && obs.startsWith(prev.obs) ? prev.seen : today };   // 예전 기록(달만 적힌 것)은 날짜 형식으로 바꾸기만 한다
    x.latest.newOn = relState[x.id].seen;
  }
  await writeFile(stateFile, JSON.stringify(relState, null, 1), "utf8");

  // 예측치: 자동으로 받는 곳이 없어, data/manual/forecasts.json 에 적어 둔 것이 있으면 그대로 싣는다
  const forecasts = await readJson(join(MANUAL_DIR, "forecasts.json"), null);

  // 4-3. 이번 주 발표 일정
  const schedule = await buildSchedule([...indicators, ...priceInds], apiKey);

  // 5. 표준 세트 묶음 점수(현재값)
  const std = config.indicators.filter((i) => i.standard && fullScores[i.id]);
  const groupNow = {};
  for (const g of ["선행", "동행", "후행", "물가", "연준·단기자금", "국채", "기업 채권", "은행"]) {
    const members = std.filter((i) => i.group === g);
    const w = weightedGroup(members, fullScores, n);
    const li = lastIdxOf(w.value);
    const v = li >= 0 ? w.value[li] : null;
    // 물가 묶음은 화면에 "물가 압력"으로 보여주므로 다시 뒤집는다
    groupNow[g] = { score: r1(v === null ? null : g === "물가" ? 100 - v : v), used: li >= 0 ? w.used[li] : 0, total: members.length, month: li >= 0 ? ymStr(M0 + li) : null };
  }

  // 6. 침체 구간, 표준 선행 경보와 성적표
  const recsFull = [];
  for (let i = 1; i < n; i++) if (usrec[i] === 1 && usrec[i - 1] === 0) { let e = i; while (e + 1 < n && usrec[e + 1] === 1) e++; recsFull.push([i, e]); }
  const recs = recsFull.filter(([s]) => s >= S0).map(([s, e]) => [s - S0, e - S0]);
  const TH = rules.signal_threshold, MIN = rules.signal_min_months ?? 1, W = rules.lead_window_months;
  const leadMembers = std.filter((i) => i.group === "선행").map((i) => ({ score: fullScores[i.id].slice(S0), stars: i.stars }));
  const leadComp = E.composite(leadMembers, N);
  const leadSig = E.toSignal(leadComp.value, TH, MIN);
  const leadRec = E.recessionEval(leadSig, recs, bt0, W, lastIdx);
  const li = lastIdxOf(leadComp.value);
  const alert = { on: li >= 0 ? leadSig[li] === true : null, score: r1(li >= 0 ? leadComp.value[li] : null), month: li >= 0 ? ymStr(M0 + S0 + li) : null,
    used: li >= 0 ? leadComp.used[li] : 0, total: leadComp.total,
    record: { hits: leadRec.hits, eligible: leadRec.eligible, avgLead: r1(leadRec.avgLead), falseSignals: leadRec.falseSignals, counted: leadRec.counted, onShare: r1(leadRec.onShare === null ? null : leadRec.onShare * 100),
      missed: leadRec.missed.map((i) => ymStr(M0 + S0 + i)) } };

  // 7. 금융여건지수
  let nfci = null;
  if (arrays.NFCI) {
    const a = arrays.NFCI.slice(S0), i = lastIdxOf(a);
    const dir = E.direction(a, false, 6, 2);
    const rec = E.recessionEval(a.map((v) => (v === null ? null : v > 0)), recs, bt0, W, lastIdx);
    nfci = { value: r2(a[i]), month: ymStr(M0 + S0 + i), easing: dir[i], record: { hits: rec.hits, eligible: rec.eligible, falseSignals: rec.falseSignals, counted: rec.counted, onShare: r1(rec.onShare === null ? null : rec.onShare * 100) } };
  }

  // 8. 주도 섹터 CDS (수동 입력)
  let sector = null;
  if (WITH_CDS) {
  const cdsFile = join(MANUAL_DIR, "cds.json");
  if (!(await exists(cdsFile))) { await copyFile(join(ROOT, "config", "cds-seed.json"), cdsFile); notes.push("data/manual/cds.json 이 없어 초기값(2026-11-22)으로 만들었음"); }
  const cds = JSON.parse(await readFile(cdsFile, "utf8"));
  const entries = [...cds.entries].sort((a, b) => a.date.localeCompare(b.date));
  const latest = entries[entries.length - 1];
  const hsAvg = (e) => { const v = cds.hyperscalers.map((id) => e.values[id]).filter((x) => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  // 약 3개월 전(75~120일 전) 입력값 중 가장 가까운 것과 비교한다
  const dayDiff = (a, b) => (new Date(a) - new Date(b)) / 86400000;
  const prior = entries.filter((e) => { const d = dayDiff(latest.date, e.date); return d >= 75 && d <= 120; }).sort((a, b) => Math.abs(dayDiff(latest.date, a.date) - 91) - Math.abs(dayDiff(latest.date, b.date) - 91))[0];
  const avgNow = hsAvg(latest), avgPrior = prior ? hsAvg(prior) : null;
  const hv = cds.hyperscalers.map((id) => latest.values[id]).filter((x) => typeof x === "number");
  const baa = indicators.find((i) => i.id === "baa_spread");
  const baaScoreNow = baa && baa.score ? baa.score[lastIdxOf(baa.score)] : null;
  let status = "판정 대기", statusNote = "3개월 전 값이 없어 판정할 수 없습니다. 값을 계속 입력하면 자동으로 판정됩니다.";
  if (avgNow !== null && avgPrior !== null) {
    const chg = avgNow / avgPrior - 1;
    status = chg >= 0.5 ? (baaScoreNow !== null && baaScoreNow < 30 ? "경고" : "주의") : "정상";
    statusNote = `하이퍼스케일러 평균이 ${prior.date} 대비 ${(chg * 100).toFixed(0)}% 변화`;
  }
  sector = { date: latest.date, source: latest.source, status, statusNote, avg: r1(avgNow), spread: hv.length ? r1(Math.max(...hv) - Math.min(...hv)) : null,
    items: cds.names.map((nm) => ({ id: nm.id, name: nm.name, kind: nm.kind, value: latest.values[nm.id] ?? null })), entryCount: entries.length };
  }

  // 9. 가격과 묶음 쓰기
  const nasdaq = cut(toArray(monthly.NASDAQCOM, M0, M1, 1), r2);
  const sp500 = shiller ? cut(toArray(shiller.price, M0, M1, 1), r2) : null;
  const data = {
    generated: new Date().toISOString(), configVersion: config.version, start: ymStr(M0 + S0), months: N, backtestStartIndex: bt0,
    rules: { threshold: TH, minMonths: MIN, window: W, newDays: 7 },
    prices: { nasdaq, sp500 }, usrec: cut(usrec, (v) => (v === 1 ? 1 : 0)), recessions: recs,
    indicators: [...indicators, ...priceInds], groupNow, alert, nfci, sector, schedule, forecasts, notes,
  };
  await writeFile(OUT_FILE, "// 자동 생성 파일. 직접 고치지 않는다. 만든 시각: " + data.generated + "\nwindow.BC_DATA = " + JSON.stringify(data) + ";\n", "utf8");

  const kb = Math.round(JSON.stringify(data).length / 1024);
  console.log(`\n완료. web/data.js (${kb}KB) 를 만들었습니다. web/index.html 을 브라우저로 여세요.`);
  console.log(`기간 ${data.start} ~ ${ymStr(M0 + S0 + lastIdx)}, 지표 ${data.indicators.length}개, 침체 ${recs.filter(([s]) => s >= bt0).length}회(${rules.backtest_start} 이후)`);
  console.log(`침체 경보: ${alert.on ? "켜짐" : "꺼짐"} (선행 종합 ${alert.score}) / 성적 ${alert.record.hits}/${alert.record.eligible}, 헛경보 ${alert.record.falseSignals}/${alert.record.counted}`);
  if (notes.length) { console.log("\n알림:"); for (const x of notes) console.log("  - " + x); }
}

main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
