// BIG CYCLE 2-3단계: 판정 방식 비교 실험
// 실행: node scripts/compare-variants.mjs            (기준 지수 3개만 새로 받고 나머지는 data/raw 사용)
//       node scripts/compare-variants.mjs --offline  (전부 data/raw 에서 읽음)
// 하는 일: 채점 방식을 고친 뒤, 미리 정해 둔 변경안들을 같은 자로 재서 비교표를 만든다.
//          기준값(신호 30, 창 18개월 등)은 바꾸지 않는다. 구조만 비교한다.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ym, ymStr, loadSeries, toMonthly, toArray, parseFormula, combine, transform, percentileScores, weightedGroup, meanOf, phases } from "./build-scores.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const RAW_DIR = argVal("--data-dir", join(ROOT, "data", "raw"));
const OUT_DIR = argVal("--out-dir", join(ROOT, "reports"));
const exists = (p) => access(p).then(() => true, () => false);

// 비교할 변경안. 이 목록은 실행 전에 고정한 것이며, 결과를 보고 늘리지 않는다.
const DIMS = {
  window: { E: "전체 역사", R20: "최근 20년" },
  liq: { AVG4: "네 묶음 평균", CREDIT: "신용 중심(기업 채권+은행)" },
  signal: { RAW: "평균 점수", RERANK: "종합 점수 재순위", DIFF: "나빠지는 지표 비율" },
  dir: { 3: "3개월", 6: "6개월" },
};
const BASE = { window: "E", liq: "AVG4", signal: "RAW", dir: 3 };
// 연준 계열 기준 지수: [시리즈, 이름, 신호 조건, 조건 설명]
const BENCH = [
  ["CFNAIMA3", "전미활동지수 3개월 평균(시카고 연은)", (v) => v < -0.7, "-0.7 미만"],
  ["NFCI", "금융여건지수(시카고 연은)", (v) => v > 0, "0 초과(평균보다 긴축)"],
  ["STLFSI4", "금융스트레스지수(세인트루이스 연은)", (v) => v > 0, "0 초과(평균보다 긴장)"],
];

// 최근 window개월(값이 있는 달 기준) 안에서의 백분위
function rollingPercentile(arr, direction, minHist, window) {
  const out = new Array(arr.length).fill(null), buf = [];
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x === null) continue;
    buf.push(x);
    if (buf.length > window) buf.shift();
    if (buf.length < minHist) continue;
    let less = 0, eq = 0;
    for (const v of buf) { if (v < x) less++; else if (v === x) eq++; }
    const pct = ((less + 0.5 * eq) / buf.length) * 100;
    out[i] = direction > 0 ? pct : 100 - pct;
  }
  return out;
}

// 나빠지는 지표 비율: 6개월 전보다 점수가 내려간 지표의 (별점 가중) 비율. 100=전부 개선, 0=전부 악화
function diffusion(members, scores, n, lookback) {
  const out = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let w = 0, bad = 0, k = 0;
    for (const ind of members) {
      const a = scores[ind.id][i], b = scores[ind.id][i - lookback];
      if (a === null || b === null) continue;
      const wt = ind.stars ?? 1;
      w += wt; k++;
      if (a < b) bad += wt;
    }
    if (k >= 2) out[i] = 100 * (1 - bad / w);
  }
  return out;
}

// 점수 배열을 신호(켜짐/꺼짐) 배열로: 기준 미만이 minMonths개월 연속이면 켜짐
function toSignal(score, threshold, minMonths) {
  return score.map((v, i) => {
    if (v === null) return null;
    for (let k = 0; k < minMonths; k++) { const p = score[i - k]; if (p == null || p >= threshold) return false; }
    return true;
  });
}

function episodesOf(sig) {
  const eps = [];
  let s = null;
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] === true) { if (s === null) s = i; }
    else if (s !== null) { eps.push([s, i - 1]); s = null; }
  }
  if (s !== null) eps.push([s, sig.length - 1]);
  return eps;
}

