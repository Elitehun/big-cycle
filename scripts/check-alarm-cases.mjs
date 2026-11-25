// BIG CYCLE 7-2단계: 침체 경보 사례표
// 침체 경보가 켜졌던 구간마다 "그 뒤 주가"와 "돈을 푸는 주체(기업·연준·시중·정부)"의 상태를 나란히 놓는다.
// 실행: node scripts/check-alarm-cases.mjs            (없는 자료는 FRED에서 받음. 환경변수 FRED_API_KEY 필요)
//       node scripts/check-alarm-cases.mjs --offline  (data/raw 에 받아둔 자료로만)
// 먼저 node scripts/build-web-data.mjs 로 web/data.js 가 만들어져 있어야 한다.
// 결과: reports/alarm-cases.md  (화면과 설정은 건드리지 않는다)

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ym, ymStr, loadSeries, toMonthly } from "./build-scores.mjs";
import "../web/engine.js";

const E = globalThis.BCEngine;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = process.argv.includes("--offline");
const exists = (p) => access(p).then(() => true, () => false);
const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const show = (v, unit = "") => (v === null || v === undefined ? "—" : (v > 0 ? "+" : "") + v.toFixed(1) + unit);

// 후보 지표. q: 분기 자료, lag: 발표가 늦는 개월 수(그 시점에 실제로 볼 수 있었던 값만 쓰기 위해)
const SERIES = {
  PNFI: { name: "민간 설비투자", lag: 4 },
  A679RC1Q027SBEA: { name: "정보처리 장비·소프트웨어 투자", lag: 4 },
  BCNSDODNS: { name: "비금융 기업 부채", lag: 6 },
  WALCL: { name: "연준 자산", lag: 0 },
  M2SL: { name: "M2", lag: 1 },
  CPIAUCSL: { name: "소비자물가", lag: 1 },
  MTSDS133FMS: { name: "연방 재정수지", lag: 1 },
  GDP: { name: "GDP", lag: 4 },
};

