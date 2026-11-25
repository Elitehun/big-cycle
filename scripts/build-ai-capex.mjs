// BIG CYCLE 5-3단계: 저장해 둔 SEC 파일에서 "AI 투자 사이클" 숫자를 뽑아 data/manual/ai-capex.json 을 만든다
// 실행: node scripts/build-ai-capex.mjs
// SEC에 요청을 보내지 않는다. data/sec 의 5개 파일만 읽는다. 분기에 한 번, 파일을 새로 저장한 뒤 실행한다.
// 만든 ai-capex.json 은 계산된 숫자만 담고 있어 깃허브에 올라간다(원본 파일은 올라가지 않는다).

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toQuarters } from "./check-sec-capex.mjs";
import { instants } from "./check-sec-balance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEC_DIR = join(ROOT, "data", "sec"), OUT = join(ROOT, "data", "manual", "ai-capex.json");
const exists = (p) => access(p).then(() => true, () => false);
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v / 1e8) / 10);   // 달러 -> 10억 달러, 소수 1자리

// 회사마다 장부 항목 이름이 달라, 5-1·5-2 확인 결과에 따라 회사별로 정해 둔다.
// debt 의 must 는 반드시 있어야 하는 항목, plus 는 있으면 더하고 없으면 0으로 보는 항목이다.
const COMPANIES = [
  { ticker: "MSFT", name: "마이크로소프트", cik: 789019, capex: "PaymentsToAcquirePropertyPlantAndEquipment", debt: { must: ["LongTermDebt"], plus: [] } },
  { ticker: "GOOGL", name: "알파벳", cik: 1652044, capex: "PaymentsToAcquirePropertyPlantAndEquipment", debt: { must: ["LongTermDebtNoncurrent"], plus: ["LongTermDebtCurrent", "CommercialPaper"] } },
  { ticker: "AMZN", name: "아마존", cik: 1018724, capex: "PaymentsToAcquireProductiveAssets", debt: { must: ["LongTermDebt"], plus: ["ShortTermBorrowings"] } },
  { ticker: "META", name: "메타", cik: 1326801, capex: "PaymentsToAcquirePropertyPlantAndEquipment", debt: { must: ["LongTermDebtNoncurrent"], plus: ["LongTermDebtCurrent"] } },
  { ticker: "ORCL", name: "오라클", cik: 1341439, capex: "PaymentsToAcquirePropertyPlantAndEquipment", debt: { must: ["DebtLongtermAndShorttermCombinedAmount"], plus: [] }, debtYearly: true },
];
const OCF = "NetCashProvidedByUsedInOperatingActivities";
const START = "2016-12-31";   // 5개사가 모두 갖춰지는 2017년부터 쓴다

// 분기 끝 날짜가 속한 달력 분기. 오라클처럼 2·5·8·11월에 끝나는 회사는 가장 가까운 달력 분기로 간다.
const calQ = (end) => { const d = new Date(end); d.setUTCDate(d.getUTCDate() - 20); return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };
const prevYear = (cal) => `${Number(cal.slice(0, 4)) - 1}${cal.slice(4)}`;

async function loadFacts(c) {
  const a = join(SEC_DIR, `${c.ticker}.json`), b = join(SEC_DIR, `CIK${String(c.cik).padStart(10, "0")}.json`);
  const use = (await exists(a)) ? a : (await exists(b)) ? b : null;
  if (!use) throw new Error(`data/sec 에 ${c.ticker}.json 또는 CIK${String(c.cik).padStart(10, "0")}.json 이 없습니다`);
  return JSON.parse((await readFile(use, "utf8")).replace(/^﻿/, ""));
}

// 최근 4분기 합계. 4분기가 빠짐없이 이어질 때만 값을 낸다.
function ttm(byCal, cal) {
  let sum = 0, y = Number(cal.slice(0, 4)), q = Number(cal.slice(5));
  for (let i = 0; i < 4; i++) {
    const k = `${y}Q${q}`;
    if (!(k in byCal) || byCal[k] === null) return null;
    sum += byCal[k];
    q--; if (q === 0) { q = 4; y--; }
  }
  return Math.round(sum * 10) / 10;
}

