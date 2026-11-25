// BIG CYCLE 2-4단계: 방향 시험 (한 번만 실행하는 마지막 확인)
// 실행: node scripts/test-direction.mjs
// 묻는 것: 지표가 "나아지는 중"인 달과 "나빠지는 중"인 달의 이후 12개월 나스닥 성적이 갈리는가?
// 자료: data/raw 에 받아둔 것만 쓴다. FRED 키가 필요 없다.
// 통과 기준(실행 전에 고정): 격차(나아지는 중 - 나빠지는 중)가 1976~2000년과 2001년 이후 두 구간 모두에서 양수.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ym, ymStr, toMonthly, toArray, parseFormula, combine, transform, percentileScores, weightedGroup, meanOf } from "./build-scores.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const RAW_DIR = argVal("--data-dir", join(ROOT, "data", "raw"));
const OUT_DIR = argVal("--out-dir", join(ROOT, "reports"));
const exists = (p) => access(p).then(() => true, () => false);

const LOOKBACK = 6;        // 방향을 재는 기간(개월). 2-3단계에서 손해 없이 나아진 값
const CONFIRM = 2;         // 방향이 바뀌었다고 인정하는 연속 개월 수
const SPLIT = "2001-01";   // 전반·후반을 나누는 달

// 방향 배열: true=나아지는 중, false=나빠지는 중. CONFIRM개월 연속 같은 쪽일 때만 바꾼다.
function directionOf(series, improvingWhenRising) {
  const n = series.length, raw = new Array(n).fill(null), out = new Array(n).fill(null);
  for (let i = LOOKBACK; i < n; i++) {
    const a = series[i], b = series[i - LOOKBACK];
    if (a === null || b === null) continue;
    raw[i] = improvingWhenRising ? a - b >= 0 : a - b <= 0;
  }
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (raw[i] !== null) {
      if (cur === null) cur = raw[i];
      else if (raw[i] !== cur) {
        let stable = true;
        for (let k = 1; k < CONFIRM; k++) if (raw[i - k] !== raw[i]) stable = false;
        if (stable) cur = raw[i];
      }
    }
    out[i] = cur;
  }
  return out;
}

function stats(mask, fwd, dd, from, to, step = 1, phase = 0) {
  const r = [], d = [];
  for (let i = from; i <= to; i++) {
    if (step > 1 && (i - phase) % step !== 0) continue;
    if (mask(i) && fwd[i] !== null) { r.push(fwd[i]); d.push(dd[i]); }
  }
  if (!r.length) return { n: 0, mean: null, median: null, neg: null, dd: null };
  const sorted = [...r].sort((a, b) => a - b), mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { n: r.length, mean: mean(r), median: sorted[Math.floor(sorted.length / 2)], neg: r.filter((x) => x < 0).length / r.length, dd: mean(d) };
}

const pc = (v, d = 1) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(d)}%`);
const gapOf = (a, b) => (a.mean === null || b.mean === null ? null : a.mean - b.mean);
const ppS = (g) => (g === null ? "-" : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%p`);
const strength = (g) => (g === null ? "-" : g >= 0.05 ? "뚜렷함" : g >= 0.02 ? "약함" : g > 0 ? "거의 없음" : "반대 방향");