async function main() {
  const dataFile = join(ROOT, "web", "data.js");
  if (!(await exists(dataFile))) { console.error("web/data.js 가 없습니다. 먼저 node scripts/build-web-data.mjs 를 실행하세요."); process.exit(1); }
  globalThis.window = {};
  await import("../web/data.js");
  const D = globalThis.window.BC_DATA;
  const N = D.months, M0 = ym(D.start), bt0 = D.backtestStartIndex, lastIdx = N - 1;
  const TH = D.rules.threshold, MIN = D.rules.minMonths, W = D.rules.window;

  // 1. 경보 구간: 화면과 같은 규칙(표준 선행 종합 점수)
  const lead = D.indicators.filter((x) => x.standard && x.group === "선행" && x.score);
  const comp = E.composite(lead.map((x) => ({ score: x.score, stars: x.stars })), N);
  const sig = E.toSignal(comp.value, TH, MIN);
  const recs = D.recessions;
  const eps = E.episodes(sig).filter(([s]) => s >= bt0);
  const px = D.prices.nasdaq;

  // 2. 후보 자료
  const apiKey = process.env.FRED_API_KEY;
  const raw = {}, missing = [];
  for (const id of Object.keys(SERIES)) {
    const file = join(ROOT, "data", "raw", `${id}.json`);
    try {
      if (await exists(file)) raw[id] = JSON.parse(await readFile(file, "utf8")).observations;
      else if (OFFLINE) throw new Error("받아둔 자료 없음(--offline)");
      else if (!apiKey) throw new Error("FRED_API_KEY 없음");
      else raw[id] = await loadSeries(id, apiKey);
    } catch (e) { missing.push(`${id} (${SERIES[id].name}): ${e.message}`); }
  }
  const mon = {}, range = {};
  for (const id of Object.keys(raw)) {
    mon[id] = toMonthly(raw[id]);
    const ks = [...mon[id].keys()].sort((a, b) => a - b);
    range[id] = ks.length ? `${ymStr(ks[0])} ~ ${ymStr(ks[ks.length - 1])} (${ks.length}개)` : "빈 자료";
  }
  // m월 시점에 실제로 볼 수 있었던 가장 최근 값(발표 시차 반영). 너무 오래된 값(12개월 넘게 전)은 쓰지 않는다.
  const at = (id, m) => {
    if (!mon[id]) return null;
    const lim = m - SERIES[id].lag;
    for (let k = lim; k >= lim - 12; k--) if (mon[id].has(k)) return { m: k, v: mon[id].get(k) };
    return null;
  };
  const yoy = (id) => (m) => { const a = at(id, m); if (!a) return null; const b = mon[id].get(a.m - 12); return b ? r1((a.v / b - 1) * 100) : null; };
  const realM2 = (m) => {
    const a = at("M2SL", m); if (!a || !mon.CPIAUCSL) return null;
    const c1 = mon.CPIAUCSL.get(a.m), m0 = mon.M2SL.get(a.m - 12), c0 = mon.CPIAUCSL.get(a.m - 12);
    return c1 && m0 && c0 ? r1(((a.v / c1) / (m0 / c0) - 1) * 100) : null;
  };
  // 재정적자: 최근 12개월 합계 ÷ GDP(연율). 적자가 클수록 큰 양수로 표시
  const deficit = (m) => {
    if (!mon.MTSDS133FMS || !mon.GDP) return null;
    const end = m - SERIES.MTSDS133FMS.lag; let s = 0;
    for (let k = end - 11; k <= end; k++) { if (!mon.MTSDS133FMS.has(k)) return null; s += mon.MTSDS133FMS.get(k); }
    const g = at("GDP", m); return g ? r1(-s / 1000 / g.v * 100) : null;
  };
  const CAND = [
    { key: "capex", name: "설비투자 증가율", unit: "%", f: yoy("PNFI"), who: "기업" },
    { key: "it", name: "정보처리 투자 증가율", unit: "%", f: yoy("A679RC1Q027SBEA"), who: "기업" },
    { key: "debt", name: "기업 부채 증가율", unit: "%", f: yoy("BCNSDODNS"), who: "기업" },
    { key: "fed", name: "연준 자산 증가율", unit: "%", f: yoy("WALCL"), who: "연준" },
    { key: "m2", name: "실질 M2 증가율", unit: "%", f: realM2, who: "시중" },
    { key: "def", name: "재정적자/GDP", unit: "%", f: deficit, who: "정부" },
  ];

  // 3. 사례표
  const fwd = (i, H) => (i + H <= lastIdx && px[i] && px[i + H] ? r1((px[i + H] / px[i] - 1) * 100) : null);
  const worst = (i, H) => { if (!px[i]) return null; let w = 0, ok = false; for (let k = 1; k <= H && i + k <= lastIdx; k++) if (px[i + k]) { w = Math.min(w, px[i + k] / px[i] - 1); ok = true; } return ok ? r1(w * 100) : null; };
  const Q = D.quad;
  const rows = eps.map(([s, e]) => {
    const m = M0 + s, inRec = recs.some(([a, b]) => s >= a && s <= b);
    const rec = recs.find(([a]) => a > s && (a <= e + 1 || a <= s + W));
    const ret12 = fwd(s, 12);
    const row = { start: ymStr(m), end: e === lastIdx ? "진행 중" : ymStr(M0 + e), months: e - s + 1,
      kind: inRec ? "침체 중 시작" : rec ? `침체 예고(${ymStr(M0 + rec[0])} 시작)` : s > lastIdx - W ? "판정 전" : "헛경보",
      ret6: fwd(s, 6), ret12, ret24: fwd(s, 24), dd12: worst(s, 12), up: ret12 === null ? null : ret12 > 0,
      econ: Q ? Q.econ[s] : null, liq: Q ? Q.liq[s] : null, rate: Q ? Q.rate[s] : null, phase: Q ? Q.phase[s] : null };
    for (const c of CAND) { row[c.key] = c.f(m); row[c.key + "6"] = s + 6 <= lastIdx ? c.f(m + 6) : null; }
    return row;
  });

  // 4. 갈라 보기: 12개월 뒤 오른 경보와 빠진 경보의 평균, 그리고 "기준값 하나로 몇 번을 맞게 가르나"
  const judged = rows.filter((r) => r.up !== null);
  const split = (key) => {
    const pts = judged.filter((r) => r[key] !== null && r[key] !== undefined).map((r) => ({ v: r[key], up: r.up }));
    const ups = pts.filter((p) => p.up), downs = pts.filter((p) => !p.up);
    const mean = (a) => (a.length ? r1(a.reduce((x, p) => x + p.v, 0) / a.length) : null);
    let best = { ok: -1 };
    const vals = [...new Set(pts.map((p) => p.v))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < vals.length; i++) {
      const cut = (vals[i] + vals[i + 1]) / 2;
      for (const hiUp of [true, false]) { const ok = pts.filter((p) => (p.v > cut) === (hiUp ? p.up : !p.up)).length; if (ok > best.ok) best = { ok, cut: r1(cut), hiUp }; }
    }
    const base = Math.max(ups.length, downs.length);   // 아무것도 안 보고 "항상 많은 쪽"이라고 답했을 때 맞는 수
    return { n: pts.length, nUp: ups.length, nDown: downs.length, meanUp: mean(ups), meanDown: mean(downs), best: pts.length && vals.length > 1 ? best : null, base };
  };

  const PH = { "1": "인상기", "0": "동결기", "-1": "인하기" };
  const L = [];
  L.push("# 침체 경보 사례표", "", `만든 날: ${new Date().toISOString().slice(0, 10)} · 자료 기준: ${D.generated.slice(0, 10)} · 경보 규칙: 표준 선행 종합 점수 ${TH} 미만 ${MIN}개월`, "");
  L.push("단위는 %. 주가는 나스닥 월평균 기준이고 경보가 켜진 달부터 잰다. 후보 지표는 그 시점에 실제로 발표돼 있던 값만 썼다(분기 자료는 4~6개월 늦게 반영).", "");
  L.push("## 1. 경보 구간과 그 뒤 주가", "", "| 시작 | 끝 | 개월 | 구분 | 6개월 뒤 | 12개월 뒤 | 24개월 뒤 | 12개월 안 최대 하락 | 경기 | 유동성 | 기준금리 |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) L.push(`| ${r.start} | ${r.end} | ${r.months} | ${r.kind} | ${show(r.ret6)} | ${show(r.ret12)} | ${show(r.ret24)} | ${show(r.dd12)} | ${r.econ ?? "—"} | ${r.liq ?? "—"} | ${r.rate === null ? "—" : r.rate + "% " + (PH[String(r.phase)] ?? "")} |`);
  L.push("", "## 2. 경보가 켜진 달의 후보 지표", "", "| 시작 | 12개월 뒤 주가 | " + CAND.map((c) => `${c.name}(${c.who})`).join(" | ") + " |", "|---|---|" + CAND.map(() => "---").join("|") + "|");
  for (const r of rows) L.push(`| ${r.start} | ${show(r.ret12)} | ` + CAND.map((c) => show(r[c.key])).join(" | ") + " |");
  L.push("", "## 3. 경보가 켜지고 6개월 뒤의 후보 지표", "", "경보 당시에는 알 수 없던 값이다. \"그 뒤에 무엇이 달랐나\"를 보려는 용도다.", "", "| 시작 | 12개월 뒤 주가 | " + CAND.map((c) => c.name).join(" | ") + " |", "|---|---|" + CAND.map(() => "---").join("|") + "|");
  for (const r of rows) L.push(`| ${r.start} | ${show(r.ret12)} | ` + CAND.map((c) => show(r[c.key + "6"])).join(" | ") + " |");
  L.push("", "## 4. 오른 경보와 빠진 경보를 가르는가", "", "\"맞게 가른 수\"는 기준값 하나를 가장 유리하게 골랐을 때의 값이라 실제보다 좋게 나온다. \"기본\"은 아무것도 보지 않고 많은 쪽으로만 답했을 때 맞는 수다. 둘의 차이가 1~2번이면 우연으로 봐야 한다.", "",
    "| 후보 | 시점 | 사례 수(오름/빠짐) | 오른 경보 평균 | 빠진 경보 평균 | 맞게 가른 수 | 기본 | 기준 |", "|---|---|---|---|---|---|---|---|");
  const summary = [];
  for (const c of CAND) for (const [suffix, label] of [["", "경보 시점"], ["6", "6개월 뒤"]]) {
    const s = split(c.key + suffix);
    summary.push({ name: c.name, when: label, ...s });
    L.push(`| ${c.name} | ${label} | ${s.n} (${s.nUp}/${s.nDown}) | ${show(s.meanUp)} | ${show(s.meanDown)} | ${s.best ? s.best.ok + "/" + s.n : "—"} | ${s.n ? s.base + "/" + s.n : "—"} | ${s.best ? (s.best.hiUp ? "높으면 오름" : "낮으면 오름") + ", 경계 " + s.best.cut : "—"} |`);
  }
  for (const [key, name] of [["econ", "경기 점수"], ["liq", "유동성 점수"], ["rate", "기준금리"]]) {
    const s = split(key);
    L.push(`| ${name} | 경보 시점 | ${s.n} (${s.nUp}/${s.nDown}) | ${show(s.meanUp)} | ${show(s.meanDown)} | ${s.best ? s.best.ok + "/" + s.n : "—"} | ${s.n ? s.base + "/" + s.n : "—"} | ${s.best ? (s.best.hiUp ? "높으면 오름" : "낮으면 오름") + ", 경계 " + s.best.cut : "—"} |`);
  }
  L.push("", "## 5. 쓴 자료", "", "| 코드 | 이름 | 기간 | 반영 시차(개월) |", "|---|---|---|---|");
  for (const id of Object.keys(SERIES)) L.push(`| ${id} | ${SERIES[id].name} | ${range[id] ?? "받지 못함"} | ${SERIES[id].lag} |`);
  if (missing.length) L.push("", "받지 못한 자료:", ...missing.map((x) => `- ${x}`));
  L.push("", "## 6. 주의", "", "- 사례가 십여 번뿐이다. 한두 번 차이는 우연일 수 있다.", "- 수정된 최종 자료를 썼다. 당시 발표된 값과 다를 수 있다.", "- 연준 자산(WALCL)은 2002년 12월부터라 그 전 경보에는 값이 없다.", "- 이 표는 사고팔 신호가 아니다.");

  const out = join(ROOT, "reports", "alarm-cases.md");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, L.join("\n") + "\n", "utf8");
  console.log(L.join("\n"));
  console.log(`\n완료. reports/alarm-cases.md 를 만들었습니다. 경보 구간 ${rows.length}개, 주가 판정 가능 ${judged.length}개.`);
  if (missing.length) { console.log("받지 못한 자료가 있어 일부 칸이 비어 있습니다."); process.exitCode = 2; }
}

main().catch((e) => { console.error("오류: " + e.message); process.exit(1); });
