// BIG CYCLE 5-1단계: SEC 공시 자료에서 5개사의 설비투자·영업현금흐름·차입 조달이 잘 나오는지 확인
// 실행: node scripts/check-sec-capex.mjs
// 필요: 환경변수 SEC_USER_AGENT (예: "BIG CYCLE study 이름 이메일"). SEC가 요청자 식별을 요구한다. API 키는 없다.
// 결과: reports/sec-check.md, data/sec/<종목>.json (받아둔 원자료)

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEC_DIR = join(ROOT, "data", "sec"), OUT = join(ROOT, "reports", "sec-check.md");
const OFFLINE = process.argv.includes("--offline");
const UA = process.env.SEC_USER_AGENT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

const COMPANIES = [
  { ticker: "MSFT", name: "마이크로소프트", cik: 789019 },
  { ticker: "GOOGL", name: "알파벳", cik: 1652044 },
  { ticker: "AMZN", name: "아마존", cik: 1018724 },
  { ticker: "META", name: "메타", cik: 1326801 },
  { ticker: "ORCL", name: "오라클", cik: 1341439 },
];
// 회사마다 항목 이름이 달라 후보를 여럿 둔다. 가장 최근까지 이어지고 자료가 많은 것을 고른다.
const TAGS = {
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsToAcquireOtherPropertyPlantAndEquipment"],
  ocf: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  debt: ["ProceedsFromIssuanceOfLongTermDebt", "ProceedsFromDebtMaturingInMoreThanThreeMonths", "ProceedsFromIssuanceOfDebt", "ProceedsFromDebtNetOfIssuanceCosts",
    "ProceedsFromIssuanceOfSeniorLongTermDebt", "ProceedsFromIssuanceOfUnsecuredDebt", "ProceedsFromNotesPayable", "ProceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet"],
};

async function secGet(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" } });
    if (res.status === 429) { await sleep(3000 * attempt); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    return await res.json();
  }
  throw new Error("요청 한도 초과");
}

