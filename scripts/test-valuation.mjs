// BIG CYCLE 2-5단계: 가격·심리 지표 기록용 시험
// 실행: node scripts/test-valuation.mjs
// 묻는 것: 주가가 역사적으로 비쌌던 달과 쌌던 달의 이후 성적이 갈리는가? 공포가 컸던 달과 작았던 달은?
// 이 시험은 기록용이다. 결과와 무관하게 세 지표는 상황판에 넣기로 이미 정했다.
// 자료: data/manual/shiller.csv (실러 자료, 사람이 준비) + FRED 3개(NCBEILQ027S, GDP, VIXCLS) + data/raw 의 NASDAQCOM

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ym, ymStr, loadSeries, toMonthly, toArray, percentileScores } from "./build-scores.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const RAW_DIR = argVal("--data-dir", join(ROOT, "data", "raw"));
const MANUAL_DIR = argVal("--manual-dir", join(ROOT, "data", "manual"));
const OUT_DIR = argVal("--out-dir", join(ROOT, "reports"));
const exists = (p) => access(p).then(() => true, () => false);

const MIN_HIST = 120;         // 백분위를 내기 시작하는 최소 이력(개월)
const HIGH = 67, LOW = 33;    // 상위 3분의 1, 하위 3분의 1 경계
const BT0 = "1976-01", SPLIT = "2001-01";

async function loadShiller() {
  const file = join(MANUAL_DIR, "shiller.csv");
  if (!(await exists(file))) throw new Error("data/manual/shiller.csv 가 없습니다. 작업 지시서의 '실러 자료 준비'를 먼저 진행하세요.");
  const lines = (await readFile(file, "utf8")).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].toLowerCase().split(",").map((s) => s.trim());
  const iD = head.indexOf("date"), iC = head.indexOf("cape"), iP = head.indexOf("sp500");
  if (iD < 0 || iC < 0 || iP < 0) throw new Error("shiller.csv 첫 줄은 date,cape,sp500 이어야 합니다.");
  const cape = new Map(), price = new Map();
  let prev = -Infinity;
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (!/^\d{4}-\d{2}/.test(c[iD] ?? "")) throw new Error(`shiller.csv 날짜 형식 오류: "${c[iD]}" (YYYY-MM 이어야 함)`);
    const m = ym(c[iD]);
    if (m <= prev) throw new Error(`shiller.csv 날짜가 순서대로가 아닙니다: ${c[iD]}`);
    prev = m;
    const cv = Number(c[iC]), pv = Number(c[iP]);
    if (c[iC] !== "" && Number.isFinite(cv) && cv > 0) cape.set(m, cv);
    if (c[iP] !== "" && Number.isFinite(pv) && pv > 0) price.set(m, pv);
  }
  // 자료가 맞게 들어왔는지 알려진 값으로 확인한다
  const dec99 = cape.get(ym("1999-12"));
  if (cape.size < 1500) throw new Error(`shiller.csv 의 CAPE 값이 ${cape.size}개뿐입니다(1500개 이상이어야 함).`);
  if (!(dec99 > 40 && dec99 < 48)) throw new Error(`shiller.csv 의 1999-12 CAPE 가 ${dec99} 입니다. 44 안팎이어야 합니다. 열이 뒤바뀌었는지 확인하세요.`);
  return { cape, price };
}