// 침체 채점(고친 방식)
//  적중: 침체 시작 전 W개월 창과 겹치는 신호 구간이 있고, 그 구간이 직전 침체가 끝난 뒤에 시작됨
//  오신호: 침체 밖에서 시작된 신호 구간인데, 구간이 이어지는 동안에도 시작 후 W개월 안에도 침체가 없었음
function recessionEval(sig, recs, bt0, W, lastIdx) {
  const eps = episodesOf(sig);
  let eligible = 0, hits = 0; const leads = [], missed = [];
  recs.forEach(([rs], r) => {
    if (rs < bt0) return;
    if (rs - W < 0 || sig[rs - W] === null) return;
    eligible++;
    const prevEnd = r > 0 ? recs[r - 1][1] : -1;
    const ok = eps.filter(([s, e]) => s > prevEnd && s < rs && e >= rs - W);
    if (ok.length) { hits++; leads.push(rs - ok[ok.length - 1][0]); } else missed.push(rs);
  });
  let falseSignals = 0, counted = 0;
  for (const [s, e] of eps) {
    if (s < bt0 || s > lastIdx - W) continue;
    if (recs.some(([rs, re]) => s >= rs && s <= re)) continue;
    counted++;
    if (!recs.some(([rs]) => rs > s && (rs <= e + 1 || rs <= s + W))) falseSignals++;
  }
  let on = 0, tot = 0;
  for (let i = bt0; i <= lastIdx; i++) if (sig[i] !== null) { tot++; if (sig[i]) on++; }
  return { eligible, hits, avgLead: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null, missed, falseSignals, counted, onShare: tot ? on / tot : null };
}

// 주가 성적: 조건에 맞는 달들의 이후 12개월 나스닥 수익률과 그 사이 최대 하락
function fwdStats(mask, fwd, dd, from, to) {
  const r = [], d = [];
  for (let i = from; i <= to; i++) if (mask(i) && fwd[i] !== null) { r.push(fwd[i]); d.push(dd[i]); }
  if (!r.length) return { n: 0, mean: null, median: null, neg: null, dd: null };
  const sorted = [...r].sort((a, b) => a - b);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { n: r.length, mean: mean(r), median: sorted[Math.floor(sorted.length / 2)], neg: r.filter((x) => x < 0).length / r.length, dd: mean(d) };
}