async function main() {
  const companies = [], problems = [];
  for (const c of COMPANIES) {
    const gaap = (await loadFacts(c)).facts?.["us-gaap"] ?? {};
    const capexQ = toQuarters(gaap[c.capex]?.units?.USD ?? []).filter((x) => x.end > START);
    const ocfQ = toQuarters(gaap[OCF]?.units?.USD ?? []).filter((x) => x.end > START);
    if (!capexQ.length || !ocfQ.length) { problems.push(`${c.name}: 설비투자 또는 영업현금흐름을 찾지 못함`); continue; }
    const capex = {}, ocf = {};
    for (const x of capexQ) capex[calQ(x.end)] = r1(x.val);
    for (const x of ocfQ) ocf[calQ(x.end)] = r1(x.val);

    // 총차입금: 꼭 있어야 하는 항목이 있는 날짜에만 값을 낸다
    const series = {};
    for (const n of [...c.debt.must, ...c.debt.plus, "OperatingLeaseLiability", "FinanceLeaseLiability"]) series[n] = instants(gaap[n]?.units?.USD);
    const debt = {}, lease = {};
    for (const [end] of series[c.debt.must[0]]) {
      if (end <= START || !c.debt.must.every((n) => series[n].has(end))) continue;
      let v = 0;
      for (const n of c.debt.must) v += series[n].get(end);
      for (const n of c.debt.plus) v += series[n].get(end) ?? 0;
      debt[calQ(end)] = r1(v);
    }
    // 리스 부채: 운용리스와 금융리스가 둘 다 보고된 날짜에만 값을 낸다
    for (const [end, v] of series.OperatingLeaseLiability) {
      if (end <= START || !series.FinanceLeaseLiability.has(end)) continue;
      lease[calQ(end)] = r1(v + series.FinanceLeaseLiability.get(end));
    }
    const cals = Object.keys(capex).filter((k) => k in ocf).sort();
    const last = cals[cals.length - 1];
    const tC = ttm(capex, last), tO = ttm(ocf, last), tCp = ttm(capex, prevYear(last)), tOp = ttm(ocf, prevYear(last));
    const debtCals = Object.keys(debt).sort(), leaseCals = Object.keys(lease).sort();
    const dLast = debtCals[debtCals.length - 1] ?? null, lLast = leaseCals[leaseCals.length - 1] ?? null;
    companies.push({
      ticker: c.ticker, name: c.name, lastQuarter: last, lastEnd: capexQ[capexQ.length - 1].end,
      capex, ocf, debt, lease,
      ttmCapex: tC, ttmOcf: tO, ratio: tC !== null && tO ? Math.round((tC / tO) * 100) : null,
      ratioYearAgo: tCp !== null && tOp ? Math.round((tCp / tOp) * 100) : null,
      debtQuarter: dLast, debtNow: dLast ? debt[dLast] : null, debtYearAgo: dLast ? debt[prevYear(dLast)] ?? null : null, debtYearly: !!c.debtYearly,
      leaseQuarter: lLast, leaseNow: lLast ? lease[lLast] : null, leaseYearAgo: lLast ? lease[prevYear(lLast)] ?? null : null,
      leaseYearly: leaseCals.length > 0 && leaseCals.slice(-3).every((k) => k.endsWith("Q4")),
    });
  }
  if (companies.length !== COMPANIES.length) { console.error("일부 회사의 자료가 없어 멈춥니다:\n" + problems.join("\n")); process.exit(1); }

  // 5개사 합계: 다섯 회사가 모두 있는 달력 분기만
  const allCals = [...new Set(companies.flatMap((c) => Object.keys(c.capex)))].sort();
  const tCapex = {}, tOcf = {};
  for (const k of allCals) if (companies.every((c) => k in c.capex && k in c.ocf)) { tCapex[k] = Math.round(companies.reduce((s, c) => s + c.capex[k], 0) * 10) / 10; tOcf[k] = Math.round(companies.reduce((s, c) => s + c.ocf[k], 0) * 10) / 10; }
  const tCals = Object.keys(tCapex).sort(), tLast = tCals[tCals.length - 1];
  const series = tCals.map((k) => { const a = ttm(tCapex, k), b = ttm(tOcf, k); return { q: k, capex: tCapex[k], ocf: tOcf[k], ttmRatio: a !== null && b ? Math.round((a / b) * 100) : null }; });
  const tC = ttm(tCapex, tLast), tO = ttm(tOcf, tLast), tCp = ttm(tCapex, prevYear(tLast)), tOp = ttm(tOcf, prevYear(tLast));

  // 총차입금 합계: 분기 자료가 있는 회사(오라클 제외)만, 모두 값이 있는 가장 최근 분기와 그 1년 전
  const qCos = companies.filter((c) => !c.debtYearly);
  const dCals = [...new Set(qCos.flatMap((c) => Object.keys(c.debt)))].sort().filter((k) => qCos.every((c) => k in c.debt));
  const dLast = dCals[dCals.length - 1] ?? null;
  const dSum = (k) => (k && qCos.every((c) => k in c.debt) ? Math.round(qCos.reduce((s, c) => s + c.debt[k], 0) * 10) / 10 : null);

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    unit: "10억 달러",
    source: "미국 증권거래위원회(SEC) 공시 자료. 각 회사가 제출한 분기·연간 보고서의 현금흐름표와 재무상태표",
    total: {
      quarter: tLast, ttmCapex: tC, ttmOcf: tO, ratio: tC !== null && tO ? Math.round((tC / tO) * 100) : null,
      ratioYearAgo: tCp !== null && tOp ? Math.round((tCp / tOp) * 100) : null,
      capexGrowth: tC !== null && tCp ? Math.round((tC / tCp - 1) * 100) : null,
      quarterRatio: tOcf[tLast] ? Math.round((tCapex[tLast] / tOcf[tLast]) * 100) : null,
      debtQuarter: dLast, debtNow: dSum(dLast), debtYearAgo: dLast ? dSum(prevYear(dLast)) : null, debtCompanies: qCos.map((c) => c.name),
      series,
    },
    companies: companies.map((c) => ({
      ticker: c.ticker, name: c.name, quarter: c.lastQuarter, lastEnd: c.lastEnd,
      ttmCapex: c.ttmCapex, ttmOcf: c.ttmOcf, ratio: c.ratio, ratioYearAgo: c.ratioYearAgo,
      debtQuarter: c.debtQuarter, debtNow: c.debtNow, debtYearAgo: c.debtYearAgo, debtYearly: c.debtYearly,
      leaseQuarter: c.leaseQuarter, leaseNow: c.leaseNow, leaseYearAgo: c.leaseYearAgo, leaseYearly: c.leaseYearly,
    })),
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 1), "utf8");

  const t = out.total;
  console.log(`5개사 합계 (${t.quarter} 까지 최근 4분기): 설비투자 ${t.ttmCapex}, 영업현금흐름 ${t.ttmOcf}, 비율 ${t.ratio}% (1년 전 ${t.ratioYearAgo}%), 설비투자 증가 ${t.capexGrowth}%, 최근 한 분기 비율 ${t.quarterRatio}%`);
  console.log(`총차입금 (${t.debtCompanies.join("·")}, ${t.debtQuarter}): ${t.debtNow} (1년 전 ${t.debtYearAgo})`);
  for (const c of out.companies) console.log(`${c.ticker}: ${c.quarter} 비율 ${c.ratio}% (1년 전 ${c.ratioYearAgo}%) · 총차입금 ${c.debtNow} (${c.debtQuarter}${c.debtYearly ? ", 연 1회" : ""}, 1년 전 ${c.debtYearAgo}) · 리스 ${c.leaseNow} (${c.leaseQuarter}${c.leaseYearly ? ", 연 1회" : ""}, 1년 전 ${c.leaseYearAgo})`);
  console.log("\n완료. data/manual/ai-capex.json 을 만들었습니다. 이어서 node scripts/build-web-data.mjs 를 실행하면 화면에 반영됩니다.");
}

main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