async function fred(id, apiKey) {
  const file = join(RAW_DIR, `${id}.json`);
  if (await exists(file)) return JSON.parse(await readFile(file, "utf8")).observations;
  if (OFFLINE) throw new Error(`${id}: data/raw 에 없습니다(--offline).`);
  if (!apiKey) throw new Error(`${id}: 새로 받아야 하는데 FRED_API_KEY 가 없습니다.`);
  return loadSeries(id, apiKey);
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

// 이후 H개월 수익률(연율)과, 12개월일 때는 그 사이 최대 하락
function forward(px, H) {
  const n = px.length, ret = new Array(n).fill(null), dd = new Array(n).fill(null);
  for (let i = 0; i + H < n; i++) {
    if (px[i] === null || px[i + H] === null) continue;
    ret[i] = Math.pow(px[i + H] / px[i], 12 / H) - 1;
    let worst = 0;
    for (let k = 1; k <= Math.min(H, 12); k++) if (px[i + k] !== null) worst = Math.min(worst, px[i + k] / px[i] - 1);
    dd[i] = worst;
  }
  return { ret, dd };
}

function stats(mask, f, from, to, step = 1) {
  const r = [], d = [];
  for (let i = from; i <= to; i += 1) {
    if (step > 1 && (i - from) % step !== 0) continue;
    if (mask(i) && f.ret[i] !== null) { r.push(f.ret[i]); d.push(f.dd[i]); }
  }
  if (!r.length) return { n: 0, mean: null, neg: null, dd: null };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { n: r.length, mean: mean(r), neg: r.filter((x) => x < 0).length / r.length, dd: mean(d) };
}

const pc = (v, d = 1) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(d)}%`);
const gap = (a, b) => (a.mean === null || b.mean === null ? null : a.mean - b.mean);
const ppS = (g) => (g === null ? "-" : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%p`);

