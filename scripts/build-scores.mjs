// BIG CYCLE 2-2단계: 점수 계산, 별점 산출, 과거 검증
// 실행: node scripts/build-scores.mjs            (FRED에서 내려받아 계산)
//       node scripts/build-scores.mjs --offline  (data/raw 에 받아둔 자료로만 계산)
// 필요: Node 18 이상. 내려받을 때는 환경변수 FRED_API_KEY
// 규칙의 근거: docs/design-spec.md 4장(점수화), 5장(판정), 6장(별점)

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const RAW_DIR = argVal("--data-dir", join(ROOT, "data", "raw"));
const OUT_DIR = argVal("--out-dir", join(ROOT, "reports"));
const CONFIG = join(ROOT, "config", "indicators.json");
const API = "https://api.stlouisfed.org/fred/series/observations";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

// ---------- 날짜 도구: 월을 정수(연*12+월-1)로 다룬다 ----------
export const ym = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
export const ymStr = (m) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;

// ---------- 자료 받기 ----------
export async function loadSeries(id, apiKey) {
  const file = join(RAW_DIR, `${id}.json`);
  if (OFFLINE) {
    if (!(await exists(file))) throw new Error(`${id}: data/raw 에 자료가 없습니다(--offline).`);
    return JSON.parse(await readFile(file, "utf8")).observations;
  }
  const url = `${API}?series_id=${encodeURIComponent(id)}&api_key=${apiKey}&file_type=json&limit=100000`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(5000 * attempt); continue; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error_message ?? `HTTP ${res.status}`);
      const observations = (body.observations ?? []).map((o) => [o.date, o.value]);
      if (body.count > observations.length) throw new Error(`자료가 한 번에 다 오지 않았습니다(${observations.length}/${body.count}).`);
      await writeFile(file, JSON.stringify({ id, fetched: new Date().toISOString(), observations }), "utf8");
      return observations;
    } catch (e) {
      if (attempt === 3) throw new Error(`${id}: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`${id}: 요청 한도 초과로 중단`);
}

// ---------- 계산 도구 ----------
// 관측값을 월평균으로 묶는다. 결측(".")은 건너뛴다.
export function toMonthly(observations) {
  const sum = new Map(), cnt = new Map();
  for (const [date, raw] of observations) {
    const v = Number(raw);
    if (raw === "." || raw === "" || !Number.isFinite(v)) continue;
    const m = ym(date);
    sum.set(m, (sum.get(m) ?? 0) + v);
    cnt.set(m, (cnt.get(m) ?? 0) + 1);
  }
  const out = new Map();
  for (const [m, s] of sum) out.set(m, s / cnt.get(m));
  return out;
}

// 월별 지도를 [M0..M1] 배열로 펴고, 빈 달은 직전 값으로 최대 cap개월까지 채운다.
export function toArray(map, M0, M1, cap) {
  const arr = new Array(M1 - M0 + 1).fill(null);
  let last = null, age = 0;
  for (let m = M0; m <= M1; m++) {
    if (map.has(m)) { last = map.get(m); age = 0; arr[m - M0] = last; }
    else if (last !== null && ++age <= cap) arr[m - M0] = last;
  }
  return arr;
}

// "GS10 - TB3MS", "M2SL / CPIAUCSL", "WALCL - WTREGEN - 1000 * RRPONTSYD" 형태를 해석한다.
export function parseFormula(f) {
  if (f.includes("/")) {
    const [num, den] = f.split("/").map((s) => s.trim());
    return { type: "ratio", num, den, ids: [num, den] };
  }
  const terms = [];
  const re = /([+-]?)\s*(?:(\d+(?:\.\d+)?)\s*\*\s*)?([A-Z][A-Z0-9]*)/g;
  let mt;
  while ((mt = re.exec(f))) terms.push([mt[3], (mt[1] === "-" ? -1 : 1) * (mt[2] ? Number(mt[2]) : 1)]);
  return { type: "linear", terms, ids: terms.map((t) => t[0]) };
}

export function combine(calc, arrays, n, fillZero) {
  const get = (id, i) => { const v = arrays[id][i]; return v === null && fillZero.includes(id) ? 0 : v; };
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (calc.type === "ratio") {
      const a = get(calc.num, i), b = get(calc.den, i);
      if (a !== null && b !== null && b !== 0) out[i] = a / b;
    } else {
      let s = 0, ok = true, real = false;
      for (const [id, c] of calc.terms) {
        const v = get(id, i);
        if (v === null) { ok = false; break; }
        if (arrays[id][i] !== null) real = true; // 0으로 채운 값만으로는 계산하지 않는다
        s += c * v;
      }
      if (ok && real) out[i] = s;
    }
  }
  return out;
}

export function transform(arr, tf) {
  const n = arr.length, out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const x = arr[i];
    if (x === null) continue;
    if (tf === "level") out[i] = x;
    else if (tf === "yoy_pct") { const p = arr[i - 12]; if (p != null && p > 0) out[i] = (x / p - 1) * 100; }
    else if (tf === "yoy_diff") { const p = arr[i - 12]; if (p != null) out[i] = x - p; }
    else if (tf === "chg3m_pct") { const p = arr[i - 3]; if (p != null && p > 0) out[i] = (x / p - 1) * 100; }
    else if (tf === "ma3") { const a = arr[i - 1], b = arr[i - 2]; if (a != null && b != null) out[i] = (x + a + b) / 3; }
    else throw new Error(`알 수 없는 변환 코드: ${tf}`);
  }
  return out;
}

// 각 시점의 값이 "그 시점까지의 자기 역사"에서 몇 번째 백분위인지 구한다(미래 자료 미사용).
export function percentileScores(arr, direction, minHist) {
  const sorted = [], out = new Array(arr.length).fill(null);
  const lower = (x) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  const upper = (x) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; } return lo; };
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x === null) continue;
    sorted.splice(lower(x), 0, x);
    if (sorted.length < minHist) continue;
    const less = lower(x), lessEq = upper(x);
    const pct = ((less + 0.5 * (lessEq - less)) / sorted.length) * 100;
    out[i] = direction > 0 ? pct : 100 - pct;
  }
  return out;
}

// 별점 가중 평균. 그 시점에 점수가 있는 지표만 쓴다((가)안). 몇 개가 들어갔는지도 돌려준다.
export function weightedGroup(members, scores, n) {
  const value = new Array(n).fill(null), used = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0, k = 0;
    for (const ind of members) {
      const v = scores[ind.id][i];
      if (v === null) continue;
      const wt = ind.stars ?? 1;
      s += wt * v; w += wt; k++;
    }
    if (k) { value[i] = s / w; used[i] = k; }
  }
  return { value, used, total: members.length };
}

export function meanOf(arrays, n) {
  const value = new Array(n).fill(null), used = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0, k = 0;
    for (const a of arrays) if (a[i] !== null) { s += a[i]; k++; }
    if (k) { value[i] = s / k; used[i] = k; }
  }
  return { value, used, total: arrays.length };
}

// 수준(50 기준)과 방향(lookback개월 변화)으로 4국면을 정하고, confirm개월 연속일 때만 바꾼다.
export function phases(level, dirSource, names, lookback, confirm) {
  // 수준(높음/낮음)과 방향(개선/악화)을 따로 확정한다. 한쪽이 매달 뒤집혀도 다른 쪽 판정이 묶이지 않게 하기 위해서다.
  const n = level.length, out = new Array(n).fill(null);
  const hiRaw = new Array(n).fill(null), upRaw = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const L = level[i], d0 = dirSource[i], d1 = dirSource[i - lookback];
    if (L === null || d0 == null || d1 == null) continue;
    hiRaw[i] = L >= 50;
    upRaw[i] = d0 - d1 >= 0;
  }
  const settle = (raw) => {
    const res = new Array(n).fill(null);
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (raw[i] !== null) {
        if (cur === null) cur = raw[i];
        else if (raw[i] !== cur) {
          let stable = true;
          for (let k = 1; k < confirm; k++) if (raw[i - k] !== raw[i]) stable = false;
          if (stable) cur = raw[i];
        }
      }
      res[i] = cur;
    }
    return res;
  };
  const hi = settle(hiRaw), up = settle(upRaw);
  for (let i = 0; i < n; i++) {
    if (hi[i] === null || up[i] === null) continue;
    out[i] = hi[i] ? (up[i] ? names[0] : names[1]) : (up[i] ? names[2] : names[3]);
  }
  return { phase: out, high: hi };
}

// 일간 지수에서 "고점 대비 20% 이상 하락"의 시작점(고점이 있던 달)을 찾는다.
export function bearStarts(observations) {
  const events = [];
  let state = "bull", peak = -Infinity, peakDate = null, trough = Infinity;
  for (const [date, raw] of observations) {
    const p = Number(raw);
    if (raw === "." || !Number.isFinite(p) || p <= 0) continue;
    if (state === "bull") {
      if (p > peak) { peak = p; peakDate = date; }
      else if (p <= peak * 0.8) { events.push(ym(peakDate)); state = "bear"; trough = p; }
    } else {
      if (p < trough) trough = p;
      else if (p >= trough * 1.2) { state = "bull"; peak = p; peakDate = date; }
    }
  }
  return events;
}

// ---------- 별점 ----------
function leadStats(score, M0, recStarts, allEvents, usrec, rules, lastM) {
  const { signal_threshold: TH, lead_window_months: W, episode_gap_months: GAP, signal_min_months: MIN = 1 } = rules;
  const at = (m) => (m - M0 >= 0 && m - M0 < score.length ? score[m - M0] : null);
  // 신호: 점수가 MIN개월 연속으로 기준 미만일 때 켜진 것으로 본다(한 달짜리 흔들림 제외)
  const on = (m) => { for (let k = 0; k < MIN; k++) { const v = at(m - k); if (v === null || v >= TH) return false; } return true; };
  const evalEvents = (events) => {
    let eligible = 0, hits = 0; const leads = [];
    for (const e of events) {
      if (at(e - W) === null) continue; // 그때 아직 점수가 없던 지표는 그 사건에서 제외
      eligible++;
      let first = null;
      for (let m = e - W; m <= e; m++) { if (on(m)) { first = m; break; } }
      if (first !== null) { hits++; leads.push(e - first); }
    }
    return { eligible, hits, rate: eligible ? hits / eligible : null, avgLead: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null };
  };
  // 오신호: 신호가 켜졌는데 그 뒤 W개월 안에 침체도 약세장도 없었던 경우
  let falseSignals = 0, episodes = 0;
  const start = ym(rules.backtest_start);
  for (let m = start; m <= lastM - W; m++) {
    if (!on(m)) continue;
    let fresh = true;
    for (let k = 1; k <= GAP; k++) { if (on(m - k)) { fresh = false; break; } }
    if (!fresh) continue;
    episodes++;
    if (usrec[m - M0] === 1) continue;
    if (!allEvents.some((e) => e >= m && e <= m + W)) falseSignals++;
  }
  return { rec: evalEvents(recStarts), bear: null, falseSignals, episodes };
}

function confirmStats(score, M0, usrec, rules, extendAfter) {
  const start = ym(rules.backtest_start) - M0;
  let months = 0, low = 0, tail = 0;
  for (let i = Math.max(start, 0); i < score.length; i++) {
    // 침체 중인 달, 그리고 침체가 끝난 뒤 extendAfter개월까지를 평가 대상으로 본다
    let inWindow = false;
    if (usrec[i] === 1) { inWindow = true; tail = extendAfter; }
    else if (tail > 0) { inWindow = true; tail--; }
    if (!inWindow || score[i] === null) continue;
    months++;
    if (score[i] < rules.signal_threshold) low++;
  }
  return { months, low, rate: months ? low / months : null };
}

function starFromLead(st) {
  if (st.rec.eligible < 3) return { stars: null, reason: `평가 가능한 침체가 ${st.rec.eligible}회뿐(3회 미만)` };
  const r = st.rec.rate;
  if (r >= 0.8 && st.falseSignals <= 2) return { stars: 3, reason: "" };
  if (r >= 0.6) return { stars: 2, reason: r >= 0.8 ? `오신호 ${st.falseSignals}회로 3개 미달` : "" };
  return { stars: 1, reason: "" };
}

function starFromConfirm(st) {
  if (st.months < 24) return { stars: null, reason: `평가 가능한 달이 ${st.months}개월뿐(24개월 미만)` };
  if (st.rate >= 0.8) return { stars: 3, reason: "" };
  if (st.rate >= 0.6) return { stars: 2, reason: "" };
  return { stars: 1, reason: "" };
}

// ---------- 출력 도구 ----------
const f1 = (v) => (v === null || v === undefined ? "-" : v.toFixed(1));
const pctStr = (v) => (v === null || v === undefined ? "-" : `${Math.round(v * 100)}%`);
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  const rules = config.rules;
  const apiKey = process.env.FRED_API_KEY;
  if (!OFFLINE && !apiKey) { console.error("FRED_API_KEY 환경변수가 없습니다. 작업 지시서의 '사람이 먼저 할 일'을 진행하세요."); process.exit(1); }
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  // 1. 필요한 시리즈 목록
  const scored = config.indicators.filter((i) => i.role === "score" || i.role === "gauge");
  for (const ind of scored) ind.calc = parseFormula(ind.formula);
  const ids = new Set(["USREC", "NASDAQCOM"]);
  for (const ind of scored) for (const id of ind.calc.ids) ids.add(id);

  // 2. 자료 받기
  console.log(`시리즈 ${ids.size}개를 ${OFFLINE ? "data/raw 에서 읽습니다" : "FRED에서 받습니다"}.`);
  const raw = {};
  for (const id of ids) {
    raw[id] = await loadSeries(id, apiKey);
    console.log(`  ${id}: ${raw[id].length}건`);
    if (!OFFLINE) await sleep(600);
  }

  // 3. 월간 배열로 통일
  const monthly = {};
  let M0 = Infinity, M1 = -Infinity;
  for (const id of ids) {
    monthly[id] = toMonthly(raw[id]);
    for (const m of monthly[id].keys()) { if (m < M0) M0 = m; if (m > M1) M1 = m; }
  }
  const n = M1 - M0 + 1;
  const arrays = {};
  for (const id of ids) arrays[id] = toArray(monthly[id], M0, M1, id === "USREC" ? 0 : rules.ffill_cap_months);
  const usrec = arrays.USREC;
  // USREC 는 발표가 늦으므로, 마지막 값 이후는 "침체 아님"으로 둔다
  let lastRec = n - 1; while (lastRec >= 0 && usrec[lastRec] === null) lastRec--;
  for (let i = lastRec + 1; i < n; i++) usrec[i] = 0;

  // 4. 지표별 점수
  const scores = {}, values = {};
  for (const ind of scored) {
    const combined = combine(ind.calc, arrays, n, rules.fill_zero_series ?? []);
    values[ind.id] = transform(combined, ind.tf);
    scores[ind.id] = percentileScores(values[ind.id], ind.direction, rules.min_history_months);
  }

  // 5. 그룹 점수(표준 세트)
  const std = scored.filter((i) => i.standard);
  const byGroup = (g) => std.filter((i) => i.group === g);
  const G = {};
  for (const g of ["선행", "동행", "후행", "물가", "연준·단기자금", "국채", "기업 채권", "은행"]) G[g] = weightedGroup(byGroup(g), scores, n);
  const liqGroups = ["연준·단기자금", "국채", "기업 채권", "은행"];
  const liq = meanOf(liqGroups.map((g) => G[g].value), n);
  const liqIndUsed = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (const g of liqGroups) liqIndUsed[i] += G[g].used[i];
  const liqIndTotal = liqGroups.reduce((a, g) => a + G[g].total, 0);

  // 6. 국면
  const LB = rules.direction_lookback_months, CF = rules.phase_confirm_months;
  const econ = phases(G["동행"].value, G["선행"].value, ["확장", "둔화", "회복", "수축"], LB, CF);
  const liqP = phases(liq.value, liq.value, ["완화 확대", "완화 축소", "긴축 완화", "긴축 심화"], LB, CF);
  const econPhase = econ.phase, liqPhase = liqP.phase;
  // 종합 4분면도 확정된 수준(연속 확인을 거친 높음/낮음)으로 정해 국면 표시와 어긋나지 않게 한다
  const quadrant = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const e = econ.high[i], l = liqP.high[i];
    if (e === null || l === null) continue;
    quadrant[i] = e ? (l ? "순풍" : "과열·긴축") : (l ? "부양" : "위기");
  }

  // 7. 기준 사건
  const BT0 = ym(rules.backtest_start);
  const recStarts = [];
  for (let i = 1; i < n; i++) if (usrec[i] === 1 && usrec[i - 1] === 0 && M0 + i >= BT0) recStarts.push(M0 + i);
  const bears = bearStarts(raw.NASDAQCOM).filter((m) => m >= BT0);
  const allEvents = [...recStarts, ...bears];

  // 8. 별점
  const starRows = [];
  for (const ind of scored) {
    const isLeadType = ind.group === "선행" || ind.category === "유동성 지표";
    let row = { id: ind.id, name: ind.name, group: ind.group, standard: ind.standard, current: ind.stars, method: "", proposed: null, reason: "", detail: "" };
    const firstScore = scores[ind.id].findIndex((v) => v !== null);
    row.scoreStart = firstScore >= 0 ? ymStr(M0 + firstScore) : "-";
    if (ind.group === "물가") {
      row.method = "미적용"; row.reason = "물가 게이지는 별점 규칙 대상이 아님. 현재 별점 유지"; row.proposed = ind.stars;
    } else if (isLeadType) {
      const st = leadStats(scores[ind.id], M0, recStarts, allEvents, usrec, rules, M1);
      const bearEval = leadStats(scores[ind.id], M0, bears, allEvents, usrec, rules, M1).rec;
      const s = starFromLead(st);
      row.method = "선행 적중"; row.proposed = s.stars; row.reason = s.reason;
      row.detail = `침체 ${st.rec.hits}/${st.rec.eligible} 적중(${pctStr(st.rec.rate)}), 평균 선행 ${f1(st.rec.avgLead)}개월, 오신호 ${st.falseSignals}회 / 약세장 ${bearEval.hits}/${bearEval.eligible}(${pctStr(bearEval.rate)})`;
      row.recRate = st.rec.rate; row.bearRate = bearEval.rate; row.falseSignals = st.falseSignals; row.eligible = st.rec.eligible;
    } else {
      const st = confirmStats(scores[ind.id], M0, usrec, rules, ind.group === "후행" ? 6 : 0);
      const s = starFromConfirm(st);
      row.method = ind.group === "후행" ? "침체기+6개월 확인" : "침체기 확인"; row.proposed = s.stars; row.reason = s.reason;
      row.detail = `해당 ${st.months}개월 중 ${st.low}개월이 점수 30 미만(${pctStr(st.rate)})`;
      row.recRate = st.rate;
    }
    starRows.push(row);
  }

  // 9. 표준 세트 과거 검증
  const at = (arr, m) => (m - M0 >= 0 && m - M0 < n ? arr[m - M0] : null);
  const sigMin = rules.signal_min_months ?? 1;
  const sigOn = (arr, m) => { for (let k = 0; k < sigMin; k++) { const v = at(arr, m - k); if (v === null || v >= rules.signal_threshold) return false; } return true; };
  const firstBelow = (arr, e) => { for (let m = e - rules.lead_window_months; m <= e; m++) { if (sigOn(arr, m)) return e - m; } return null; };
  const eventTable = (events) => events.map((e) => ({
    date: ymStr(e),
    lead12: at(G["선행"].value, e - 12), lead6: at(G["선행"].value, e - 6), lead0: at(G["선행"].value, e),
    leadSignal: firstBelow(G["선행"].value, e),
    coin0: at(G["동행"].value, e),
    liq6: at(liq.value, e - 6), liq0: at(liq.value, e), liqSignal: firstBelow(liq.value, e),
    phase6: at(econPhase, e - 6), phase0: at(econPhase, e), quad0: at(quadrant, e),
    liqCover: `${at(liqIndUsed, e) ?? 0}/${liqIndTotal}`,
  }));
  const recTable = eventTable(recStarts), bearTable = eventTable(bears);
  const stdLead = leadStats(G["선행"].value, M0, recStarts, allEvents, usrec, rules, M1);
  const stdLiq = leadStats(liq.value, M0, recStarts, allEvents, usrec, rules, M1);

  // 10. 파일 쓰기
  const stamp = new Date().toISOString().slice(0, 10);
  let last = n - 1; while (last > 0 && G["동행"].value[last] === null && liq.value[last] === null) last--;

  const header = ["월", "선행", "동행", "후행", "물가압력", "유동성", "연준·단기자금", "국채", "기업채권", "은행", "경기국면", "유동성국면", "종합", "선행지표수", "동행지표수", "유동성지표수", "침체"];
  const lines = [header.join(",")];
  for (let i = Math.max(BT0 - M0 - 60, 0); i <= last; i++) {
    lines.push([ymStr(M0 + i), f1(G["선행"].value[i]), f1(G["동행"].value[i]), f1(G["후행"].value[i]), f1(G["물가"].value[i]), f1(liq.value[i]),
      f1(G["연준·단기자금"].value[i]), f1(G["국채"].value[i]), f1(G["기업 채권"].value[i]), f1(G["은행"].value[i]),
      econPhase[i] ?? "-", liqPhase[i] ?? "-", quadrant[i] ?? "-",
      `${G["선행"].used[i]}/${G["선행"].total}`, `${G["동행"].used[i]}/${G["동행"].total}`, `${liqIndUsed[i]}/${liqIndTotal}`, usrec[i] ?? 0].map(csvCell).join(","));
  }
  await writeFile(join(OUT_DIR, "scores-monthly.csv"), "﻿" + lines.join("\n"), "utf8");

  const indHeader = ["월", ...scored.map((i) => i.name)];
  const indLines = [indHeader.map(csvCell).join(",")];
  for (let i = Math.max(BT0 - M0 - 60, 0); i <= last; i++) indLines.push([ymStr(M0 + i), ...scored.map((ind) => f1(scores[ind.id][i]))].join(","));
  await writeFile(join(OUT_DIR, "scores-by-indicator.csv"), "﻿" + indLines.join("\n"), "utf8");

  const starCsv = [["지표", "그룹", "표준", "점수 시작", "현재 별점", "제안 별점", "판정 방식", "근거", "비고"].join(",")]
    .concat(starRows.map((r) => [r.name, r.group, r.standard ? "O" : "X", r.scoreStart, r.current ?? "-", r.proposed ?? "판정 불가", r.method, r.detail, r.reason].map(csvCell).join(",")));
  await writeFile(join(OUT_DIR, "stars.csv"), "﻿" + starCsv.join("\n"), "utf8");
  await writeFile(join(ROOT, "config", "stars-proposed.json"), JSON.stringify({ generated: stamp, note: "제안값. indicators.json 에는 자동 반영하지 않는다.", stars: Object.fromEntries(starRows.map((r) => [r.id, r.proposed])) }, null, 1), "utf8");

  const changed = starRows.filter((r) => r.proposed !== null && r.proposed !== r.current);
  const undecided = starRows.filter((r) => r.proposed === null);
  const evRow = (r) => `| ${r.date} | ${f1(r.lead12)} | ${f1(r.lead6)} | ${f1(r.lead0)} | ${r.leadSignal === null ? "신호 없음" : r.leadSignal + "개월 전"} | ${f1(r.coin0)} | ${f1(r.liq6)} | ${f1(r.liq0)} | ${r.liqSignal === null ? "신호 없음" : r.liqSignal + "개월 전"} | ${r.phase6 ?? "-"} | ${r.phase0 ?? "-"} | ${r.quad0 ?? "-"} | ${r.liqCover} |`;
  const evHead = ["| 사건 시작 | 선행 12개월 전 | 선행 6개월 전 | 선행 당월 | 선행 신호 | 동행 당월 | 유동성 6개월 전 | 유동성 당월 | 유동성 신호 | 국면 6개월 전 | 국면 당월 | 종합 당월 | 유동성 지표 수 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];

  const md = [
    `# 점수·별점·과거 검증 보고서 (${stamp})`,
    "",
    `- 설정 파일 버전: ${config.version}`,
    `- 계산 구간: ${ymStr(M0)} ~ ${ymStr(M0 + last)} (검증은 ${rules.backtest_start} 이후)`,
    `- 신호 기준: 점수 ${rules.signal_threshold} 미만이 ${rules.signal_min_months ?? 1}개월 연속 / 선행 창: ${rules.lead_window_months}개월 / 최소 이력: ${rules.min_history_months}개월`,
    "",
    "## 1. 현재 판정",
    "",
    `기준월: ${ymStr(M0 + last)}`,
    "",
    "| 항목 | 값 | 계산에 들어간 지표 수 |",
    "|---|---|---|",
    `| 선행 점수 | ${f1(G["선행"].value[last])} | ${G["선행"].used[last]}/${G["선행"].total} |`,
    `| 동행 점수 | ${f1(G["동행"].value[last])} | ${G["동행"].used[last]}/${G["동행"].total} |`,
    `| 후행 점수(확인용) | ${f1(G["후행"].value[last])} | ${G["후행"].used[last]}/${G["후행"].total} |`,
    `| 물가 압력 | ${f1(G["물가"].value[last])} | ${G["물가"].used[last]}/${G["물가"].total} |`,
    `| 유동성 점수 | ${f1(liq.value[last])} | ${liqIndUsed[last]}/${liqIndTotal} |`,
    ...liqGroups.map((g) => `| 유동성 - ${g} | ${f1(G[g].value[last])} | ${G[g].used[last]}/${G[g].total} |`),
    `| 경기 국면 | ${econPhase[last] ?? "-"} | |`,
    `| 유동성 국면 | ${liqPhase[last] ?? "-"} | |`,
    `| 종합 4분면 | ${quadrant[last] ?? "-"} | |`,
    "",
    "점수는 0~100이고 50이 역사적 중간이다. 높을수록 경기 확장·유동성 완화, 물가 압력은 높을수록 압력이 크다.",
    "",
    "## 2. 표준 세트 과거 검증: 경기침체",
    "",
    `- 선행 종합 점수: 침체 ${stdLead.rec.hits}/${stdLead.rec.eligible}회 사전 신호(${pctStr(stdLead.rec.rate)}), 평균 ${f1(stdLead.rec.avgLead)}개월 전, 오신호 ${stdLead.falseSignals}회(신호 구간 ${stdLead.episodes}회 중)`,
    `- 유동성 종합 점수: 침체 ${stdLiq.rec.hits}/${stdLiq.rec.eligible}회 사전 신호(${pctStr(stdLiq.rec.rate)}), 평균 ${f1(stdLiq.rec.avgLead)}개월 전, 오신호 ${stdLiq.falseSignals}회(신호 구간 ${stdLiq.episodes}회 중)`,
    "",
    ...evHead, ...recTable.map(evRow),
    "",
    "## 3. 표준 세트 과거 검증: 나스닥 20% 이상 하락",
    "",
    "사건 시작은 하락 직전 고점이 있던 달이다.",
    "",
    ...evHead, ...(bearTable.length ? bearTable.map(evRow) : ["| 해당 없음 | | | | | | | | | | | | |"]),
    "",
    "## 4. 별점 제안",
    "",
    `- 현재 별점과 다른 지표: ${changed.length}개 / 판정 불가: ${undecided.length}개`,
    "- 이 표는 제안이다. config/indicators.json 은 바뀌지 않았다. 반영 여부는 사람이 정한다.",
    "",
    "| 지표 | 그룹 | 표준 | 점수 시작 | 현재 | 제안 | 판정 방식 | 근거 | 비고 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...starRows.map((r) => `| ${r.name} | ${r.group} | ${r.standard ? "O" : "X"} | ${r.scoreStart} | ${r.current ?? "-"} | ${r.proposed ?? "판정 불가"} | ${r.method} | ${r.detail || "-"} | ${r.reason || "-"} |`),
    "",
    "## 5. 이 검증의 한계",
    "",
    "- 수정된 최종 자료를 썼다. 당시 실제로 발표된 초기 수치가 아니다. 고용·소득처럼 사후 수정이 큰 지표는 실전보다 좋게 나온다.",
    "- 관측 월 기준으로 계산했다. 실제로는 지표가 한두 달 뒤에 발표되므로, 실전의 신호는 이 표보다 한두 달 늦다.",
    `- 검증 대상 침체는 ${recStarts.length}회뿐이다. 표본이 작아 적중률 숫자를 과신하면 안 된다.`,
    "- 초기 구간은 계산에 들어간 지표 수가 적다. 각 표의 '지표 수' 열을 함께 봐야 한다.",
    "- 별점 임계값(신호 30, 창 18개월, 80%·60%)은 잠정값이다. 값을 바꾸면 별점이 달라진다.",
    "",
  ].join("\n");
  await writeFile(join(OUT_DIR, `backtest-report-${stamp}.md`), md, "utf8");

  console.log(`\n완료. reports/backtest-report-${stamp}.md 를 확인하세요.`);
  console.log(`현재(${ymStr(M0 + last)}): 경기 ${econPhase[last] ?? "-"} / 유동성 ${liqPhase[last] ?? "-"} / 종합 ${quadrant[last] ?? "-"}`);
  console.log(`침체 ${recStarts.length}회, 나스닥 20% 하락 ${bears.length}회를 기준 사건으로 썼습니다.`);
}

// 다른 파일에서 불러 쓸 때는 실행하지 않는다(시험용)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
}