const pc = (v, d = 0) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(d)}%`);
const pp = (a, b) => (a === null || b === null || a === undefined || b === undefined ? "-" : `${((a - b) * 100).toFixed(1)}%p`);
const f1 = (v) => (v === null || v === undefined ? "-" : v.toFixed(1));

async function main() {
  const config = JSON.parse(await readFile(join(ROOT, "config", "indicators.json"), "utf8"));
  const rules = config.rules;
  const apiKey = process.env.FRED_API_KEY;
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const scored = config.indicators.filter((i) => i.role === "score" || i.role === "gauge");
  for (const ind of scored) ind.calc = parseFormula(ind.formula);
  const ids = new Set(["USREC", "NASDAQCOM"]);
  for (const ind of scored) for (const id of ind.calc.ids) ids.add(id);

  // 지표 자료는 2-2단계에서 받아둔 것을 그대로 쓴다(같은 자료로 비교해야 하므로)
  const raw = {};
  for (const id of ids) {
    const file = join(RAW_DIR, `${id}.json`);
    if (!(await exists(file))) { console.error(`${id}: data/raw 에 자료가 없습니다. 먼저 2-2단계(build-scores.mjs)를 실행하세요.`); process.exit(1); }
    raw[id] = JSON.parse(await readFile(file, "utf8")).observations;
  }
  // 기준 지수는 새로 받는다. 못 받으면 그 지수만 빼고 진행한다.
  const benchNotes = [];
  for (const [id, name] of BENCH) {
    const file = join(RAW_DIR, `${id}.json`);
    try {
      if (await exists(file)) raw[id] = JSON.parse(await readFile(file, "utf8")).observations;
      else if (OFFLINE) throw new Error("data/raw 에 없음(--offline)");
      else if (!apiKey) throw new Error("FRED_API_KEY 없음");
      else raw[id] = await loadSeries(id, apiKey);
      console.log(`  기준 지수 ${id}: ${raw[id].length}건`);
    } catch (e) { benchNotes.push(`${name}(${id}): 받지 못해 제외함 - ${e.message}`); console.log(`  기준 지수 ${id}: 제외(${e.message})`); }
  }

  const monthly = {};
  let M0 = Infinity, M1 = -Infinity;
  for (const id of Object.keys(raw)) {
    monthly[id] = toMonthly(raw[id]);
    if (!ids.has(id)) continue;
    for (const m of monthly[id].keys()) { if (m < M0) M0 = m; if (m > M1) M1 = m; }
  }
  const n = M1 - M0 + 1;
  const arrays = {};
  for (const id of Object.keys(raw)) arrays[id] = toArray(monthly[id], M0, M1, id === "USREC" ? 0 : rules.ffill_cap_months);
  const usrec = arrays.USREC;
  let lastRec = n - 1; while (lastRec >= 0 && usrec[lastRec] === null) lastRec--;
  for (let i = lastRec + 1; i < n; i++) usrec[i] = 0;

  const bt0 = ym(rules.backtest_start) - M0;
  const recs = [];
  for (let i = 1; i < n; i++) if (usrec[i] === 1 && usrec[i - 1] === 0) { let e = i; while (e + 1 < n && usrec[e + 1] === 1) e++; recs.push([i, e]); }
  const recsBT = recs.filter(([rs]) => rs >= bt0);

  // 주가 성적용: 나스닥 월평균 기준 이후 12개월 수익률과 그 사이 최대 하락
  const px = toArray(monthly.NASDAQCOM, M0, M1, 1);
  const fwd = new Array(n).fill(null), dd = new Array(n).fill(null);
  for (let i = 0; i + 12 < n; i++) {
    if (px[i] === null || px[i + 12] === null) continue;
    fwd[i] = px[i + 12] / px[i] - 1;
    let worst = 0;
    for (let k = 1; k <= 12; k++) if (px[i + k] !== null) worst = Math.min(worst, px[i + k] / px[i] - 1);
    dd[i] = worst;
  }
  let lastFwd = n - 1; while (lastFwd > 0 && fwd[lastFwd] === null) lastFwd--;
  const lastIdx = n - 1;
  const allStats = fwdStats(() => true, fwd, dd, bt0, lastFwd);

  // 지표별 변환값은 한 번만 계산
  const values = {};
  for (const ind of scored) values[ind.id] = transform(combine(ind.calc, arrays, n, rules.fill_zero_series ?? []), ind.tf);
  const scoreSets = { E: {}, R20: {} };
  for (const ind of scored) {
    scoreSets.E[ind.id] = percentileScores(values[ind.id], ind.direction, rules.min_history_months);
    scoreSets.R20[ind.id] = rollingPercentile(values[ind.id], ind.direction, rules.min_history_months, 240);
  }
  const std = scored.filter((i) => i.standard);
  const members = (groups) => std.filter((i) => groups.includes(i.group));
  const TH = rules.signal_threshold, MIN = rules.signal_min_months ?? 1, W = rules.lead_window_months;

  function run(v) {
    const scores = scoreSets[v.window];
    const G = {};
    for (const g of ["선행", "동행", "연준·단기자금", "국채", "기업 채권", "은행"]) G[g] = weightedGroup(members([g]), scores, n);
    const liqGroups = v.liq === "CREDIT" ? ["기업 채권", "은행"] : ["연준·단기자금", "국채", "기업 채권", "은행"];
    const liqRaw = meanOf(liqGroups.map((g) => G[g].value), n).value;
    const rerank = (a) => percentileScores(a, 1, rules.min_history_months);
    // 수준(높음/낮음) 판정에 쓰는 점수
    const lvl = (a) => (v.signal === "RERANK" ? rerank(a) : a);
    const leadLevel = lvl(G["선행"].value), coinLevel = lvl(G["동행"].value), liqLevel = lvl(liqRaw);
    // 신호 판정에 쓰는 점수
    const leadSigScore = v.signal === "DIFF" ? diffusion(members(["선행"]), scores, n, 6) : leadLevel;
    const liqSigScore = v.signal === "DIFF" ? diffusion(members(liqGroups), scores, n, 6) : liqLevel;
    const leadSig = toSignal(leadSigScore, TH, MIN), liqSig = toSignal(liqSigScore, TH, MIN);

    const econ = phases(coinLevel, leadLevel, ["확장", "둔화", "회복", "수축"], v.dir, rules.phase_confirm_months);
    const liqP = phases(liqLevel, liqLevel, ["완화 확대", "완화 축소", "긴축 완화", "긴축 심화"], v.dir, rules.phase_confirm_months);
    const quad = new Array(n).fill(null);
    for (let i = 0; i < n; i++) if (econ.high[i] !== null && liqP.high[i] !== null) quad[i] = econ.high[i] ? (liqP.high[i] ? "순풍" : "과열·긴축") : (liqP.high[i] ? "부양" : "위기");

    let flips = 0, phaseMonths = 0;
    for (let i = bt0; i <= lastIdx; i++) { if (econ.phase[i] === null) continue; phaseMonths++; if (i > bt0 && econ.phase[i - 1] !== null && econ.phase[i] !== econ.phase[i - 1]) flips++; }

    const quadStats = {};
    for (const q of ["순풍", "과열·긴축", "부양", "위기"]) quadStats[q] = fwdStats((i) => quad[i] === q, fwd, dd, bt0, lastFwd);
    const sigStats = (sig) => ({ on: fwdStats((i) => sig[i] === true, fwd, dd, bt0, lastFwd), off: fwdStats((i) => sig[i] === false, fwd, dd, bt0, lastFwd) });
    return {
      v, leadRec: recessionEval(leadSig, recs, bt0, W, lastIdx), liqRec: recessionEval(liqSig, recs, bt0, W, lastIdx),
      quadStats, leadFwd: sigStats(leadSig), liqFwd: sigStats(liqSig),
      flips, avgPhase: flips ? phaseMonths / (flips + 1) : phaseMonths,
      current: { quad: quad[lastIdx], econ: econ.phase[lastIdx], liq: liqP.phase[lastIdx], leadSig: leadSig[lastIdx], liqSig: liqSig[lastIdx] },
    };
  }

  // 전체 조합(24개)
  const grid = [];
  for (const window of Object.keys(DIMS.window)) for (const liq of Object.keys(DIMS.liq)) for (const signal of Object.keys(DIMS.signal)) for (const dir of [3, 6]) grid.push(run({ window, liq, signal, dir }));
  const find = (v) => grid.find((g) => g.v.window === v.window && g.v.liq === v.liq && g.v.signal === v.signal && g.v.dir === v.dir);
  const rows = [
    ["기준(2-2단계 방식)", BASE],
    ["백분위를 최근 20년으로", { ...BASE, window: "R20" }],
    ["유동성을 신용 중심으로", { ...BASE, liq: "CREDIT" }],
    ["신호를 재순위로", { ...BASE, signal: "RERANK" }],
    ["신호를 나빠지는 지표 비율로", { ...BASE, signal: "DIFF" }],
    ["방향을 6개월로", { ...BASE, dir: 6 }],
    ["네 가지 모두(재순위)", { window: "R20", liq: "CREDIT", signal: "RERANK", dir: 6 }],
    ["네 가지 모두(비율)", { window: "R20", liq: "CREDIT", signal: "DIFF", dir: 6 }],
  ].map(([label, v]) => ({ label, r: find(v) }));

  // 기준 지수 평가
  const benchRows = [];
  for (const [id, name, cond, condText] of BENCH) {
    if (!arrays[id]) continue;
    const sig = arrays[id].map((v) => (v === null ? null : cond(v)));
    const first = sig.findIndex((v) => v !== null);
    benchRows.push({ id, name, condText, start: first >= 0 ? ymStr(M0 + first) : "-", rec: recessionEval(sig, recs, bt0, W, lastIdx), on: fwdStats((i) => sig[i] === true, fwd, dd, bt0, lastFwd), off: fwdStats((i) => sig[i] === false, fwd, dd, bt0, lastFwd) });
  }

  // ---------- 보고서 ----------
  const stamp = new Date().toISOString().slice(0, 10);
  const recCell = (e) => `${e.hits}/${e.eligible}`;
  const missCell = (e) => (e.missed.length ? e.missed.map((i) => ymStr(M0 + i)).join(", ") : "없음");
  const spread = (r) => pp(r.quadStats["순풍"].mean, r.quadStats["위기"].mean);
  const md = [
    `# 판정 방식 비교 보고서 (${stamp})`,
    "",
    `- 설정 파일 버전: ${config.version}`,
    `- 검증 구간: ${rules.backtest_start} ~ ${ymStr(M0 + lastIdx)} / 주가 성적은 이후 12개월이 확인되는 ${ymStr(M0 + lastFwd)}까지`,
    `- 검증 대상 침체: ${recsBT.length}회 (${recsBT.map(([rs]) => ymStr(M0 + rs)).join(", ")})`,
    `- 기준값은 2-2단계와 같다: 신호 ${TH} 미만 ${MIN}개월 연속, 선행 창 ${W}개월, 최소 이력 ${rules.min_history_months}개월`,
    "",
    "## 1. 채점 방식에서 고친 것",
    "",
    "- 적중: 직전 침체가 끝난 뒤에 새로 켜진 신호만 인정한다. 앞 침체 때 켜져 있던 신호는 다음 침체의 적중으로 치지 않는다.",
    "- 오신호: 침체 기준으로만 센다. 신호가 이어지는 동안에도, 켜진 뒤 18개월 안에도 침체가 없으면 오신호다.",
    "- 주가는 사건 맞히기가 아니라 국면별 이후 12개월 성적으로 본다. 검증 구간의 모든 달이 표본이 된다.",
    "- 신호가 켜져 있던 달의 비율을 함께 적는다. 늘 켜져 있는 신호는 적중률이 높아도 쓸모가 없다.",
    "",
    "## 2. 침체 채점 비교",
    "",
    "| 방식 | 선행 적중 | 선행 평균 선행(개월) | 선행 오신호 | 선행 신호 켜진 비율 | 선행이 놓친 침체 | 유동성 적중 | 유동성 오신호 | 유동성 신호 켜진 비율 | 유동성이 놓친 침체 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(({ label, r }) => `| ${label} | ${recCell(r.leadRec)} | ${f1(r.leadRec.avgLead)} | ${r.leadRec.falseSignals}/${r.leadRec.counted} | ${pc(r.leadRec.onShare)} | ${missCell(r.leadRec)} | ${recCell(r.liqRec)} | ${r.liqRec.falseSignals}/${r.liqRec.counted} | ${pc(r.liqRec.onShare)} | ${missCell(r.liqRec)} |`),
    "",
    "오신호는 '오신호 횟수/침체 밖에서 시작된 신호 구간 수'다.",
    "",
    "## 3. 주가 성적 비교 (이후 12개월 나스닥)",
    "",
    `검증 구간 전체 평균: 수익률 ${pc(allStats.mean, 1)}, 손실로 끝난 비율 ${pc(allStats.neg)}, 평균 최대 하락 ${pc(allStats.dd, 1)} (${allStats.n}개월)`,
    "",
    "| 방식 | 순풍 평균 | 위기 평균 | 순풍-위기 격차 | 위기 국면 평균 최대 하락 | 선행 신호 꺼짐-켜짐 격차 | 유동성 신호 꺼짐-켜짐 격차 | 경기 국면 전환 횟수 | 국면 평균 지속(개월) |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map(({ label, r }) => `| ${label} | ${pc(r.quadStats["순풍"].mean, 1)} | ${pc(r.quadStats["위기"].mean, 1)} | ${spread(r)} | ${pc(r.quadStats["위기"].dd, 1)} | ${pp(r.leadFwd.off.mean, r.leadFwd.on.mean)} | ${pp(r.liqFwd.off.mean, r.liqFwd.on.mean)} | ${r.flips} | ${f1(r.avgPhase)} |`),
    "",
    "격차가 클수록 판정이 주가 성적을 잘 갈랐다는 뜻이다. 격차가 0에 가깝거나 음수면 그 판정은 투자에 쓸모가 없다.",
    "",
    "## 4. 4분면별 상세",
    "",
    ...rows.filter((x) => ["기준(2-2단계 방식)", "네 가지 모두(재순위)", "네 가지 모두(비율)"].includes(x.label)).flatMap(({ label, r }) => [
      `### ${label}`,
      "",
      "| 4분면 | 해당 개월 수 | 평균 수익률 | 중간값 | 손실로 끝난 비율 | 평균 최대 하락 |",
      "|---|---|---|---|---|---|",
      ...["순풍", "과열·긴축", "부양", "위기"].map((q) => { const s = r.quadStats[q]; return `| ${q} | ${s.n} | ${pc(s.mean, 1)} | ${pc(s.median, 1)} | ${pc(s.neg)} | ${pc(s.dd, 1)} |`; }),
      "",
      `현재(${ymStr(M0 + lastIdx)}) 판정: 경기 ${r.current.econ ?? "-"} / 유동성 ${r.current.liq ?? "-"} / 종합 ${r.current.quad ?? "-"} / 선행 신호 ${r.current.leadSig ? "켜짐" : "꺼짐"} / 유동성 신호 ${r.current.liqSig ? "켜짐" : "꺼짐"}`,
      "",
    ]),
    "## 5. 연준 계열 기준 지수와 비교",
    "",
    "우리 방식이 이 지수들보다 못하면 표준 세트의 뼈대로 이 지수들을 쓰는 편이 낫다.",
    "",
    "| 지수 | 신호 조건 | 자료 시작 | 침체 적중 | 평균 선행(개월) | 오신호 | 신호 켜진 비율 | 꺼짐일 때 평균 수익률 | 켜짐일 때 평균 수익률 | 격차 | 켜짐일 때 평균 최대 하락 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...(benchRows.length ? benchRows.map((b) => `| ${b.name} | ${b.condText} | ${b.start} | ${recCell(b.rec)} | ${f1(b.rec.avgLead)} | ${b.rec.falseSignals}/${b.rec.counted} | ${pc(b.rec.onShare)} | ${pc(b.off.mean, 1)} | ${pc(b.on.mean, 1)} | ${pp(b.off.mean, b.on.mean)} | ${pc(b.on.dd, 1)} |`) : ["| 받은 지수 없음 | | | | | | | | | | |"]),
    "",
    ...benchNotes.map((x) => `- ${x}`),
    "- 금융여건지수와 금융스트레스지수는 0이 평균이라 신호가 켜진 달이 많다. 적중 횟수보다 신호 켜진 비율과 수익률 격차를 함께 봐야 한다.",
    "",
    "## 6. 읽는 순서와 판단 원칙",
    "",
    "1. 3장의 '순풍-위기 격차'를 먼저 본다. 표본이 가장 많아 가장 믿을 만한 숫자다.",
    "2. 2장에서 '신호 켜진 비율'이 지나치게 높은 방식(대략 3분의 1 이상)은 적중이 많아도 걸러낸다.",
    "3. 5장의 기준 지수보다 나은지 본다.",
    "4. 변경안이 기준 방식보다 한두 항목에서만 조금 나은 정도면 채택 근거가 약하다. 여러 항목에서 같은 방향으로 나아야 한다.",
    "",
    "## 7. 이 비교의 한계",
    "",
    `- 침체는 ${recsBT.length}회뿐이다. 2장의 적중 횟수 차이 한두 번은 우연일 수 있다.`,
    "- 3장의 표본은 달마다 12개월씩 겹친다. 개월 수는 많아 보여도 서로 독립인 사례는 수십 개 수준이다.",
    "- 수정된 최종 자료를 썼고 발표 시차를 반영하지 않았다. 실전 성적은 이보다 나쁘다.",
    "- 수익률은 나스닥 월평균 가격 기준이며 배당을 포함하지 않는다.",
    "- 비교한 조합은 24개다(reports/variants-grid.csv). 그중 가장 좋은 것을 고르면 과거에만 맞는 방식을 고르게 될 위험이 있다. 그래서 본문에는 한 가지씩 바꾼 결과와 미리 정한 조합만 실었다.",
    "",
  ].join("\n");
  await writeFile(join(OUT_DIR, `variants-report-${stamp}.md`), md, "utf8");

  const gh = ["백분위 기준", "유동성 정의", "신호 방식", "방향 개월", "선행 적중", "선행 대상", "선행 오신호", "선행 켜진 비율", "유동성 적중", "유동성 대상", "유동성 오신호", "유동성 켜진 비율", "순풍 평균", "위기 평균", "순풍-위기 격차", "선행 신호 격차", "유동성 신호 격차", "국면 전환 횟수"];
  const num = (v) => (v === null || v === undefined ? "" : (v * 100).toFixed(1));
  const gl = [gh.join(",")].concat(grid.map((r) => [DIMS.window[r.v.window], DIMS.liq[r.v.liq], DIMS.signal[r.v.signal], r.v.dir,
    r.leadRec.hits, r.leadRec.eligible, r.leadRec.falseSignals, num(r.leadRec.onShare), r.liqRec.hits, r.liqRec.eligible, r.liqRec.falseSignals, num(r.liqRec.onShare),
    num(r.quadStats["순풍"].mean), num(r.quadStats["위기"].mean),
    r.quadStats["순풍"].mean === null || r.quadStats["위기"].mean === null ? "" : num(r.quadStats["순풍"].mean - r.quadStats["위기"].mean),
    r.leadFwd.off.mean === null || r.leadFwd.on.mean === null ? "" : num(r.leadFwd.off.mean - r.leadFwd.on.mean),
    r.liqFwd.off.mean === null || r.liqFwd.on.mean === null ? "" : num(r.liqFwd.off.mean - r.liqFwd.on.mean), r.flips].join(",")));
  await writeFile(join(OUT_DIR, "variants-grid.csv"), "﻿" + gl.join("\n"), "utf8");

  console.log(`\n완료. reports/variants-report-${stamp}.md 를 확인하세요.`);
  console.log(`비교한 조합 ${grid.length}개, 기준 지수 ${benchRows.length}개.`);
}

main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