async function main() {
  const apiKey = process.env.FRED_API_KEY;
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const sh = await loadShiller();
  const raw = {};
  for (const id of ["NCBEILQ027S", "GDP", "VIXCLS", "NASDAQCOM"]) { raw[id] = await fred(id, apiKey); console.log(`  ${id}: ${raw[id].length}건`); }
  const mo = {};
  for (const id of Object.keys(raw)) mo[id] = toMonthly(raw[id]);

  let M0 = Infinity, M1 = -Infinity;
  for (const map of [sh.cape, sh.price, ...Object.values(mo)]) for (const m of map.keys()) { if (m < M0) M0 = m; if (m > M1) M1 = m; }
  const n = M1 - M0 + 1;
  const A = (map, cap) => toArray(map, M0, M1, cap);
  const cape = A(sh.cape, 3), spx = A(sh.price, 1), ndq = A(mo.NASDAQCOM, 1), vix = A(mo.VIXCLS, 1);
  // 시가총액/GDP: 분기 자료라 다음 분기 값이 나올 때까지 직전 값을 이어 쓴다
  const eq = A(mo.NCBEILQ027S, 5), gdp = A(mo.GDP, 5);
  const mcap = eq.map((v, i) => (v !== null && gdp[i] !== null && gdp[i] > 0 ? v / 1000 / gdp[i] : null));

  const bt0 = Math.max(ym(BT0) - M0, 0), split = ym(SPLIT) - M0, last = n - 1;
  const F = { spx: { 12: forward(spx, 12), 60: forward(spx, 60), 120: forward(spx, 120) }, ndq: { 12: forward(ndq, 12), 60: forward(ndq, 60) } };

  // 시험 목록(실행 전에 고정). hiLabel 쪽이 "비쌈/공포"다.
  const inds = [
    { key: "V1", name: "실러 PER(CAPE)", arr: cape, hi: "비쌈", lo: "쌈", unit: "배" },
    { key: "V2", name: "시가총액/GDP", arr: mcap, hi: "비쌈", lo: "쌈", unit: "배" },
    { key: "V3", name: "변동성 지수(VIX)", arr: vix, hi: "공포 큼", lo: "공포 작음", unit: "" },
  ];
  for (const ind of inds) {
    ind.pctE = percentileScores(ind.arr, 1, MIN_HIST);   // 그 시점까지 전체 역사 기준
    ind.pctR = rollingPct(ind.arr, MIN_HIST, 240);        // 최근 20년 기준(참고)
    ind.first = ind.arr.findIndex((v) => v !== null);
  }

  const lastOf = (f) => { let i = n - 1; while (i > 0 && f.ret[i] === null) i--; return i; };
  function block(ind, pct, f, from, to, yearly) {
    const hi = stats((i) => pct[i] !== null && pct[i] >= HIGH, f, from, to, yearly);
    const mid = stats((i) => pct[i] !== null && pct[i] > LOW && pct[i] < HIGH, f, from, to, yearly);
    const lo = stats((i) => pct[i] !== null && pct[i] <= LOW, f, from, to, yearly);
    return { hi, mid, lo, gap: gap(lo, hi) };
  }

  const sections = [];
  const summary = [];
  for (const ind of inds) {
    const rows = [];
    const add = (label, market, H, pct, from, to, step) => {
      const f = F[market][H];
      const b = block(ind, pct, f, from, Math.min(to, lastOf(f)), step);
      rows.push({ label, b });
      return b;
    };
    const mkts = [["spx", "S&P500"], ["ndq", "나스닥"]];
    for (const [mk, mkName] of mkts) {
      for (const H of mk === "spx" ? [12, 60, 120] : [12, 60]) {
        const hName = H === 12 ? "이후 1년" : `이후 ${H / 12}년(연율)`;
        const full = add(`${mkName} ${hName}, ${BT0} 이후`, mk, H, ind.pctE, bt0, last);
        const h1 = add(`${mkName} ${hName}, 전반(~2000-12)`, mk, H, ind.pctE, bt0, split - 1);
        const h2 = add(`${mkName} ${hName}, 후반(${SPLIT}~)`, mk, H, ind.pctE, split, last);
        const ny = add(`${mkName} ${hName}, 겹치지 않는 표본`, mk, H, ind.pctE, bt0, last, H);
        summary.push({ ind, mkName, hName, full: full.gap, h1: h1.gap, h2: h2.gap, ny: ny.gap, nyN: ny.hi.n + ny.lo.n, pass: h1.gap !== null && h2.gap !== null && h1.gap > 0 && h2.gap > 0 });
      }
    }
    // 참고: 실러 자료는 1881년부터라 S&P500 은 더 긴 구간도 본다
    if (ind.key === "V1") {
      add("참고: S&P500 이후 1년, 자료 전체", "spx", 12, ind.pctE, 0, last);
      add("참고: S&P500 이후 10년(연율), 자료 전체", "spx", 120, ind.pctE, 0, last);
      add("참고: S&P500 이후 10년(연율), 자료 전체, 겹치지 않는 표본", "spx", 120, ind.pctE, 0, last, 120);
    }
    add(`참고: S&P500 이후 1년, 최근 20년 기준 백분위`, "spx", 12, ind.pctR, bt0, last);
    add(`참고: S&P500 이후 5년(연율), 최근 20년 기준 백분위`, "spx", 60, ind.pctR, bt0, last);

    const cur = ind.arr[last] ?? ind.arr.slice().reverse().find((v) => v !== null);
    let ci = last; while (ci > 0 && ind.arr[ci] === null) ci--;
    sections.push([
      `### ${ind.key} ${ind.name}`,
      "",
      `- 자료 시작: ${ymStr(M0 + ind.first)} / 백분위 계산 시작: ${ymStr(M0 + ind.pctE.findIndex((v) => v !== null))}`,
      `- 현재값(${ymStr(M0 + ci)}): ${ind.arr[ci].toFixed(2)}${ind.unit} / 전체 역사 기준 ${ind.pctE[ci] === null ? "-" : ind.pctE[ci].toFixed(0)}번째 백분위 / 최근 20년 기준 ${ind.pctR[ci] === null ? "-" : ind.pctR[ci].toFixed(0)}번째 백분위`,
      "",
      `| 조건 | ${ind.lo}: 개월 수 | 평균 수익률 | 손실 비율 | 보통: 개월 수 | 평균 수익률 | ${ind.hi}: 개월 수 | 평균 수익률 | 손실 비율 | 격차(${ind.lo}-${ind.hi}) |`,
      "|---|---|---|---|---|---|---|---|---|---|",
      ...rows.map(({ label, b }) => `| ${label} | ${b.lo.n} | ${pc(b.lo.mean)} | ${pc(b.lo.neg, 0)} | ${b.mid.n} | ${pc(b.mid.mean)} | ${b.hi.n} | ${pc(b.hi.mean)} | ${pc(b.hi.neg, 0)} | ${ppS(b.gap)} |`),
      "",
    ].join("\n"));
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const md = [
    `# 가격·심리 지표 시험 보고서 (${stamp})`,
    "",
    "## 0. 미리 정해 둔 것",
    "",
    "- 이 시험은 기록용이다. 결과와 무관하게 세 지표는 상황판의 '가격·심리' 카테고리에 넣는다.",
    "- 한 번만 실행한다. 기준을 바꿔 다시 돌리지 않는다.",
    `- 구분: 그 시점까지의 자기 역사에서 상위 3분의 1(백분위 ${HIGH} 이상)이면 '비쌈/공포 큼', 하위 3분의 1(${LOW} 이하)이면 '쌈/공포 작음'.`,
    `- 격차는 (쌈 또는 공포 작음) - (비쌈 또는 공포 큼)의 평균 수익률이다. 가격 지표는 양수가 상식에 맞고, VIX는 음수(공포가 클 때 이후 성적이 좋음)가 통설이다.`,
    `- '일관됨'은 ${BT0}~2000-12 와 ${SPLIT} 이후 두 구간의 격차가 모두 양수라는 뜻이다. 통과·불통과를 가르는 용도가 아니라 기록이다.`,
    "- 수익률은 가격 기준이며 배당을 포함하지 않는다. 5년·10년 수익률은 연율이다.",
    "",
    "## 1. 요약",
    "",
    "| 지표 | 시장·기간 | 전체 격차 | 전반 | 후반 | 겹치지 않는 표본 격차(사례 수) | 두 구간 모두 양수 |",
    "|---|---|---|---|---|---|---|",
    ...summary.map((s) => `| ${s.ind.key} ${s.ind.name} | ${s.mkName} ${s.hName} | ${ppS(s.full)} | ${ppS(s.h1)} | ${ppS(s.h2)} | ${ppS(s.ny)} (${s.nyN}) | ${s.h1 === null || s.h2 === null ? "판정 불가(한쪽 사례 없음)" : s.pass ? "예" : "아니오"} |`),
    "",
    "'겹치지 않는 표본'은 수익률 기간만큼 간격을 띄워 뽑은 달만 쓴 것이다. 5년·10년은 사례 수가 한 자릿수일 수 있어 숫자의 크기를 믿으면 안 된다.",
    "",
    "## 2. 지표별 상세",
    "",
    ...sections,
    "## 3. 한계",
    "",
    "- 5년·10년 수익률은 서로 겹치지 않는 사례가 매우 적다. 표의 개월 수가 많아 보여도 독립인 사례는 몇 개뿐이다.",
    "- 실러 PER은 1990년대 이후 대부분의 기간 동안 과거 평균보다 높았다. 전체 역사 기준으로는 '비쌈'이 오래 이어진다. 최근 20년 기준 결과를 참고로 함께 실은 이유다.",
    "- 시가총액/GDP의 분자는 비금융 기업의 주식 시가총액이다. 금융회사는 빠져 있다.",
    "- VIX는 1990년부터라 표본이 짧다.",
    "- 실러 자료의 S&P500 값은 월평균 종가다.",
    "",
  ].join("\n");
  await writeFile(join(OUT_DIR, `valuation-test-${stamp}.md`), md, "utf8");
  console.log(`완료. reports/valuation-test-${stamp}.md 를 확인하세요.`);
  for (const s of summary.filter((x) => x.hName !== "이후 10년(연율)")) console.log(`  ${s.ind.key} ${s.mkName} ${s.hName}: 전체 ${ppS(s.full)}, 전반 ${ppS(s.h1)}, 후반 ${ppS(s.h2)}`);
}

main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
