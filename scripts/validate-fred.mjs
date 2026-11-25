// BIG CYCLE 2-1단계: FRED 시리즈 검증 스크립트
// 실행: node scripts/validate-fred.mjs
// 필요: Node 18 이상, 환경변수 FRED_API_KEY
// 하는 일: config/indicators.json의 모든 FRED 시리즈가 실제로 존재하는지,
//          언제부터 언제까지 데이터가 있는지, 단위와 주기가 무엇인지 확인해
//          reports/ 폴더에 보고서(.md, .csv)를 만든다. 데이터 자체는 받지 않는다.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "indicators.json");
const OUT_DIR = join(ROOT, "reports");
const API = "https://api.stlouisfed.org/fred/series";

const args = process.argv.slice(2);
const mockIdx = args.indexOf("--mock");
const MOCK_FILE = mockIdx >= 0 ? args[mockIdx + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collectSeries(config) {
  // 시리즈 ID별로 한 번만 조회하도록 모은다
  const map = new Map();
  const add = (owner, s) => {
    if (!map.has(s.id)) map.set(s.id, { id: s.id, expected_start: s.expected_start ?? null, used_by: [] });
    const entry = map.get(s.id);
    if (!entry.used_by.includes(owner)) entry.used_by.push(owner);
    if (entry.expected_start == null && s.expected_start != null) entry.expected_start = s.expected_start;
  };
  for (const ind of config.indicators ?? []) for (const s of ind.series ?? []) add(ind.name, s);
  for (const ref of config.reference_series ?? []) for (const s of ref.series ?? []) add(ref.name, s);
  return [...map.values()];
}

async function fetchMeta(id, apiKey, mock) {
  if (mock) {
    const hit = mock[id];
    if (!hit) return { ok: false, error: "모의 데이터에 없음" };
    return { ok: true, meta: hit };
  }
  const url = `${API}?series_id=${encodeURIComponent(id)}&api_key=${apiKey}&file_type=json`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(5000 * attempt); continue; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error_message ?? `HTTP ${res.status}` };
      const meta = body.seriess?.[0];
      if (!meta) return { ok: false, error: "응답에 시리즈 정보 없음" };
      return { ok: true, meta };
    } catch (e) {
      if (attempt === 3) return { ok: false, error: `접속 실패: ${e.message}` };
      await sleep(2000 * attempt);
    }
  }
  return { ok: false, error: "요청 한도 초과로 중단" };
}

function staleLimitDays(freq) {
  // 주기별로 "이 이상 갱신이 없으면 의심"하는 기준 일수
  const f = (freq ?? "").toUpperCase();
  if (f.startsWith("D") || f.startsWith("W")) return 30;
  if (f.startsWith("M")) return 120;
  if (f.startsWith("Q")) return 220;
  return 500;
}