async function main() {
  const config = JSON.parse(await readFile(join(ROOT, "config", "indicators.json"), "utf8"));
  const rules = config.rules;
  await mkdir(OUT_DIR, { recursive: true });

  const scored = config.indicators.filter((i) => i.role === "score" || i.role === "gauge");
  for (const ind of scored) ind.calc = parseFormula(ind.formula);
  const ids = new Set(["USREC", "NASDAQCOM", "NFCI"]);
  for (const ind of scored) for (const id of ind.calc.ids) ids.add(id);

  const raw = {};
  for (const id of ids) {
    const file = join(RAW_DIR, `${id}.json`);
    if (!(await exists(file))) { console.error(`${id}: data/raw 에 자료가 없습니다. 먼저 2-2단계(build-scores.mjs)를 실행하세요.`); process.exit(1); }
    raw[id] = JSON.parse(await readFile(file, "utf8")).observations;
  }
  const monthly = {};
  let M0 = Infinity, M1 = -Infinity;
  for (const id of ids) { monthly[id] = toMonthly(raw[id]); for (const m of monthly[id].keys()) { if (m < M0) M0 = m; if (m > M1) M1 = m; } }
  const n = M1 - M0 + 1;
  const arrays = {};
  for (const id of ids) arrays[id] = toArray(monthly[id], M0, M1, id === "USREC" ? 0 : rules.ffill_cap_months);

  // 이후 12개월 수익률과 그 사이 최대 하락(나스닥 월평균 기준)
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
  const bt0 = ym(rules.backtest_start) - M0, split = ym(SPLIT) - M0;

  // 점수(2-2단계 기준 방식 그대로: 전체 역사 백분위, 표준 세트, 별점 가중)
  const scores = {};
  for (const ind of scored) scores[ind.id] = percentileScores(transform(combine(ind.calc, arrays, n, rules.fill_zero_series ?? []), ind.tf), ind.direction, rules.min_history_months);
  const std = scored.filter((i) => i.standard);
  const grp = (g) => weightedGroup(std.filter((i) => i.group === g), scores, n).value;
  const lead = grp("선행");
  const liqOurs = meanOf(["연준·단기자금", "국채", "기업 채권", "은행"].map(grp), n).value;

  const econUp = directionOf(lead, true);              // 선행 종합 점수가 오르면 나아지는 중
  const nfciUp = directionOf(arrays.NFCI, false);      // 금융여건지수는 내려가면(완화) 나아지는 중
  const liqUp = directionOf(liqOurs, true);

  // 시험 목록(실행 전에 고정)
  const tests = [
    { key: "T1", name: "경기 방향(선행 종합 점수)", up: (i) => econUp[i] === true, down: (i) => econUp[i] === false, primary: true },
    { key: "T2", name: "유동성 방향(금융여건지수)", up: (i) => nfciUp[i] === true, down: (i) => nfciUp[i] === false, primary: true },
    { key: "T3", name: "둘 다 같은 방향(경기+금융여건지수)", up: (i) => econUp[i] === true && nfciUp[i] === true, down: (i) => econUp[i] === false && nfciUp[i] === false, primary: true },
    { key: "T4", name: "참고: 유동성 방향(우리 종합 점수)", up: (i) => liqUp[i] === true, down: (i) => liqUp[i] === false, primary: false },
  ];

  const results = tests.map((t) => {
    const seg = (from, to) => ({ up: stats(t.up, fwd, dd, from, to), down: stats(t.down, fwd, dd, from, to) });
    const full = seg(bt0, lastFwd), h1 = seg(bt0, split - 1), h2 = seg(split, lastFwd);
    // 겹치지 않는 표본: 매년 같은 달 하나씩만(1월 기준). 독립인 사례 수에 가까운 숫자다.
    const jan = (12 - ((M0 + bt0) % 12)) % 12;
    const yearly = { up: stats(t.up, fwd, dd, bt0, lastFwd, 12, bt0 + jan), down: stats(t.down, fwd, dd, bt0, lastFwd, 12, bt0 + jan) };
    const g = { full: gapOf(full.up, full.down), h1: gapOf(h1.up, h1.down), h2: gapOf(h2.up, h2.down), yearly: gapOf(yearly.up, yearly.down) };
    const pass = g.h1 !== null && g.h2 !== null && g.h1 > 0 && g.h2 > 0;
    return { t, full, h1, h2, yearly, g, pass };
  });

  const all = stats(() => true, fwd, dd, bt0, lastFwd);
  const last = n - 1;
  const cur = (a) => (a[last] === null ? "-" : a[last] ? "나아지는 중" : "나빠지는 중");
  const stamp = new Date().toISOString().slice(0, 10);
  const primaries = results.filter((r) => r.t.primary);
  const passed = primaries.filter((r) => r.pass);

  const md = [
    `# 방향 시험 보고서 (${stamp})`,
    "",
    "## 0. 미리 정해 둔 규칙",
    "",
    "- 이 시험은 한 번만 한다. 결과가 마음에 들지 않아도 기준을 바꿔 다시 돌리지 않는다.",
    `- 방향: ${LOOKBACK}개월 전보다 나아졌으면 '나아지는 중', 아니면 '나빠지는 중'. ${CONFIRM}개월 연속 같은 쪽일 때만 바꾼다.`,
    `- 통과 기준: 격차(나아지는 중 - 나빠지는 중의 이후 12개월 평균 수익률)가 ${rules.backtest_start}~2000-12 와 ${SPLIT} 이후 두 구간 모두에서 양수.`,
    "- 강도 표시: 전체 구간 격차가 5%p 이상이면 '뚜렷함', 2~5%p면 '약함', 그 아래는 '거의 없음'. 통과 여부와 별개로 적는다.",
    "- T4는 참고용이며 통과 판정 대상이 아니다.",
    "",
    "## 1. 결론",
    "",
    `- 판정 대상 3개 중 통과: ${passed.length}개${passed.length ? " (" + passed.map((r) => r.t.key).join(", ") + ")" : ""}`,
    `- 검증 구간: ${rules.backtest_start} ~ ${ymStr(M0 + lastFwd)} / 구간 전체 평균 수익률 ${pc(all.mean)}, 손실로 끝난 비율 ${pc(all.neg, 0)}, 평균 최대 하락 ${pc(all.dd)}`,
    "",
    "| 시험 | 전체 격차 | 강도 | 전반 격차 | 후반 격차 | 연 1회 표본 격차 | 판정 |",
    "|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.t.key} ${r.t.name} | ${ppS(r.g.full)} | ${strength(r.g.full)} | ${ppS(r.g.h1)} | ${ppS(r.g.h2)} | ${ppS(r.g.yearly)} | ${r.t.primary ? (r.pass ? "통과" : "불통과") : "참고"} |`),
    "",
    "'연 1회 표본'은 매년 1월 한 달씩만 뽑아 계산한 격차다. 달마다 12개월씩 겹치는 문제를 없앤 숫자라, 이것까지 양수여야 믿을 만하다.",
    "",
    "## 2. 시험별 상세",
    "",
    ...results.flatMap((r) => {
      const row = (label, s) => `| ${label} | ${s.up.n} | ${pc(s.up.mean)} | ${pc(s.up.neg, 0)} | ${pc(s.up.dd)} | ${s.down.n} | ${pc(s.down.mean)} | ${pc(s.down.neg, 0)} | ${pc(s.down.dd)} |`;
      return [
        `### ${r.t.key} ${r.t.name}`,
        "",
        "| 구간 | 나아지는 중: 개월 수 | 평균 수익률 | 손실 비율 | 평균 최대 하락 | 나빠지는 중: 개월 수 | 평균 수익률 | 손실 비율 | 평균 최대 하락 |",
        "|---|---|---|---|---|---|---|---|---|",
        row("전체", r.full), row(`전반(~2000-12)`, r.h1), row(`후반(${SPLIT}~)`, r.h2), row("연 1회 표본", r.yearly),
        "",
      ];
    }),
    "## 3. 현재 방향",
    "",
    `기준월: ${ymStr(M0 + last)}`,
    "",
    `- 경기 방향(선행 종합 점수): ${cur(econUp)}`,
    `- 유동성 방향(금융여건지수): ${cur(nfciUp)}`,
    `- 참고: 유동성 방향(우리 종합 점수): ${cur(liqUp)}`,
    "",
    "최근 한두 달은 일부 지표가 발표 전이라 직전 값을 이어 쓴 것이다.",
    "",
    "## 4. 한계",
    "",
    "- 수정된 최종 자료를 썼고 발표 시차를 반영하지 않았다. 실전 성적은 이보다 나쁘다.",
    "- 수익률은 나스닥 월평균 가격 기준이며 배당을 포함하지 않는다.",
    "- 통과하더라도 '방향이 나쁠 때 주식을 판다'는 규칙의 수익성을 뜻하지는 않는다. 거래 비용, 세금, 다시 사는 시점 문제를 다루지 않았다.",
    "- 두 구간으로만 나눴다. 구간을 다르게 나누면 결과가 달라질 수 있다.",
    "",
  ].join("\n");
  await writeFile(join(OUT_DIR, `direction-test-${stamp}.md`), md, "utf8");
  console.log(`완료. reports/direction-test-${stamp}.md 를 확인하세요.`);
  for (const r of results) console.log(`  ${r.t.key}: 전체 ${ppS(r.g.full)}, 전반 ${ppS(r.g.h1)}, 후반 ${ppS(r.g.h2)} -> ${r.t.primary ? (r.pass ? "통과" : "불통과") : "참고"}`);
}

main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