async function loadFacts(c) {
  const file = join(SEC_DIR, `${c.ticker}.json`);
  if (OFFLINE) {
    if (!(await exists(file))) throw new Error(`${c.ticker}: data/sec 에 받아둔 자료가 없습니다(--offline).`);
    return JSON.parse(await readFile(file, "utf8"));
  }
  const body = await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(c.cik).padStart(10, "0")}.json`);
  await writeFile(file, JSON.stringify(body), "utf8");
  await sleep(400);
  return body;
}

const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// 현금흐름표 숫자는 회계연도 시작부터의 누계로 보고된다. 같은 시작일을 가진 누계끼리 빼서 분기 값으로 만든다.
export function toQuarters(entries) {
  const best = new Map();   // "시작|끝" -> 가장 나중에 제출된 값
  for (const e of entries) {
    if (!e.start || !e.end || typeof e.val !== "number") continue;
    const k = `${e.start}|${e.end}`, prev = best.get(k);
    if (!prev || (e.filed ?? "") > (prev.filed ?? "")) best.set(k, e);
  }
  const byStart = new Map();
  for (const e of best.values()) { if (!byStart.has(e.start)) byStart.set(e.start, []); byStart.get(e.start).push(e); }
  const out = new Map();    // 분기 끝 날짜 -> 분기 값
  for (const list of byStart.values()) {
    list.sort((a, b) => a.end.localeCompare(b.end));
    let prev = null;
    for (const e of list) {
      const span = days(prev ? prev.end : e.start, e.end);
      if (span >= 75 && span <= 105) out.set(e.end, prev ? e.val - prev.val : e.val);
      prev = e;
    }
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([end, val]) => ({ end, val }));
}

function pickTag(gaap, names) {
  let pick = null;
  for (const name of names) {
    const units = gaap[name]?.units?.USD;
    if (!units) continue;
    const q = toQuarters(units);
    if (!q.length) continue;
    const last = q[q.length - 1].end;
    if (!pick || last > pick.last || (last === pick.last && q.length > pick.q.length)) pick = { name, q, last };
  }
  return pick;
}

// 후보 목록에 없는 항목을 놓치지 않도록, 이름으로 관련 항목을 훑어 본다.
function discover(gaap, re) {
  const rows = [];
  for (const [name, c] of Object.entries(gaap)) {
    if (!re.test(name)) continue;
    const u = c.units?.USD;
    if (!u || !u.length) continue;
    const ends = u.map((e) => e.end).filter(Boolean).sort();
    rows.push({ name, count: u.length, last: ends[ends.length - 1] });
  }
  return rows.sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "") || b.count - a.count).slice(0, 12);
}

const bn = (v) => (v === null || v === undefined ? "—" : (v / 1e9).toFixed(1));
const calQ = (end) => { const d = new Date(end); d.setUTCDate(d.getUTCDate() - 20); return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };

async function main() {
  if (!OFFLINE && !UA) {
    console.error("환경변수 SEC_USER_AGENT 가 없습니다. SEC는 요청자가 누구인지 밝히도록 요구합니다.");
    console.error('PowerShell 예:  $env:SEC_USER_AGENT = "BIG CYCLE study 이름 이메일주소"');
    process.exit(1);
  }
  await mkdir(SEC_DIR, { recursive: true });
  await mkdir(dirname(OUT), { recursive: true });

  let tickers = null;
  if (!OFFLINE) { try { tickers = Object.values(await secGet("https://www.sec.gov/files/company_tickers.json")); await sleep(400); } catch (e) { console.log(`종목 목록을 받지 못함(${e.message}). 내장된 번호로 진행합니다.`); } }

  const md = ["# SEC 공시 자료 확인 (5-1단계)", "", `실행 시각: ${new Date().toISOString()}`, "", "금액 단위는 10억 달러. 분기 값은 누계에서 빼서 만든 것입니다.", ""];
  const summary = [], total = new Map();
  for (const c of COMPANIES) {
    try {
      if (tickers) { const t = tickers.find((x) => x.ticker === c.ticker); if (t && t.cik_str !== c.cik) { md.push(`주의: ${c.ticker} 의 번호가 SEC 목록(${t.cik_str})과 내장값(${c.cik})이 다릅니다. SEC 목록 값을 씁니다.`, ""); c.cik = t.cik_str; } }
      const facts = await loadFacts(c);
      const gaap = facts.facts?.["us-gaap"] ?? {};
      const capex = pickTag(gaap, TAGS.capex), ocf = pickTag(gaap, TAGS.ocf), debt = pickTag(gaap, TAGS.debt);
      md.push(`## ${c.name} (${c.ticker})`, "", `- SEC에 등록된 이름: ${facts.entityName ?? "?"}`,
        `- 설비투자 항목: ${capex ? `\`${capex.name}\` · 분기 ${capex.q.length}개 · ${capex.q[0].end} ~ ${capex.last}` : "찾지 못함"}`,
        `- 영업현금흐름 항목: ${ocf ? `\`${ocf.name}\` · 분기 ${ocf.q.length}개 · ${ocf.q[0].end} ~ ${ocf.last}` : "찾지 못함"}`,
        `- 차입 조달 항목: ${debt ? `\`${debt.name}\` · 분기 ${debt.q.length}개 · ${debt.q[0].end} ~ ${debt.last}` : "찾지 못함"}`, "");
      const mC = new Map((capex?.q ?? []).map((x) => [x.end, x.val])), mO = new Map((ocf?.q ?? []).map((x) => [x.end, x.val])), mD = new Map((debt?.q ?? []).map((x) => [x.end, x.val]));
      const ends = [...new Set([...mC.keys(), ...mO.keys()])].sort().slice(-10);
      md.push("| 분기 끝 | 설비투자 | 영업현금흐름 | 설비투자/영업현금흐름 | 차입 조달 |", "| --- | --- | --- | --- | --- |");
      for (const e of ends) {
        const cx = mC.get(e) ?? null, of = mO.get(e) ?? null, db = mD.get(e) ?? null;
        md.push(`| ${e} | ${bn(cx)} | ${bn(of)} | ${cx !== null && of ? Math.round((cx / of) * 100) + "%" : "—"} | ${bn(db)} |`);
      }
      md.push("", "관련 항목 훑어보기(설비투자):", "", ...discover(gaap, /PaymentsToAcquire.*(Property|Productive|Equipment)|CapitalExpenditure/).map((r) => `- \`${r.name}\` · ${r.count}건 · 마지막 ${r.last}`),
        "", "관련 항목 훑어보기(차입):", "", ...discover(gaap, /^Proceeds.*(Debt|Notes|Borrow)/).map((r) => `- \`${r.name}\` · ${r.count}건 · 마지막 ${r.last}`), "");
      for (const [e, v] of mC) { const k = calQ(e); if (!total.has(k)) total.set(k, { capex: 0, ocf: 0, n: 0 }); const t = total.get(k); t.capex += v; t.n++; if (mO.has(e)) t.ocf += mO.get(e); }
      summary.push(`${c.ticker}: 설비투자 ${capex ? capex.q.length + "분기(" + capex.q[0].end.slice(0, 4) + "~" + capex.last + ")" : "없음"}, 영업현금흐름 ${ocf ? ocf.q.length + "분기" : "없음"}, 차입 ${debt ? debt.q.length + "분기" : "없음"}`);
    } catch (e) {
      md.push(`## ${c.name} (${c.ticker})`, "", `실패: ${e.message}`, "");
      summary.push(`${c.ticker}: 실패 (${e.message})`);
    }
  }
  md.push("## 5개사 합계(달력 분기 기준)", "", "회사마다 회계 분기가 달라, 분기 끝 날짜가 속한 달력 분기로 묶었습니다. 5개사가 모두 있는 분기만 믿을 수 있습니다.", "",
    "| 달력 분기 | 회사 수 | 설비투자 합계 | 영업현금흐름 합계 | 비율 |", "| --- | --- | --- | --- | --- |");
  for (const [k, t] of [...total.entries()].sort().slice(-12)) md.push(`| ${k} | ${t.n} | ${bn(t.capex)} | ${bn(t.ocf)} | ${t.ocf ? Math.round((t.capex / t.ocf) * 100) + "%" : "—"} |`);
  md.push("");
  await writeFile(OUT, md.join("\n"), "utf8");
  console.log(summary.join("\n"));
  console.log(`\n보고서: reports/sec-check.md`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
