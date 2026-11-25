// BIG CYCLE 5-2단계: 저장해 둔 SEC 파일에서 5개사의 총차입금·현금 잔액이 깔끔하게 나오는지 확인
// 실행: node scripts/check-sec-balance.mjs
// SEC에 요청을 보내지 않는다. data/sec 에 저장해 둔 파일만 읽는다.
// 결과: reports/sec-balance-check.md

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEC_DIR = join(ROOT, "data", "sec"), OUT = join(ROOT, "reports", "sec-balance-check.md");
const exists = (p) => access(p).then(() => true, () => false);

const COMPANIES = [
  { ticker: "MSFT", name: "마이크로소프트", cik: 789019 },
  { ticker: "GOOGL", name: "알파벳", cik: 1652044 },
  { ticker: "AMZN", name: "아마존", cik: 1018724 },
  { ticker: "META", name: "메타", cik: 1326801 },
  { ticker: "ORCL", name: "오라클", cik: 1341439 },
];

// 회사마다 장부 항목 이름이 다르다. 후보를 모두 뽑아 보여주고, 어떤 조합으로 합계를 낼지는 결과를 보고 정한다.
const DEBT_TOTAL = ["LongTermDebt", "DebtLongtermAndShorttermCombinedAmount", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities", "DebtAndCapitalLeaseObligations"];
const DEBT_NONCURRENT = ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermNotesPayable", "SeniorLongTermNotes"];
const DEBT_CURRENT = ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent", "DebtCurrent"];
const DEBT_SHORT = ["CommercialPaper", "ShortTermBorrowings"];
const CASH = ["CashAndCashEquivalentsAtCarryingValue"];
const SECURITIES = ["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "MarketableSecurities"];
const CASH_TOTAL = ["CashCashEquivalentsAndShortTermInvestments", "CashCashEquivalentsAndMarketableSecurities"];
const LEASES = ["OperatingLeaseLiability", "FinanceLeaseLiability", "OperatingLeaseLiabilityNoncurrent", "FinanceLeaseLiabilityNoncurrent"];

async function loadFacts(c) {
  const a = join(SEC_DIR, `${c.ticker}.json`), b = join(SEC_DIR, `CIK${String(c.cik).padStart(10, "0")}.json`);
  const use = (await exists(a)) ? a : (await exists(b)) ? b : null;
  if (!use) throw new Error(`data/sec 에 ${c.ticker}.json 또는 CIK${String(c.cik).padStart(10, "0")}.json 이 없습니다`);
  return JSON.parse((await readFile(use, "utf8")).replace(/^﻿/, ""));
}

// 잔액은 "어느 날 기준" 값이다(시작일이 없다). 같은 날짜가 여러 보고서에 실리면 가장 나중에 제출된 값을 쓴다.
export function instants(entries) {
  const best = new Map();
  for (const e of entries ?? []) {
    if (e.start || !e.end || typeof e.val !== "number") continue;
    const prev = best.get(e.end);
    if (!prev || (e.filed ?? "") > (prev.filed ?? "")) best.set(e.end, e);
  }
  return new Map([...best.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([end, e]) => [end, e.val]));
}

const bn = (v) => (v === null || v === undefined ? "—" : (v / 1e9).toFixed(1));

function firstWith(series, names, end) { for (const n of names) if (series[n]?.has(end)) return { name: n, val: series[n].get(end) }; return null; }

async function main() {
  await mkdir(dirname(OUT), { recursive: true });
  const md = ["# SEC 재무상태표 확인 (5-2단계)", "", `실행 시각: ${new Date().toISOString()}`, "", "금액 단위는 10억 달러. 분기 말 잔액입니다. SEC에 요청을 보내지 않고 저장해 둔 파일만 읽었습니다.", ""];
  const summary = [];
  for (const c of COMPANIES) {
    try {
      const facts = await loadFacts(c), gaap = facts.facts?.["us-gaap"] ?? {};
      const series = {};
      const all = [...DEBT_TOTAL, ...DEBT_NONCURRENT, ...DEBT_CURRENT, ...DEBT_SHORT, ...CASH, ...SECURITIES, ...CASH_TOTAL, ...LEASES];
      for (const n of all) { const m = instants(gaap[n]?.units?.USD); if (m.size) series[n] = m; }
      // 기준 날짜: 현금 잔액이 보고된 분기 말(연말 포함) 가운데 최근 8개
      const ends = [...(series.CashAndCashEquivalentsAtCarryingValue ?? new Map()).keys()].slice(-8);
      md.push(`## ${c.name} (${c.ticker})`, "", `- SEC에 등록된 이름: ${facts.entityName ?? "?"}`, `- 기준 분기 말: ${ends.join(", ") || "찾지 못함"}`, "");
      if (!ends.length) { summary.push(`${c.ticker}: 현금 잔액 항목을 찾지 못함`); continue; }

      md.push("### 후보 항목별 잔액", "", `| 항목 | ${ends.join(" | ")} |`, `| --- | ${ends.map(() => "---").join(" | ")} |`);
      for (const n of all) if (series[n]) md.push(`| \`${n}\` | ${ends.map((e) => bn(series[n].get(e) ?? null)).join(" | ")} |`);
      md.push("");

      // 잠정 합계: 총액 항목이 있으면 그것, 없으면 장기(비유동)+유동성 장기. 여기에 단기 차입(기업어음 등)을 더한다.
      md.push("### 잠정 합계", "", "| 분기 말 | 총차입금(잠정) | 구성 | 현금+유가증권(잠정) | 구성 | 리스 부채 |", "| --- | --- | --- | --- | --- | --- |");
      let filled = 0;
      const debtSeries = [];
      for (const e of ends) {
        const parts = []; let debt = null;
        const tot = firstWith(series, DEBT_TOTAL, e);
        if (tot) { debt = tot.val; parts.push(tot.name); }
        else {
          const nc = firstWith(series, DEBT_NONCURRENT, e), cu = firstWith(series, DEBT_CURRENT, e);
          if (nc) { debt = (debt ?? 0) + nc.val; parts.push(nc.name); }
          if (cu) { debt = (debt ?? 0) + cu.val; parts.push(cu.name); }
        }
        for (const n of DEBT_SHORT) if (series[n]?.has(e) && debt !== null) { debt += series[n].get(e); parts.push(n); }
        const cparts = []; let cash = null;
        const ct = firstWith(series, CASH_TOTAL, e);
        if (ct) { cash = ct.val; cparts.push(ct.name); }
        else {
          const ca = firstWith(series, CASH, e), se = firstWith(series, SECURITIES, e);
          if (ca) { cash = ca.val; cparts.push(ca.name); }
          if (se && cash !== null) { cash += se.val; cparts.push(se.name); }
        }
        const lease = ["OperatingLeaseLiability", "FinanceLeaseLiability"].reduce((s, n) => (series[n]?.has(e) ? (s ?? 0) + series[n].get(e) : s), null);
        if (debt !== null) filled++;
        debtSeries.push(debt);
        md.push(`| ${e} | ${bn(debt)} | ${parts.join(" + ") || "—"} | ${bn(cash)} | ${cparts.join(" + ") || "—"} | ${bn(lease)} |`);
      }
      md.push("");

      // 후보에 없는 항목을 놓치지 않도록 이름으로 훑어 본다(최근 값이 10억 달러 이상인 잔액 항목)
      const lastEnd = ends[ends.length - 1], found = [];
      for (const [name, cpt] of Object.entries(gaap)) {
        if (!/Debt|Borrow|NotesPayable|CommercialPaper|Notes$/i.test(name) || all.includes(name)) continue;
        const m = instants(cpt.units?.USD);
        if (m.has(lastEnd) && Math.abs(m.get(lastEnd)) >= 1e9) found.push(`- \`${name}\` · ${lastEnd} 잔액 ${bn(m.get(lastEnd))}`);
      }
      md.push("### 후보에 없지만 최근 잔액이 있는 차입 관련 항목", "", ...(found.length ? found.slice(0, 20) : ["- 없음"]), "");
      const nums = debtSeries.filter((v) => v !== null);
      summary.push(`${c.ticker}: 총차입금(잠정) ${filled}/${ends.length}분기 채워짐, 최근 ${bn(nums[nums.length - 1] ?? null)} (${lastEnd})`);
    } catch (e) {
      md.push(`## ${c.name} (${c.ticker})`, "", `실패: ${e.message}`, "");
      summary.push(`${c.ticker}: 실패 (${e.message})`);
    }
  }
  await writeFile(OUT, md.join("\n"), "utf8");
  console.log(summary.join("\n"));
  console.log("\n보고서: reports/sec-balance-check.md");
  if (summary.every((x) => x.includes("실패"))) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