function judge(entry, meta, today) {
  const flags = [];
  const startYear = Number(meta.observation_start?.slice(0, 4));
  const end = new Date(meta.observation_end);
  const ageDays = Math.round((today - end) / 86400000);

  if (/DISCONTINUED/i.test(meta.title ?? "")) flags.push("중단됨");
  if (ageDays > staleLimitDays(meta.frequency_short)) flags.push(`갱신 지연(${ageDays}일 전이 마지막)`);
  if (entry.expected_start != null && startYear > entry.expected_start + 1) {
    flags.push(`시작 연도 불일치(예상 ${entry.expected_start}, 실제 ${startYear})`);
  }
  if (startYear > 1977) flags.push("50년 검증 불가");
  const spanYears = (end - new Date(meta.observation_start)) / (365.25 * 86400000);
  if (spanYears < 12) flags.push(`제공 기간 짧음(${spanYears.toFixed(1)}년)`);
  return { startYear, ageDays, flags };
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  const list = collectSeries(config);
  const mock = MOCK_FILE ? JSON.parse(await readFile(MOCK_FILE, "utf8")) : null;
  const apiKey = process.env.FRED_API_KEY;

  if (!mock && !apiKey) {
    console.error("FRED_API_KEY 환경변수가 없습니다. 작업 지시서의 2번 항목을 먼저 진행하세요.");
    process.exit(1);
  }

  const today = new Date();
  const rows = [];
  console.log(`시리즈 ${list.length}개를 확인합니다.`);

  for (const entry of list) {
    const r = await fetchMeta(entry.id, apiKey, mock);
    if (!r.ok) {
      rows.push({ id: entry.id, status: "실패", title: "", start: "", end: "", freq: "", units: "", updated: "", flags: [r.error], used_by: entry.used_by });
      console.log(`  실패  ${entry.id}: ${r.error}`);
    } else {
      const j = judge(entry, r.meta, today);
      rows.push({
        id: entry.id,
        status: j.flags.some((f) => f.startsWith("중단") || f.startsWith("갱신 지연") || f.startsWith("시작 연도")) ? "확인 필요" : "정상",
        title: r.meta.title, start: r.meta.observation_start, end: r.meta.observation_end,
        freq: r.meta.frequency_short, units: r.meta.units_short ?? r.meta.units,
        updated: r.meta.last_updated, flags: j.flags, used_by: entry.used_by,
      });
      console.log(`  ${j.flags.length ? "주의" : "정상"}  ${entry.id}: ${r.meta.observation_start} ~ ${r.meta.observation_end}${j.flags.length ? "  [" + j.flags.join("; ") + "]" : ""}`);
    }
    if (!mock) await sleep(600); // FRED 요청 한도(분당 120회) 여유
  }

  await mkdir(OUT_DIR, { recursive: true });
  const stamp = today.toISOString().slice(0, 10);

  const header = ["시리즈", "상태", "제목", "시작일", "종료일", "주기", "단위", "최종 갱신", "주의 사항", "사용 지표"];
  const csv = [header.join(",")].concat(rows.map((r) =>
    [r.id, r.status, r.title, r.start, r.end, r.freq, r.units, r.updated, r.flags.join("; "), r.used_by.join("; ")].map(csvCell).join(","))).join("\n");
  // 엑셀에서 한글이 깨지지 않도록 BOM을 붙인다
  await writeFile(join(OUT_DIR, `series-report-${stamp}.csv`), "﻿" + csv, "utf8");

  const count = (s) => rows.filter((r) => r.status === s).length;
  const md = [
    `# FRED 시리즈 검증 보고서 (${stamp})`,
    "",
    `- 확인한 시리즈: ${rows.length}개`,
    `- 정상: ${count("정상")}개 / 확인 필요: ${count("확인 필요")}개 / 실패: ${count("실패")}개`,
    `- 설정 파일 버전: ${config.version}`,
    "",
    "## 조치가 필요한 항목",
    "",
    ...(rows.filter((r) => r.status !== "정상").length
      ? rows.filter((r) => r.status !== "정상").map((r) => `- ${r.id} (${r.used_by.join(", ")}): ${r.flags.join("; ")}`)
      : ["- 없음"]),
    "",
    "## 전체 목록",
    "",
    "| 시리즈 | 상태 | 시작일 | 종료일 | 주기 | 단위 | 주의 사항 | 사용 지표 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.status} | ${r.start} | ${r.end} | ${r.freq} | ${r.units} | ${r.flags.join("; ") || "-"} | ${r.used_by.join(", ")} |`),
    "",
  ].join("\n");
  await writeFile(join(OUT_DIR, `series-report-${stamp}.md`), md, "utf8");

  console.log(`\n완료. reports/series-report-${stamp}.md 와 .csv 를 확인하세요.`);
  console.log(`정상 ${count("정상")} / 확인 필요 ${count("확인 필요")} / 실패 ${count("실패")}`);
}

main().catch((e) => { console.error("예상하지 못한 오류:", e); process.exit(1); });
