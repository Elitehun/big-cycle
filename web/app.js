// BIG CYCLE 상황판 화면
(function () {
  "use strict";
  var D = window.BC_DATA, E = window.BCEngine;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  if (!D || !E) {
    var box = $("error");
    box.hidden = false;
    box.textContent = "데이터 파일(web/data.js)이 없습니다. 먼저 node scripts/build-web-data.mjs 를 실행하세요.";
    return;
  }

  var AMBER = "#F5B841", N = D.months, BT0 = D.backtestStartIndex, LAST = N - 1;
  var startY = Number(D.start.slice(0, 4)), startM = Number(D.start.slice(5, 7)) - 1;
  var monthStr = function (i) { var t = startY * 12 + startM + i; return Math.floor(t / 12) + "-" + String((t % 12) + 1).padStart(2, "0"); };
  var fmt = function (v, d) { return v === null || v === undefined ? "—" : Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d }); };
  var pct = function (v, d) { return v === null || v === undefined ? "—" : (v * 100).toFixed(d === undefined ? 1 : d) + "%"; };
  var lastVal = function (arr) { for (var i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return { v: arr[i], i: i }; return { v: null, i: -1 }; };

  var HAS_SECTOR = !!D.sector, HAS_AI = !!(D.ai && D.ai.total && D.ai.companies);
  var AI_CAT = "AI 투자 사이클";
  var CATS = [
    { id: "경제지표", note: "선행 · 동행 · 후행 · 물가", groups: ["선행", "동행", "후행", "물가"] },
    { id: "유동성 지표", note: "묶음을 따로 봅니다. 평균 내지 않습니다", groups: ["연준·단기자금", "국채", "기업 채권", "은행"].concat(D.fiscal ? ["정부"] : []) },
    { id: "주도 섹터 (AI)", note: "경고등 전용 · 5년 CDS, 단위 bp", groups: ["자금조달"] },
    { id: AI_CAT, note: "5개사 공시 자료 · 분기마다 갱신 · 과거 검증이 안 되는 참고 지표", groups: ["번 돈 대비 투자", "총차입금", "리스 부채"] },
    { id: "가격·심리", note: "지금 역사적으로 어느 수준인가", groups: ["가격 수준", "심리"] }
  ].filter(function (c) { return (HAS_SECTOR || c.id !== "주도 섹터 (AI)") && (HAS_AI || c.id !== AI_CAT); });
  var GROUP_LABEL = { "정부": "정부 (참고)", "후행": "후행 (확인용)", "물가": "물가 압력", "자금조달": "AI CDS 프리미엄", "번 돈 대비 투자": "번 돈 대비 투자 (%)", "총차입금": "총차입금 (억 달러)", "리스 부채": "리스 부채 (억 달러)" };
  var byId = {};
  D.indicators.forEach(function (x) { byId[x.id] = x; });
  var selectable = function (x) { return !!x.score; };
  var standardLead = D.indicators.filter(function (x) { return x.group === "선행" && x.standard && x.score; }).map(function (x) { return x.id; });

  // ---------- 상태(브라우저에 가볍게 기억) ----------
  var state = { chart: "nasdaq", open: { "경제지표": true, "경제지표/선행": true, "유동성 지표": true, "주도 섹터 (AI)": true, "주도 섹터 (AI)/자금조달": true, "가격·심리": true, "가격·심리/가격 수준": true, "가격·심리/심리": true }, checked: {}, hidden: {}, boardOpen: {}, boardAll: false };
  state.open[AI_CAT] = true; state.open[AI_CAT + "/번 돈 대비 투자"] = true;
  standardLead.forEach(function (id) { state.checked[id] = true; });
  try {
    var saved = JSON.parse(localStorage.getItem("bigcycle-state") || "null");
    if (saved && saved.checked && saved.open) {
      state.open = saved.open; state.checked = {};
      Object.keys(saved.checked).forEach(function (id) { if (saved.checked[id] && byId[id] && selectable(byId[id])) state.checked[id] = true; });
      if (saved.hidden) Object.keys(saved.hidden).forEach(function (id) { if (saved.hidden[id] && state.checked[id]) state.hidden[id] = true; });
      if (saved.chart === "sp500" && D.prices.sp500) state.chart = "sp500";
      if (saved.panelOpen === false) state.panelOpen = false;
      if (!(AI_CAT in state.open)) { state.open[AI_CAT] = true; state.open[AI_CAT + "/번 돈 대비 투자"] = true; }
      if (saved.boardAll) state.boardAll = true;
      if ([24, 48, 120].indexOf(saved.quadRange) >= 0) state.quadRange = saved.quadRange;
      if (saved.boardOpen && typeof saved.boardOpen === "object") state.boardOpen = saved.boardOpen;
    }
  } catch (e) { /* 저장소를 못 쓰는 환경이면 기억하지 않는다 */ }
  var save = function () { try { localStorage.setItem("bigcycle-state", JSON.stringify(state)); } catch (e) { /* 무시 */ } };
  // 고른 지표(칩에 보이는 것)와, 그중 눈이 켜져 있어 계산에 들어가는 지표
  var pickedInds = function () { return D.indicators.filter(function (x) { return state.checked[x.id] && selectable(x); }); };
  var selectedInds = function () { return pickedInds().filter(function (x) { return !state.hidden[x.id]; }); };

  // ---------- 요약 4칸 ----------
  // 경보 칸 아래 한 줄: 정부가 돈을 얼마나 풀고 있는가
  function fiscalLine() {
    var F = D.fiscal; if (!F || !F.now) return "";
    var big = F.now.value > F.cut, r = F.record;
    return '<p class="rec">정부 재정적자 GDP의 <strong' + (big ? "" : ' class="accent"') + ' style="font-family:var(--mono)">' + fmt(F.now.value, 1) + "%</strong>" + (F.now.yearAgo === null ? "" : " (1년 전 " + fmt(F.now.yearAgo, 1) + "%)") +
      ". 과거 경보 " + r.n + "번 중 " + r.ok + "번은 " + fmt(F.cut, 1) + "%를 넘으면 이후 1년 주가가 올랐고 밑돌면 빠졌음. 우연일 수 있음.</p>";
  }
  function renderTiles() {
    var a = D.alert, r = a.record, html = "";
    html += '<div class="tile"><h2>경기침체 경보</h2><p class="big"' + (a.on ? ' style="color:' + AMBER + '"' : "") + ">" + (a.on === null ? "자료 없음" : a.on ? "켜짐" : "꺼짐") + "</p>" +
      '<p class="sub">선행 종합 점수 <span class="mono">' + fmt(a.score, 1) + "</span> · " + D.rules.threshold + " 미만이 " + D.rules.minMonths + "개월 이어지면 켜집니다</p>" +
      '<p class="rec">과거 성적: 침체 ' + r.eligible + "번 중 <strong class=\"accent\">" + r.hits + "번</strong>을 평균 " + fmt(r.avgLead, 0) + "개월 앞서 경고. 헛경보는 " + r.counted + "번 중 " + r.falseSignals + "번. 주가 신호는 아닙니다.</p>" + fiscalLine() + "</div>";

    var cape = byId.cape, mcap = byId.mcap_gdp;
    var lead = cape || mcap;
    if (lead) {
      var p = lead.pctFull, hot = p !== null && p >= 90;
      var where = p === null ? "자료 부족" : p >= 50 ? "역사상 상위 " + Math.max(1, Math.round(100 - p)) + "%" : "역사상 하위 " + Math.max(1, Math.round(p)) + "%";
      html += '<div class="tile"><h2>가격 수준</h2><p class="big"' + (hot ? ' style="color:' + AMBER + '"' : "") + ">" + where + "</p>" +
        '<p class="sub">' + (cape ? '실러 PER <span class="mono">' + fmt(cape.latest.value, 2) + "배</span>" + (cape.latest.est ? "(추정)" : "") : "") + (cape && mcap ? " · " : "") + (mcap ? '시가총액/GDP <span class="mono">' + fmt(mcap.latest.value, 2) + "배</span>" : "") + "</p>" +
        '<p class="rec">과거 성적: 비쌌던 달과 쌌던 달의 이후 1년 수익률 차이는 1%p 미만(검증 기록).</p></div>';
    } else html += '<div class="tile"><h2>가격 수준</h2><p class="big">자료 없음</p><p class="sub">실러 자료와 시가총액 자료가 없습니다</p><p class="rec">data/manual/shiller.csv 를 준비하면 표시됩니다.</p></div>';

    var f = D.nfci;
    if (f) {
      html += '<div class="tile"><h2>유동성 (금융여건지수)</h2><p class="big">' + (f.easing === null ? "방향 자료 부족" : f.easing ? "완화 쪽으로 이동 중" : "긴축 쪽으로 이동 중") + "</p>" +
        '<p class="sub">지수 값 <span class="mono">' + fmt(f.value, 2) + "</span> (" + esc(f.month) + ") · 0보다 크면 평균보다 긴축 · 방향은 6개월 전과 비교</p>" +
        '<p class="rec">과거 성적: 침체 ' + f.record.eligible + "번 중 " + f.record.hits + "번 경고(0 초과 기준, 켜져 있던 기간 " + fmt(f.record.onShare, 0) + "%). 방향으로 이후 주가를 가르지는 못함.</p></div>";
    } else html += '<div class="tile"><h2>유동성 (금융여건지수)</h2><p class="big">자료 없음</p><p class="sub">NFCI 자료를 받지 못했습니다</p><p class="rec"></p></div>';

    var s = D.sector || {}, sHot = s.status === "주의" || s.status === "경고";
    if (HAS_SECTOR) html += '<div class="tile"><h2>AI CDS 프리미엄</h2><p class="big"' + (sHot ? ' style="color:' + AMBER + '"' : "") + ">" + esc(s.status) + "</p>" +
      '<p class="sub">하이퍼스케일러 5개사 CDS 평균 <span class="mono">' + fmt(s.avg, 1) + 'bp</span> · 최고와 최저 차이 <span class="mono">' + fmt(s.spread, 1) + "bp</span> (" + esc(s.date) + ")</p>" +
      '<p class="rec">' + esc(s.statusNote) + " 과거 검증이 안 되는 지표입니다.</p></div>";
    if (HAS_AI) {
      var t = D.ai.total, over = t.ratio !== null && t.ratio >= 100;
      var mult = t.debtNow !== null && t.debtYearAgo ? t.debtNow / t.debtYearAgo : null;
      html += '<div class="tile"><h2>AI 투자 사이클</h2><p class="big"' + (over ? ' style="color:' + AMBER + '"' : "") + ">번 돈의 " + (t.ratio === null ? "—" : t.ratio) + "%를 투자</p>" +
        '<p class="sub">5개사 설비투자 최근 4분기 <span class="mono">' + eok(t.ttmCapex) + "</span>억 달러 · 1년 전보다 <span class=\"mono\">" + (t.capexGrowth === null ? "—" : (t.capexGrowth >= 0 ? "+" : "") + t.capexGrowth + "%") + "</span> · " + esc(qLabel(t.quarter)) + "까지</p>" +
        '<p class="rec">총차입금(' + esc(t.debtCompanies.length) + "개사, 오라클 제외) " + eok(t.debtNow) + "억 달러" + (mult !== null ? "로 1년 전의 " + fmt(mult, 1) + "배" : "") + ". 과거 검증이 안 되는 참고 지표입니다.</p></div>";
    }
    $("tiles").className = "tiles" + (HAS_SECTOR || HAS_AI ? "" : " n3");
    $("tiles").innerHTML = html;
    $("src-line").textContent = "출처: 미국 연준 계열 통계(FRED), 로버트 실러 교수 공개 자료(실러 PER, S&P500 장기 가격" + (D.capeEst ? ". 실러 PER의 최근 값은 S&P500 변화로 추정" : "") + ")" + (HAS_AI ? ", 미국 증권거래위원회(SEC) 공시 자료(AI 투자 사이클)" : "") + (HAS_SECTOR ? ", CDS는 수동 입력." : ".");
  }

  // ---------- 지표 목록 ----------
  var chev = function (rot) { return '<svg class="chev" aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#A9AFBA" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(' + rot + ')"><path d="M3 5l4 4 4-4"></path></svg>'; };
  // 자료의 실제 달을 사람이 읽는 말로 바꾼다
  function whenLabel(l) {
    if (!l || !l.month) return "";
    var y = l.month.slice(0, 4), m = Number(l.month.slice(5, 7));
    if (l.partial) return y + "년 " + m + "월 진행 중";
    if (l.freq === "Q") return y + "년 " + Math.ceil(m / 3) + "분기치";
    return y + "년 " + m + "월치";
  }
  function isNew(x) {
    if (!x.latest || !x.latest.newOn) return false;
    var age = (Date.now() - Date.parse(x.latest.newOn)) / 86400000;
    return age >= -1 && age <= (D.rules.newDays || 7);
  }
  // 일정 한 줄: 이름(누르면 목록으로 이동) + 펼침 버튼. 펼치면 예측·직전·실제 수치가 이름 아래에 나온다.
  // "발표됨"이 이 브라우저에서 처음 보이는 항목이면 잠깐 은은하게 빛나게 한다(화면을 연 뒤 10초 동안만, 다시 그려도 반복하지 않도록)
  var SEEN_KEY = "bigcycle-seen-done", seenDone = {}, freshUntil = Date.now() + 10000, freshNow = {};
  try { seenDone = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch (e) { seenDone = {}; }
  function isFresh(id, dateKey) {
    var k = id + "|" + dateKey;
    if (!seenDone[k]) { seenDone[k] = 1; freshNow[k] = 1;
      try { var keep = {}, ks = Object.keys(seenDone); ks.slice(Math.max(0, ks.length - 200)).forEach(function (q) { keep[q] = 1; }); localStorage.setItem(SEEN_KEY, JSON.stringify(keep)); } catch (e) { /* 무시 */ } }
    return !!freshNow[k] && Date.now() < freshUntil;
  }
  function boardItem(x, dateKey) {
    var k = dateKey + "/" + x.id, open = state.boardAll ? state.boardOpen[k] !== false : !!state.boardOpen[k];
    var l = x.latest || {}, out = isNew(x);
    var num = function (v) { return v === null || v === undefined ? "—" : fmt(v, 2) + esc(l.unit || ""); };
    var html = '<div class="bitem"><div class="brow"><button type="button" class="bname" data-go="' + esc(x.id) + '">' + esc(x.name) + (out ? '<span class="bdone' + (isFresh(x.id, dateKey) ? " fresh" : "") + '">발표됨</span>' : "") + "</button>" +
      '<button type="button" class="btog" data-tog="' + esc(k) + '" aria-expanded="' + open + '" aria-label="' + esc(x.name) + " 수치 " + (open ? "접기" : "펼치기") + '"><svg class="chev' + (open ? "" : " shut") + '" aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5l4 4 4-4"></path></svg></button></div>';
    if (open) {
      var short = function (o) { return whenLabel(o).replace(/^\d{4}년 /, ""); };
      var prevV = out ? l.prevValue : l.value, prevW = out ? (l.prevMonth ? short({ month: l.prevMonth, freq: l.freq }) : "") : short(l);
      html += '<dl class="bnum"><dt class="bkind">' + esc(x.transform || "값") + "</dt><dd></dd>" +
        "<dt>직전</dt><dd>" + num(prevV) + (prevW ? ' <span class="bwhen">' + esc(prevW) + "</span>" : "") + "</dd>" +
        '<dt class="bact">실제</dt><dd class="bact">' + (out ? num(l.value) + ' <span class="bwhen">' + esc(short(l)) + "</span>" : '<span class="bwait">발표 전</span>') + "</dd></dl>";
    }
    return html + "</div>";
  }
  // 이번 주 발표 일정. 주는 화면을 여는 날짜를 기준으로 월요일부터 잡는다.
  function renderBoard() {
    var box = $("board"), sc = D.schedule, pad = function (n) { return String(n).padStart(2, "0"); };
    var iso = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    var now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var mon = new Date(today); mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    var allOpen = !!state.boardAll;
    var head = '<div class="board-head"><h2>이번 주 발표 일정</h2><button type="button" class="ball" data-all="1" aria-pressed="' + allOpen + '">' + (allOpen ? "수치 모두 접기" : "수치 모두 펼치기") + '</button><p class="muted">' + (sc && sc.fetched ? "미국 현지 날짜 기준 · 일정 확인 " + esc(sc.fetched.slice(0, 10)) : "") + "</p></div>";
    if (!sc || !sc.items) { box.innerHTML = head + '<p class="board-msg">발표 일정을 아직 받지 못했습니다. FRED 키를 넣고 자료를 만들면 표시됩니다.</p>'; return; }
    var byDate = {};
    sc.items.forEach(function (it) { var a = byDate[it.date] || (byDate[it.date] = []); it.ids.forEach(function (id) { if (byId[id] && a.indexOf(id) < 0) a.push(id); }); });
    var names = ["월", "화", "수", "목", "금", "토", "일"], cols = "", total = 0, tIso = iso(today);
    for (var i = 0; i < 7; i++) {
      var d = new Date(mon); d.setDate(mon.getDate() + i);
      var key = iso(d), ids = byDate[key] || [];
      if (i > 4 && !ids.length) continue;
      total += ids.length;
      var cls = key === tIso ? " today" : key < tIso ? " past" : "";
      cols += '<div class="bday' + cls + (ids.length ? "" : " empty") + '"><h3>' + names[i] + " " + (d.getMonth() + 1) + "/" + d.getDate() + (key === tIso ? " · 오늘" : "") + "</h3>" +
        (ids.length ? ids.map(function (id) { return boardItem(byId[id], key); }).join("") : '<p class="muted">—</p>') + "</div>";
    }
    var stale = sc.to && tIso > sc.to;
    box.innerHTML = head + (stale ? '<p class="board-msg">받아둔 일정이 오래됐습니다. 자료를 갱신하면 이번 주 일정이 표시됩니다.</p>'
      : '<div class="board-days">' + cols + "</div>" + (total ? "" : '<p class="board-msg">이번 주에 예정된 발표가 없습니다.</p>'));
  }
  function renderNews() {
    var box = $("news"), list = D.indicators.filter(isNew);
    if (!list.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = '<span>최근 ' + (D.rules.newDays || 7) + '일 새 발표 <span class="mono" style="color:var(--text)">' + list.length + "</span>개</span>" +
      list.map(function (x) { return '<button type="button" data-go="' + esc(x.id) + '">' + esc(x.name) + " · " + esc(whenLabel(x.latest)) + "</button>"; }).join("");
  }
  function itemRow(x) {
    var cur = x.score ? lastVal(x.score) : { v: null }, isInfl = x.group === "물가", isPrice = x.role === "level";
    var shown, hot = false, meta = [];
    if (isPrice) {
      shown = fmt(x.latest.value, 2) + (x.latest.unit || "");
      var top = function (p) { return p === null || p === undefined ? "자료 부족" : p >= 50 ? "상위 " + Math.max(1, Math.round(100 - p)) + "%" : "하위 " + Math.max(1, Math.round(p)) + "%"; };
      meta.push(esc(whenLabel(x.latest)) + " · 전체 역사 " + top(x.pctFull) + " · 최근 20년 " + top(x.pct20));
      if (x.est) meta.push("추정값: 실러 자료의 마지막 값(" + esc(whenLabel({ month: x.est.baseMonth, freq: "M" }).replace(/치$/, "")) + ", " + fmt(x.est.baseValue, 2) + "배)에 그 뒤 S&P500 변화를 반영");
      hot = x.pctFull !== null && x.pctFull >= 90;
    } else if (x.score) {
      var v = cur.v === null ? null : isInfl ? 100 - cur.v : cur.v;
      shown = fmt(v, 1);
      hot = v !== null && (isInfl ? v >= 70 : v <= 30);
      if (x.latest) meta.push(esc(x.transform) + " " + fmt(x.latest.value, 2) + " · " + esc(whenLabel(x.latest)));
    } else {
      shown = x.latest ? fmt(x.latest.value, 2) : "—";
      meta.push((x.latest ? esc(whenLabel(x.latest)) + " · " : "") + esc(x.note || "참고 표시 전용"));
    }
    var links = (x.series || []).map(function (id) { return '<a href="https://fred.stlouisfed.org/series/' + encodeURIComponent(id) + '" target="_blank" rel="noopener">' + esc(id) + "</a>"; });
    if (links.length) meta.push("FRED: " + links.join(", ")); else if (x.source) meta.push(esc(x.source));
    var n = x.stars || 0, dots = n ? "●●●".slice(0, n) + "○○○".slice(0, 3 - n) : "";
    var d = x.score && !isPrice && x.delta !== null && x.delta !== undefined ? (isInfl ? -x.delta : x.delta) : null;
    var deltaHtml = d === null ? "" : '<span class="it-delta" title="직전 발표 대비 점수 변화">' + (d > 0.04 ? "▲ " : d < -0.04 ? "▼ " : "– ") + fmt(Math.abs(d), 1) + "</span>";
    var text = '<span style="min-width:0"><span class="it-name">' + esc(x.name) + (isNew(x) ? ' <span class="badge-new">새 발표</span>' : "") + '</span><span class="it-meta">' + meta.join(" · ") + "</span></span>";
    var left = selectable(x)
      ? '<label><input type="checkbox" data-ind="' + esc(x.id) + '"' + (state.checked[x.id] ? " checked" : "") + ">" + text + "</label>"
      : '<span class="nolabel">' + text + "</span>";
    return '<li data-row="' + esc(x.id) + '">' + left + (dots ? '<span class="dots" role="img" aria-label="침체 판정력 3단계 중 ' + n + '">' + dots + "</span>" : "") +
      '<span class="it-val"' + (hot ? ' style="color:' + AMBER + '"' : "") + ">" + shown + deltaHtml + "</span></li>";
  }
  // AI 투자 사이클: 금액은 10억 달러 단위로 들어 있어 억 달러로 바꿔 보여준다
  function eok(v) { return v === null || v === undefined ? "—" : fmt(v * 10, 0); }
  function qLabel(q) { return q ? q.slice(0, 4) + "년 " + q.slice(5) + "분기" : ""; }
  function aiLine(name, meta, val, hot) {
    return '<li><span class="nolabel" style="padding-left:0"><span><span class="it-name">' + esc(name) + '</span><span class="it-meta">' + meta + "</span></span></span>" +
      '<span class="it-val"' + (hot ? ' style="color:' + AMBER + '"' : "") + ">" + val + "</span></li>";
  }
  function aiChange(now, ago) { return now === null || !ago ? "" : " · 1년 전 " + eok(ago) + "억 달러(" + (now >= ago ? "+" : "") + Math.round((now / ago - 1) * 100) + "%)"; }
  function aiRows(g) {
    var t = D.ai.total, cs = D.ai.companies, out = "";
    if (g === "번 돈 대비 투자") {
      var row = function (name, o, q) {
        return aiLine(name, "최근 4분기 설비투자 " + eok(o.ttmCapex) + "억 · 번 돈 " + eok(o.ttmOcf) + "억 달러 · " + esc(qLabel(q)) + "까지" + (o.ratioYearAgo !== null ? " · 1년 전 " + o.ratioYearAgo + "%" : ""),
          o.ratio === null ? "—" : o.ratio + "%", o.ratio !== null && o.ratio >= 100);
      };
      out += row("5개사 합계", t, t.quarter);
      cs.forEach(function (c) { out += row(c.name, c, c.quarter); });
    } else if (g === "총차입금") {
      out += aiLine(t.debtCompanies.length + "개사 합계 (오라클 제외)", esc(qLabel(t.debtQuarter)) + " 말" + aiChange(t.debtNow, t.debtYearAgo), eok(t.debtNow), false);
      cs.forEach(function (c) { out += aiLine(c.name, esc(qLabel(c.debtQuarter)) + " 말" + (c.debtYearly ? " · 연 1회 자료" : "") + aiChange(c.debtNow, c.debtYearAgo), eok(c.debtNow), false); });
    } else {
      cs.forEach(function (c) { out += aiLine(c.name, c.leaseNow === null ? "자료 없음" : esc(qLabel(c.leaseQuarter)) + " 말" + (c.leaseYearly ? " · 연 1회 자료" : "") + aiChange(c.leaseNow, c.leaseYearAgo), eok(c.leaseNow), false); });
    }
    return out;
  }
  function sectorRows() {
    var s = D.sector;
    return s.items.map(function (it) {
      var hot = it.value !== null && s.avg !== null && it.value >= 2 * s.avg;
      return '<li><span class="nolabel" style="padding-left:0"><span><span class="it-name">' + esc(it.name) + '</span><span class="it-meta">' + esc(it.kind) + "</span></span></span>" +
        '<span class="it-val"' + (hot ? ' style="color:' + AMBER + '"' : "") + ">" + fmt(it.value, 2) + "</span></li>";
    }).join("");
  }
  var EYE = function (off) {
    return '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"></path><circle cx="9" cy="9" r="2.2"></circle>' + (off ? '<path d="M3 3l12 12"></path>' : "") + "</svg>";
  };
  // 칩의 이름을 누르면 오른쪽 목록에서 그 지표가 있는 곳으로 간다
  function jumpTo(id) {
    var x = byId[id];
    if (!x) return;
    state.open[x.category] = true; state.open[x.category + "/" + x.group] = true; save(); renderList();
    var wasClosed = !panelOpen;
    if (wasClosed) setPanel(true, false);
    setTimeout(function () {
      var li = document.querySelector('#list li[data-row="' + id.replace(/"/g, '\\"') + '"]');
      if (!li) return;
      var input = li.querySelector("input") || li;
      li.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
      li.classList.add("flash");
      setTimeout(function () { li.classList.remove("flash"); }, 2200);
      try { input.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
    }, wasClosed ? 340 : 0);
  }
  function renderList() {
    var html = "";
    CATS.forEach(function (cat) {
      var open = !!state.open[cat.id];
      html += '<section class="cat"><h3><button type="button" data-toggle="' + esc(cat.id) + '" aria-expanded="' + open + '"><span><span class="cat-name">' + esc(cat.id) + '</span><span class="cat-note">' + esc(cat.note) + (cat.id === "주도 섹터 (AI)" ? " · " + esc(D.sector.date) + " 수동 입력" : "") + "</span></span>" + chev(open ? "180deg" : "0deg") + "</button></h3>";
      if (open) {
        cat.groups.forEach(function (g) {
          var key = cat.id + "/" + g, gOpen = !!state.open[key], gn = D.groupNow[g];
          var score = gn && gn.score !== null && gn.score !== undefined ? gn.score : null;
          var hot = score !== null && (g === "물가" ? score >= 70 : score <= 30);
          html += '<div class="grp"><button type="button" data-toggle="' + esc(key) + '" aria-expanded="' + gOpen + '">' + chev(gOpen ? "0deg" : "-90deg") +
            '<span class="grp-name">' + esc(GROUP_LABEL[g] || g) + "</span>" +
            (score !== null ? '<span class="bar" aria-hidden="true"><span style="width:' + score + "%" + (hot ? ";background:" + AMBER : "") + '"></span></span><span class="grp-score"' + (hot ? ' style="color:' + AMBER + '"' : "") + ">" + fmt(score, 1) + "</span>" : "") + "</button>";
          if (gOpen) {
            html += '<ul class="items">';
            if (cat.id === "주도 섹터 (AI)") html += sectorRows();
            else if (cat.id === AI_CAT) html += aiRows(g);
            else D.indicators.filter(function (x) { return x.category === cat.id && x.group === g; }).forEach(function (x) { html += itemRow(x); });
            html += "</ul>";
          }
          html += "</div>";
        });
      }
      html += "</section>";
    });
    $("list").innerHTML = html;
  }

  // ---------- 차트 ----------
  // 보는 구간(view)이 목표 구간(target)을 부드럽게 따라가도록 매 프레임 조금씩 움직인다.
  var FULL_A = BT0, FULL_B = LAST, MIN_SPAN = 12;
  var view = { a: FULL_A, b: FULL_B }, target = { a: FULL_A, b: FULL_B }, yv = null, raf = null, lastT = 0;
  var hoverIdx = null, geom = null, comp = null, sig = null, eps = [], px = null;
  var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var host = $("chart");

  function clampRange(a, b) {
    var span = Math.min(FULL_B - FULL_A, Math.max(MIN_SPAN, b - a));
    var mid = (a + b) / 2, na = mid - span / 2;
    na = Math.max(FULL_A, Math.min(FULL_B - span, na));
    return { a: na, b: na + span };
  }
  function yTarget() {
    var lo = Infinity, hi = -Infinity, i0 = Math.max(FULL_A, Math.floor(view.a)), i1 = Math.min(FULL_B, Math.ceil(view.b));
    for (var i = i0; i <= i1; i++) if (px[i] !== null && px[i] !== undefined) { if (px[i] < lo) lo = px[i]; if (px[i] > hi) hi = px[i]; }
    if (!isFinite(lo)) { lo = 1; hi = 10; }
    return { l0: Math.log(lo * 0.92), l1: Math.log(hi * 1.08) };
  }
  function logTicks(lo, hi) {
    var out = [], e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
    for (var e = e0; e <= e1; e++) [1, 2, 5].forEach(function (m) { var v = m * Math.pow(10, e); if (v >= lo && v <= hi) out.push(v); });
    if (out.length > 7) out = out.filter(function (v) { return Math.round(v / Math.pow(10, Math.floor(Math.log10(v) + 1e-9))) === 1; });
    if (out.length < 2) { out = []; var st = Math.pow(10, Math.floor(Math.log10((hi - lo) / 3))); for (var v2 = Math.ceil(lo / st) * st; v2 <= hi; v2 += st) out.push(Math.round(v2 * 100) / 100); }
    return out;
  }
  function prepareChart() {
    px = D.prices[state.chart];
    var isN = state.chart === "nasdaq";
    $("chart-title").textContent = (isN ? "나스닥 종합지수" : "S&P500") + " · " + monthStr(BT0).slice(0, 4) + "~" + monthStr(LAST).slice(0, 4);
    $("chart-source").textContent = isN ? "출처: FRED (NASDAQCOM), 월평균 · 로그 눈금" : "출처: 로버트 실러 교수 공개 자료" + (D.capeEst ? ", 최근 달은 FRED (SP500)" : "") + ", 월평균 · 로그 눈금";
    $("btn-nasdaq").setAttribute("aria-pressed", String(isN));
    $("btn-sp500").setAttribute("aria-pressed", String(!isN));
    $("btn-sp500").disabled = !D.prices.sp500;
    var sel = selectedInds();
    comp = sel.length ? E.composite(sel, N) : null;
    sig = comp ? E.toSignal(comp.value, D.rules.threshold, D.rules.minMonths) : null;
    eps = sig ? E.episodes(sig) : [];
    var picked = pickedInds();
    $("chips").innerHTML = picked.map(function (x) {
      var off = !!state.hidden[x.id];
      return '<li' + (off ? ' class="off"' : "") + '><button type="button" class="go" data-go="' + esc(x.id) + '" title="오른쪽 목록에서 이 지표 보기">' + esc(x.name) + '</button><button type="button" class="eye" data-eye="' + esc(x.id) + '" aria-pressed="' + !off + '" aria-label="' + esc(x.name) + (off ? " 켜기" : " 끄기") + '" title="' + (off ? "꺼짐 · 눌러서 켜기" : "켜짐 · 눌러서 끄기") + '">' + EYE(off) + "</button></li>";
    }).join("");
    $("sel-count").textContent = picked.length; $("sel-on").textContent = sel.length;
    kick();
  }
  function draw() {
    var Wd = Math.max(300, Math.floor(host.clientWidth - 40) || 900);
    var L = 58, R = 10, T = 10, H1 = Math.round(Math.min(360, Math.max(200, Wd * 0.38))), GAP = 38, H2 = 120, B = 30;
    var H = T + H1 + GAP + H2 + B, PW = Wd - L - R, a = view.a, b = view.b, span = b - a;
    if (!yv) yv = yTarget();
    var X = function (i) { return L + ((i - a) / span) * PW; };
    var Y1 = function (v) { return T + H1 - ((Math.log(v) - yv.l0) / (yv.l1 - yv.l0)) * H1; };
    var top2 = T + H1 + GAP, Y2 = function (v) { return top2 + H2 - (v / 100) * H2; };
    geom = { L: L, PW: PW, Wd: Wd, T: T, H1: H1, top2: top2, H2: H2, axisY: top2 + H2 };
    var i0 = Math.max(FULL_A, Math.floor(a) - 1), i1 = Math.min(FULL_B, Math.ceil(b) + 1);
    var mono = ' font-family="IBM Plex Mono, monospace"', sans = ' font-family="Noto Sans KR, sans-serif"';

    var s = '<svg viewBox="0 0 ' + Wd + " " + H + '" role="img" aria-label="' + (state.chart === "nasdaq" ? "나스닥 종합지수" : "S&P500") + ' 차트와 선택한 지표의 종합 점수. 회색 띠는 경기침체 구간입니다.">';
    s += '<defs><clipPath id="c1"><rect x="' + L + '" y="' + T + '" width="' + PW + '" height="' + H1 + '"></rect></clipPath><clipPath id="c2"><rect x="' + L + '" y="' + top2 + '" width="' + PW + '" height="' + H2 + '"></rect></clipPath></defs>';
    s += '<rect x="' + L + '" y="' + T + '" width="' + PW + '" height="' + H1 + '" fill="#0A0B0D"></rect><rect x="' + L + '" y="' + top2 + '" width="' + PW + '" height="' + H2 + '" fill="#0A0B0D"></rect>';
    var bands = function (list, clip, y, h, fill, op) {
      var g = '<g clip-path="url(#' + clip + ')" fill="' + fill + '"' + (op ? ' opacity="' + op + '"' : "") + ">";
      list.forEach(function (r) { if (r[1] < i0 || r[0] > i1) return; var x0 = X(r[0]), w = Math.max(1.5, X(r[1] + 1) - x0); g += '<rect x="' + x0.toFixed(1) + '" y="' + y + '" width="' + w.toFixed(1) + '" height="' + h + '"></rect>'; });
      return g + "</g>";
    };
    s += bands(D.recessions, "c1", T, H1, "#2A2E36") + bands(D.recessions, "c2", top2, H2, "#2A2E36");
    logTicks(Math.exp(yv.l0), Math.exp(yv.l1)).forEach(function (v) {
      var y = Y1(v);
      if (y < T + 6 || y > T + H1 - 2) return;
      s += '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#23262D"></line><text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" fill="#A9AFBA" font-size="12" text-anchor="end"' + mono + ">" + v.toLocaleString("ko-KR") + "</text>";
    });
    [0, 50, 100].forEach(function (v) {
      var y = Y2(v).toFixed(1);
      s += '<line x1="' + L + '" y1="' + y + '" x2="' + (L + PW) + '" y2="' + y + '" stroke="#23262D"></line><text x="' + (L - 8) + '" y="' + (Number(y) + 4) + '" fill="#A9AFBA" font-size="12" text-anchor="end"' + mono + ">" + v + "</text>";
    });
    // 가로축 눈금: 보는 구간 길이에 맞춰 간격을 바꾼다
    var step = span > 360 ? 120 : span > 180 ? 60 : span > 84 ? 24 : span > 36 ? 12 : span > 18 ? 6 : span > 8 ? 3 : 1;
    var base = startY * 12 + startM;
    for (var m = Math.ceil((base + a) / step) * step; m <= base + b; m += step) {
      var xt = X(m - base);
      if (xt < L + 14 || xt > L + PW - 14) continue;
      var lab = step >= 12 ? String(m / 12) : Math.floor(m / 12) + "-" + String((m % 12) + 1).padStart(2, "0");
      s += '<line x1="' + xt.toFixed(1) + '" y1="' + (top2 + H2) + '" x2="' + xt.toFixed(1) + '" y2="' + (top2 + H2 + 5) + '" stroke="#3A3F49"></line><text x="' + xt.toFixed(1) + '" y="' + (H - 8) + '" fill="#A9AFBA" font-size="12" text-anchor="middle"' + mono + ">" + lab + "</text>";
    }
    var path = function (arr, Y) {
      var d = "", pen = false;
      for (var k = i0; k <= i1; k++) { if (arr[k] === null || arr[k] === undefined) { pen = false; continue; } d += (pen ? "L" : "M") + X(k).toFixed(1) + " " + Y(arr[k]).toFixed(1); pen = true; }
      return d;
    };
    s += '<path clip-path="url(#c1)" d="' + path(px, Y1) + '" fill="none" stroke="#F2F3F5" stroke-width="1.6" stroke-linejoin="round"></path>';
    if (comp) {
      s += bands(eps, "c2", top2, H2, AMBER, "0.22");
      s += '<path clip-path="url(#c2)" d="' + path(comp.value, Y2) + '" fill="none" stroke="#8FC4FF" stroke-width="1.5" stroke-linejoin="round"></path>';
    } else {
      s += '<text x="' + (L + PW / 2) + '" y="' + (top2 + H2 / 2 + 5) + '" fill="#A9AFBA" font-size="14" text-anchor="middle"' + sans + ">지표를 체크하면 종합 점수가 그려집니다</text>";
    }
    var yt = Y2(D.rules.threshold).toFixed(1);
    s += '<line x1="' + L + '" y1="' + yt + '" x2="' + (L + PW) + '" y2="' + yt + '" stroke="' + AMBER + '" stroke-width="1.2" stroke-dasharray="6 5"></line>';
    s += '<text x="' + (L + 6) + '" y="' + (T + 16) + '" fill="#A9AFBA" font-size="12"' + sans + ">회색 띠 = 경기침체</text>";
    s += '<text x="' + L + '" y="' + (top2 - 9) + '" fill="#A9AFBA" font-size="12"' + sans + ">종합 점수 · 노란 띠 = 경보 켜짐 · 점선 = 기준 " + D.rules.threshold + "</text>";
    if (hoverIdx !== null && hoverIdx >= a && hoverIdx <= b) {
      var hx = X(hoverIdx).toFixed(1);
      s += '<line x1="' + hx + '" y1="' + T + '" x2="' + hx + '" y2="' + (top2 + H2) + '" stroke="#F2F3F5" stroke-width="1" opacity="0.5"></line>';
    }
    host.innerHTML = s + "</svg>";
    readout();
  }
  function tick(t) {
    var dt = lastT ? Math.min(64, t - lastT) : 16;
    lastT = t;
    var k = reduceMotion ? 1 : 1 - Math.exp(-dt / 85);
    view.a += (target.a - view.a) * k; view.b += (target.b - view.b) * k;
    var ytg = yTarget();
    if (!yv) yv = ytg;
    yv.l0 += (ytg.l0 - yv.l0) * k; yv.l1 += (ytg.l1 - yv.l1) * k;
    var done = Math.abs(target.a - view.a) < 0.02 && Math.abs(target.b - view.b) < 0.02 && Math.abs(ytg.l0 - yv.l0) < 0.002 && Math.abs(ytg.l1 - yv.l1) < 0.002;
    if (done) { view.a = target.a; view.b = target.b; yv = ytg; }
    draw();
    raf = done ? null : requestAnimationFrame(tick);
  }
  function kick() { if (!raf) { lastT = 0; raf = requestAnimationFrame(tick); } }
  function go(a, b, instant) {
    target = clampRange(a, b);
    if (instant) { view.a = target.a; view.b = target.b; }
    markRange();
    kick();
  }
  function markRange() {
    var span = Math.round(target.b - target.a), atEnd = Math.abs(target.b - FULL_B) < 0.5;
    Array.prototype.forEach.call(document.querySelectorAll("button[data-range]"), function (bt) {
      var r = bt.getAttribute("data-range"), on = r === "full" ? span >= FULL_B - FULL_A - 0.5 : atEnd && span === Number(r);
      bt.setAttribute("aria-pressed", String(on));
    });
  }
  function readout() {
    var i = hoverIdx === null ? LAST : hoverIdx;
    var t = monthStr(i) + " · " + (state.chart === "nasdaq" ? "나스닥 " : "S&P500 ") + fmt(px[i], 0);
    if (comp) t += " · 종합 점수 " + fmt(comp.value[i], 1) + " (지표 " + comp.total + "개 중 " + comp.used[i] + "개)" + (sig[i] ? " · 경보 켜짐" : "");
    var zoomed = view.b - view.a < FULL_B - FULL_A - 0.5;
    $("readout").textContent = (hoverIdx === null ? "최근: " : "") + t + (zoomed ? " · 보는 구간 " + monthStr(Math.round(view.a)) + " ~ " + monthStr(Math.round(view.b)) : "");
  }

  // 차트 조작: 끌어서 이동, 휠·두 손가락으로 확대·축소, 아래 시간축을 끌어 늘리고 줄이기, 두 번 눌러 전체 보기
  var drag = null, pinch = null, pointers = {};
  function locate(ev) {
    var svg = host.querySelector("svg");
    if (!svg || !geom) return null;
    var box = svg.getBoundingClientRect(), sc = geom.Wd / box.width;
    return { x: (ev.clientX - box.left) * sc, y: (ev.clientY - box.top) * sc };
  }
  var idxAt = function (x) { return view.a + ((x - geom.L) / geom.PW) * (view.b - view.a); };
  var inPlot = function (p) { return p && p.x >= geom.L && p.x <= geom.L + geom.PW && p.y >= geom.T; };
  host.addEventListener("pointerdown", function (ev) {
    var p = locate(ev);
    if (!inPlot(p)) return;
    try { host.setPointerCapture(ev.pointerId); } catch (e) { /* 무시 */ }
    pointers[ev.pointerId] = p;
    var ids = Object.keys(pointers);
    if (ids.length === 2) {
      var p1 = pointers[ids[0]], p2 = pointers[ids[1]];
      pinch = { d0: Math.max(10, Math.abs(p1.x - p2.x)), c: idxAt((p1.x + p2.x) / 2), a0: view.a, b0: view.b };
      drag = null;
    } else {
      drag = { mode: p.y > geom.axisY ? "scale" : "pan", x0: p.x, a0: view.a, b0: view.b };
      host.style.cursor = drag.mode === "pan" ? "grabbing" : "ew-resize";
    }
  });
  host.addEventListener("pointermove", function (ev) {
    var p = locate(ev);
    if (!p) return;
    if (pointers[ev.pointerId]) pointers[ev.pointerId] = p;
    var ids = Object.keys(pointers);
    if (pinch && ids.length >= 2) {
      var p1 = pointers[ids[0]], p2 = pointers[ids[1]], f = pinch.d0 / Math.max(10, Math.abs(p1.x - p2.x));
      go(pinch.c - (pinch.c - pinch.a0) * f, pinch.c + (pinch.b0 - pinch.c) * f, true);
      return;
    }
    if (drag) {
      var dx = p.x - drag.x0, span0 = drag.b0 - drag.a0;
      if (drag.mode === "pan") { var sh = (-dx / geom.PW) * span0; go(drag.a0 + sh, drag.b0 + sh, true); }
      else { var f2 = Math.exp(-dx / 220), mid = (drag.a0 + drag.b0) / 2; go(mid - (span0 * f2) / 2, mid + (span0 * f2) / 2, true); }
      hoverIdx = null;
      return;
    }
    if (inPlot(p)) {
      host.style.cursor = p.y > geom.axisY ? "ew-resize" : "grab";
      var hi = Math.max(FULL_A, Math.min(FULL_B, Math.round(idxAt(p.x))));
      if (hi !== hoverIdx) { hoverIdx = hi; if (!raf) draw(); }
    } else if (hoverIdx !== null) { hoverIdx = null; host.style.cursor = ""; if (!raf) draw(); }
  });
  var release = function (ev) {
    delete pointers[ev.pointerId];
    if (Object.keys(pointers).length < 2) pinch = null;
    if (drag) { drag = null; host.style.cursor = ""; }
  };
  host.addEventListener("pointerup", release);
  host.addEventListener("pointercancel", release);
  host.addEventListener("pointerleave", function () { if (!drag && !pinch && hoverIdx !== null) { hoverIdx = null; if (!raf) draw(); } });
  host.addEventListener("wheel", function (ev) {
    var p = locate(ev);
    if (!inPlot(p)) return;
    ev.preventDefault();
    var f = Math.exp(Math.max(-120, Math.min(120, ev.deltaY)) * 0.0022), c = idxAt(p.x);
    go(c - (c - target.a) * f, c + (target.b - c) * f);
  }, { passive: false });
  host.addEventListener("dblclick", function () { go(FULL_A, FULL_B); });
  Array.prototype.forEach.call(document.querySelectorAll("button[data-range]"), function (bt) {
    bt.addEventListener("click", function () {
      var r = bt.getAttribute("data-range");
      if (r === "full") go(FULL_A, FULL_B); else go(FULL_B - Number(r), FULL_B);
    });
  });
  if (window.ResizeObserver) new ResizeObserver(function () { if (px && !raf) draw(); }).observe(host);
  else window.addEventListener("resize", function () { if (px && !raf) draw(); });
  var renderChart = function () { prepareChart(); };

  // ---------- 선택한 조합의 과거 성적 ----------
  function renderRecord() {
    var sel = selectedInds(), grid = $("rec-grid"), intro = $("rec-intro");
    if (!sel.length) { intro.textContent = "오른쪽에서 지표를 고르면 그 조합이 과거에 어땠는지를 이 자리에 보여줍니다."; grid.innerHTML = ""; return; }
    var c = E.composite(sel, N), sg = E.toSignal(c.value, D.rules.threshold, D.rules.minMonths);
    var r = E.recessionEval(sg, D.recessions, BT0, D.rules.window, LAST);
    var f = E.forward(D.prices[state.chart], 12), lastF = LAST;
    while (lastF > 0 && f.ret[lastF] === null) lastF--;
    var on = E.fwdStats(function (i) { return sg[i] === true; }, f, BT0, lastF), off = E.fwdStats(function (i) { return sg[i] === false; }, f, BT0, lastF);
    var first = c.value.findIndex(function (v) { return v !== null; });
    var mkt = state.chart === "nasdaq" ? "나스닥" : "S&P500";
    var isStd = sel.length === standardLead.length && sel.every(function (x) { return standardLead.indexOf(x.id) >= 0; });
    intro.textContent = (isStd ? "지금 선택은 표준 선행 세트입니다. " : "") + "선택한 지표 " + sel.length + "개의 종합 점수로 계산했습니다. 종합 점수는 " + (first >= 0 ? monthStr(Math.max(first, 0)) : "—") + "부터 나옵니다.";
    var cell = function (k, v, n, hot) { return '<div><p class="k">' + k + '</p><p class="v"' + (hot ? ' style="color:' + AMBER + '"' : "") + ">" + v + '</p><p class="n">' + (n || "") + "</p></div>"; };
    var missed = r.missed.map(function (i) { return monthStr(i); }).join(", ");
    grid.innerHTML =
      cell("침체를 미리 알렸나", r.eligible ? r.hits + " / " + r.eligible + "번" : "판정 불가", r.eligible ? (r.avgLead !== null ? "평균 " + fmt(r.avgLead, 0) + "개월 전" : "") + (missed ? " · 놓침: " + missed : "") : "평가할 수 있는 침체가 없습니다", r.eligible > 0 && r.hits / r.eligible >= 0.8) +
      cell("헛경보", r.counted ? r.falseSignals + " / " + r.counted + "번" : "0번", "침체 밖에서 켜진 경보 중 침체가 오지 않은 것") +
      cell("경보가 켜져 있던 기간", r.onShare === null ? "—" : pct(r.onShare, 0), "너무 길면 경보로서 쓸모가 없습니다") +
      cell("지금 계산에 들어간 지표", c.used[LAST] + " / " + c.total + "개", "초기 구간은 더 적은 지표로 계산됩니다") +
      cell("경보 꺼짐일 때 이후 1년 " + mkt, pct(off.mean), off.n + "개월 평균") +
      cell("경보 켜짐일 때 이후 1년 " + mkt, pct(on.mean), on.n ? on.n + "개월 평균 · 손실로 끝난 비율 " + pct(on.neg, 0) : "경보가 켜진 달이 없습니다");
  }

  // ---------- 사이클 위치: 경기 × 유동성 사분면과 기준금리 ----------
  var Q = D.quad, PH_COLOR = { "1": AMBER, "0": "#A9AFBA", "-1": "#8FC4FF" }, PH_NAME = { "1": "인상기", "0": "동결기", "-1": "인하기" };
  var ymKo = function (m) { return m.slice(0, 4) + "년 " + Number(m.slice(5, 7)) + "월"; };
  var spct = function (v) { return v === null || v === undefined ? "—" : (v > 0 ? "+" : "") + fmt(v, 1) + "%"; };
  function quadReadout(i) {
    var k = Q.econ[i] >= Q.cut ? (Q.liq[i] >= Q.cut ? 0 : 2) : (Q.liq[i] >= Q.cut ? 1 : 3), ph = Q.phase[i];
    $("quad-readout").innerHTML = (i === Q.now.index ? "지금 · " : "") + esc(ymKo(monthStr(i))) + " · <strong>" + esc(Q.names[k]) + '</strong> · 경기 <span class="mono">' + fmt(Q.econ[i], 1) + '</span> · 유동성 <span class="mono">' + fmt(Q.liq[i], 1) +
      '</span> · 기준금리 <span class="mono">' + fmt(Q.rate[i], 2) + "%</span>" + (ph === null || ph === undefined ? "" : " (" + PH_NAME[String(ph)] + ")") +
      (D.fiscal && D.fiscal.series[i] !== null && D.fiscal.series[i] !== undefined ? ' · 재정적자/GDP <span class="mono">' + fmt(D.fiscal.series[i], 1) + "%</span>" : "");
    ["qrate-mark", "qfis-mark"].forEach(function (id) { var mk = document.getElementById(id); if (mk && mk.dataset.x0) { var x = Number(mk.dataset.x0) + (i - Number(mk.dataset.i0)) * Number(mk.dataset.dx); mk.setAttribute("x1", x); mk.setAttribute("x2", x); } });
    Array.prototype.forEach.call(document.querySelectorAll("#quad circle[data-dot]"), function (c) { c.setAttribute("stroke", Number(c.getAttribute("data-dot")) === i ? "#F2F3F5" : "none"); });
  }
  // 재생 조작: 버튼을 누르면 기간의 처음부터 한 달씩 길이 그려진다. 막대를 끌면 원하는 달로 간다.
  var qCur = null, qTimer = null;
  var PLAY_IC = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 1.2v9.6L10.5 6z" fill="currentColor"></path></svg>', PAUSE_IC = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor"></path></svg>';
  function quadStop(reset) { if (qTimer) { clearInterval(qTimer); qTimer = null; } if (reset) qCur = null; }
  function quadPlay() {
    if (!Q || !Q.now) return;
    if (qTimer) { quadStop(false); renderQuad(); return; }
    var span = Number(state.quadRange) || 48, end = Q.now.index, first = Math.max(0, end - span + 1);
    while (first < end && (Q.econ[first] === null || Q.liq[first] === null)) first++;
    if (qCur === null || qCur >= end) qCur = first;
    var step = Math.max(45, Math.min(220, Math.round(9000 / Math.max(1, end - first))));   // 기간이 길어도 9초 안팎에 끝나도록
    qTimer = setInterval(function () {
      if (qCur >= end) { quadStop(true); renderQuad(); return; }
      qCur++; renderQuad();
    }, step);
    renderQuad();
  }
  function renderQuad() {
    if (!Q || !Q.now) return;
    $("quad-card").hidden = false;
    var span = Number(state.quadRange) || 48, end = Q.now.index, idx = [];
    for (var i = Math.max(0, end - span + 1); i <= end; i++) if (Q.econ[i] !== null && Q.liq[i] !== null) idx.push(i);
    if (!idx.length) return;
    // 재생: 화면에 그리는 길은 "지금 보고 있는 달"(cur)까지만. 아래 띠 차트는 전체 기간을 그대로 두고 표시선만 옮긴다.
    var all = idx, cur = qCur !== null && qCur >= all[0] && qCur <= end ? qCur : end;
    idx = all.filter(function (q) { return q <= cur; }); cur = idx[idx.length - 1];
    var seek = $("quad-seek"); seek.min = all[0]; seek.max = end; seek.value = cur;
    $("quad-play").setAttribute("aria-pressed", String(!!qTimer)); $("quad-play").innerHTML = (qTimer ? PAUSE_IC : PLAY_IC) + "<span>" + (qTimer ? "멈춤" : "재생") + "</span>";
    $("quad-when").textContent = cur === end ? "지금" : ymKo(monthStr(cur));
    Array.prototype.forEach.call(document.querySelectorAll("[data-qrange]"), function (b) { b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-qrange")) === span)); });
    $("quad-sub").textContent = "가로: 경기(표준 선행 종합 점수) · 세로: 유동성(표준 유동성 종합 점수) · 경계 " + Q.cut + "점 · " + ymKo(monthStr(idx[0])) + "~" + ymKo(monthStr(end));
    var host = $("quad"), W = Math.max(300, Math.round(host.clientWidth || 860)), small = W < 560, H = Math.round(Math.min(560, Math.max(320, W * (small ? 0.9 : 0.6))));
    var L = small ? 34 : 46, R = 14, T = 12, B = small ? 34 : 40, pw = W - L - R, ph = H - T - B;
    var X = function (v) { return L + v / 100 * pw; }, Y = function (v) { return T + (100 - v) / 100 * ph; };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="경기와 유동성 점수로 본 사이클 위치. 최근 ' + span + '개월의 이동 경로.">';
    s += '<rect x="' + L + '" y="' + T + '" width="' + pw + '" height="' + ph + '" fill="#0A0B0D" stroke="#23262D"></rect>';
    s += '<line x1="' + X(Q.cut) + '" y1="' + T + '" x2="' + X(Q.cut) + '" y2="' + (T + ph) + '" stroke="#3A3F49"></line><line x1="' + L + '" y1="' + Y(Q.cut) + '" x2="' + (L + pw) + '" y2="' + Y(Q.cut) + '" stroke="#3A3F49"></line>';
    var fs = small ? 12 : 14, lab = function (x, y, anchor, t1, t2) { return '<text x="' + x + '" y="' + y + '" text-anchor="' + anchor + '" font-size="' + fs + '" font-weight="700" fill="#A9AFBA">' + t1 + '</text><text x="' + x + '" y="' + (y + fs + 3) + '" text-anchor="' + anchor + '" font-size="' + (fs - 2) + '" fill="#6F7682">' + t2 + "</text>"; };
    s += lab(L + 10, T + fs + 6, "start", "금융장세", "경기 나쁨 · 돈 풍부") + lab(L + pw - 10, T + fs + 6, "end", "실적장세", "경기 좋음 · 돈 풍부") +
      lab(L + 10, T + ph - fs - 8, "start", "역실적장세", "경기 나쁨 · 돈 긴축") + lab(L + pw - 10, T + ph - fs - 8, "end", "역금융장세", "경기 좋음 · 돈 긴축");
    [0, 25, 50, 75, 100].forEach(function (v) {
      s += '<text x="' + X(v) + '" y="' + (T + ph + 16) + '" text-anchor="middle" font-size="11" fill="#A9AFBA" font-family="IBM Plex Mono, monospace">' + v + '</text><text x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end" font-size="11" fill="#A9AFBA" font-family="IBM Plex Mono, monospace">' + v + "</text>";
    });
    s += '<text x="' + (L + pw) + '" y="' + (H - 4) + '" text-anchor="end" font-size="11" fill="#A9AFBA">경기 점수 →</text><text x="' + L + '" y="' + (H - 4) + '" font-size="11" fill="#A9AFBA">세로: 유동성 점수</text>';
    var n = idx.length, op = function (k) { return n < 2 ? 1 : 0.18 + 0.82 * Math.pow(k / (n - 1), 1.6); }, col = function (i) { var p = Q.phase[i]; return PH_COLOR[String(p === null || p === undefined ? 0 : p)]; };
    for (var k = 1; k < n; k++) { var a = idx[k - 1], b = idx[k];
      s += '<line x1="' + X(Q.econ[a]).toFixed(1) + '" y1="' + Y(Q.liq[a]).toFixed(1) + '" x2="' + X(Q.econ[b]).toFixed(1) + '" y2="' + Y(Q.liq[b]).toFixed(1) + '" stroke="' + col(b) + '" stroke-width="' + (small ? 1.6 : 2) + '" stroke-linecap="round" opacity="' + op(k).toFixed(2) + '"></line>'; }
    for (k = 0; k < n; k++) { var i2 = idx[k], cx = X(Q.econ[i2]).toFixed(1), cy = Y(Q.liq[i2]).toFixed(1), isNow = i2 === cur, jan = monthStr(i2).slice(5) === "01";
      s += '<circle data-dot="' + i2 + '" cx="' + cx + '" cy="' + cy + '" r="' + (isNow ? 7 : jan ? 4 : 2.5) + '" fill="' + col(i2) + '" opacity="' + (isNow ? 1 : op(k).toFixed(2)) + '" stroke="' + (isNow ? "#F2F3F5" : "none") + '" stroke-width="2"></circle>';
      if (jan && !isNow) s += '<text x="' + cx + '" y="' + (Number(cy) - 8) + '" text-anchor="middle" font-size="11" fill="#D5D8DE" opacity="' + Math.max(0.55, op(k)).toFixed(2) + '" font-family="IBM Plex Mono, monospace">' + monthStr(i2).slice(0, 4) + "</text>"; }
    var nx = X(Q.econ[cur]), ny = Y(Q.liq[cur]);
    s += '<text x="' + (nx > L + pw - 50 ? nx - 12 : nx + 12) + '" y="' + (ny + 4) + '" text-anchor="' + (nx > L + pw - 50 ? "end" : "start") + '" font-size="13" font-weight="700" fill="#F2F3F5">' + (cur === end ? "지금" : monthStr(cur).replace("-", ".")) + '</text>';
    for (k = 0; k < n; k++) s += '<circle data-hit="' + idx[k] + '" cx="' + X(Q.econ[idx[k]]).toFixed(1) + '" cy="' + Y(Q.liq[idx[k]]).toFixed(1) + '" r="9" fill="transparent"></circle>';
    host.innerHTML = s + "</svg>";

    // 기준금리 띠: 같은 기간, 같은 색
    var rh = $("quad-rate"), RH = small ? 120 : 140, rT = 10, rB = 22, i0 = idx[0], vals = [];
    for (i = i0; i <= end; i++) if (Q.rate[i] !== null) vals.push(Q.rate[i]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals); if (hi - lo < 0.5) { hi += 0.25; lo -= 0.25; } var pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    var dx = end > i0 ? pw / (end - i0) : 0, RX = function (i) { return L + (i - i0) * dx; }, RY = function (v) { return rT + (hi - v) / (hi - lo) * (RH - rT - rB); };
    var r = '<svg viewBox="0 0 ' + W + " " + RH + '" role="img" aria-label="같은 기간의 기준금리">';
    [hi - pad, lo + pad].forEach(function (v) { r += '<line x1="' + L + '" y1="' + RY(v) + '" x2="' + (L + pw) + '" y2="' + RY(v) + '" stroke="#1B1E24"></line><text x="' + (L - 6) + '" y="' + (RY(v) + 4) + '" text-anchor="end" font-size="11" fill="#A9AFBA" font-family="IBM Plex Mono, monospace">' + fmt(v, 2) + "</text>"; });
    for (i = i0; i <= end; i++) if (monthStr(i).slice(5) === "01") r += '<line x1="' + RX(i) + '" y1="' + rT + '" x2="' + RX(i) + '" y2="' + (RH - rB) + '" stroke="#1B1E24"></line><text x="' + RX(i) + '" y="' + (RH - 6) + '" text-anchor="middle" font-size="11" fill="#A9AFBA" font-family="IBM Plex Mono, monospace">' + monthStr(i).slice(0, 4) + "</text>";
    for (i = i0 + 1; i <= end; i++) if (Q.rate[i] !== null && Q.rate[i - 1] !== null) r += '<line x1="' + RX(i - 1).toFixed(1) + '" y1="' + RY(Q.rate[i - 1]).toFixed(1) + '" x2="' + RX(i).toFixed(1) + '" y2="' + RY(Q.rate[i]).toFixed(1) + '" stroke="' + col(i) + '" stroke-width="2.2" stroke-linecap="round"></line>';
    r += '<line id="qrate-mark" data-x0="' + L + '" data-i0="' + i0 + '" data-dx="' + dx + '" x1="' + RX(cur) + '" x2="' + RX(cur) + '" y1="' + rT + '" y2="' + (RH - rB) + '" stroke="#F2F3F5" stroke-dasharray="3 3" opacity="0.7"></line>';
    rh.innerHTML = r + "</svg>";
    $("quad-rate-sub").textContent = "실효 연방기금금리 월평균(%) · " + Q.lookback + "개월 전보다 " + fmt(Q.step, 2) + "%p 이상 오르면 인상기, 내리면 인하기";
    // 재정적자/GDP 띠: 같은 기간. 점선은 기준(1.5%)
    var F = D.fiscal, fh = $("quad-fis");
    if (F && F.now) {
      var fv = []; for (i = i0; i <= end; i++) if (F.series[i] !== null && F.series[i] !== undefined) fv.push(F.series[i]);
      if (fv.length > 1) {
        $("quad-fis-head").hidden = false;
        var flo = Math.min(Math.min.apply(null, fv), F.cut), fhi = Math.max(Math.max.apply(null, fv), F.cut); if (fhi - flo < 1) { fhi += 0.5; flo -= 0.5; } var fp = (fhi - flo) * 0.14; flo -= fp; fhi += fp;
        var FY = function (v) { return rT + (fhi - v) / (fhi - flo) * (RH - rT - rB); };
        var f = '<svg viewBox="0 0 ' + W + " " + RH + '" role="img" aria-label="같은 기간의 정부 재정적자 대 GDP 비율">';
        [fhi - fp, flo + fp].forEach(function (v) { f += '<line x1="' + L + '" y1="' + FY(v) + '" x2="' + (L + pw) + '" y2="' + FY(v) + '" stroke="#1B1E24"></line><text x="' + (L - 6) + '" y="' + (FY(v) + 4) + '" text-anchor="end" font-size="11" fill="#A9AFBA" font-family="IBM Plex Mono, monospace">' + fmt(v, 1) + "</text>"; });
        for (i = i0; i <= end; i++) if (monthStr(i).slice(5) === "01") f += '<line x1="' + RX(i) + '" y1="' + rT + '" x2="' + RX(i) + '" y2="' + (RH - rB) + '" stroke="#1B1E24"></line><text x="' + RX(i) + '" y="' + (RH - 6) + '" text-anchor="middle" font-size="11" fill="#A9AFBA" font-family="IBM Plex Mono, monospace">' + monthStr(i).slice(0, 4) + "</text>";
        f += '<line x1="' + L + '" y1="' + FY(F.cut) + '" x2="' + (L + pw) + '" y2="' + FY(F.cut) + '" stroke="' + AMBER + '" stroke-dasharray="5 4" opacity="0.8"></line><text x="' + (L + pw - 4) + '" y="' + (FY(F.cut) - 5) + '" text-anchor="end" font-size="11" fill="' + AMBER + '">기준 ' + fmt(F.cut, 1) + "%</text>";
        for (i = i0 + 1; i <= end; i++) { var fa = F.series[i - 1], fb = F.series[i]; if (fa !== null && fb !== null && fa !== undefined && fb !== undefined) f += '<line x1="' + RX(i - 1).toFixed(1) + '" y1="' + FY(fa).toFixed(1) + '" x2="' + RX(i).toFixed(1) + '" y2="' + FY(fb).toFixed(1) + '" stroke="#F2F3F5" stroke-width="2.2" stroke-linecap="round"></line>'; }
        f += '<line id="qfis-mark" data-x0="' + L + '" data-i0="' + i0 + '" data-dx="' + dx + '" x1="' + RX(cur) + '" x2="' + RX(cur) + '" y1="' + rT + '" y2="' + (RH - rB) + '" stroke="#F2F3F5" stroke-dasharray="3 3" opacity="0.7"></line>';
        fh.innerHTML = f + "</svg>";
        $("quad-fis-sub").textContent = "최근 12개월 재정적자 합계 ÷ GDP(%) · 클수록 정부가 돈을 많이 풂 · 그 달에 발표돼 있던 값 기준";
      }
    }
    quadReadout(cur);
    Array.prototype.forEach.call(host.querySelectorAll("circle[data-hit]"), function (c) {
      c.addEventListener("mouseenter", function () { quadReadout(Number(c.getAttribute("data-hit"))); });
      c.addEventListener("click", function () { quadReadout(Number(c.getAttribute("data-hit"))); });
    });
    host.onmouseleave = function () { quadReadout(cur); };
  }
  function renderQuadRecord() {
    if (!Q || !Q.now) return;
    var row = function (x, cur) { return "<tr" + (cur ? ' class="cur"' : "") + '><td>' + esc(x.name) + (cur ? " (지금)" : "") + '</td><td class="num">' + (x.share === null ? "—" : fmt(x.share, 0) + "%") + '</td><td class="num">' + spct(x.mean) + '</td><td class="num">' + (x.neg === null ? "—" : fmt(x.neg, 0) + "%") + '</td><td class="num">' + (x.n || 0) + "</td></tr>"; };
    var head = function (t) { return '<tr><th scope="col">' + t + '</th><th scope="col" class="num">기간 비율</th><th scope="col" class="num">이후 1년 나스닥</th><th scope="col" class="num">손실 확률</th><th scope="col" class="num">개월 수</th></tr>'; };
    var nowPh = PH_NAME[String(Q.now.phase)];
    $("quad-table").innerHTML = "<thead>" + head("칸") + "</thead><tbody>" + Q.stats.map(function (x) { return row(x, x.name === Q.now.q); }).join("") + "</tbody>" +
      "<thead>" + head("기준금리 국면") + "</thead><tbody>" + Q.phaseStats.map(function (x) { return row(x, x.name === nowPh); }).join("") + "</tbody>" +
      "<thead>" + head("경기와 금리 조합") + "</thead><tbody>" + Q.combo.map(function (x) { return row(x, false); }).join("") + "</tbody>";
    $("quad-cases").innerHTML = "과거 사례: " + Q.cases.map(function (c) { return esc(ymKo(c.month)) + " <strong>" + esc(c.q || "자료 없음") + "</strong>" + (c.ret === null ? "" : "(이후 1년 " + spct(c.ret) + ")"); }).join(" · ");
    if (D.fiscal && D.fiscal.record.n) { var fr = D.fiscal.record, fe = $("quad-fiscal"); fe.hidden = false;
      fe.innerHTML = "정부 재정적자: 침체 경보가 켜진 " + fr.n + "번 가운데 <strong>" + fr.ok + "번</strong>은 \"적자가 GDP의 " + fmt(D.fiscal.cut, 1) + "%보다 크면 이후 1년 나스닥 상승, 작으면 하락\"과 방향이 같았습니다(아무것도 보지 않고 상승이라고만 답하면 " + fr.base + "번)." +
        (fr.miss.length ? " 어긋난 경보: " + fr.miss.map(function (m) { return esc(ymKo(m)); }).join(", ") + "." : "") + " 다만 같은 사이클에 몰린 경보가 많아 독립된 사례는 6번쯤이고, 기준값은 결과를 보고 고른 것이며, 재정적자는 최근으로 올수록 커졌습니다. 우연일 수 있습니다."; }
    $("quad-note").textContent = "기간은 " + monthStr(BT0).slice(0, 4) + "년부터. 수정된 최종 자료를 썼고 발표 시차를 반영하지 않았습니다. 칸마다 평균이 달라도 우연일 수 있으며, 주식을 사고팔 신호가 아닙니다. 유동성 점수에는 금리 지표(기준금리, 10년물)가 이미 들어 있습니다. 금리를 뺀 유동성 점수로 나눠도 같은 칸이었던 달은 " + (Q.agree === null ? "—" : fmt(Q.agree, 0)) + "%입니다.";
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-qrange]"), function (b) { b.addEventListener("click", function () { quadStop(true); state.quadRange = Number(b.getAttribute("data-qrange")); save(); renderQuad(); }); });
  $("quad-play").addEventListener("click", quadPlay);
  $("quad-seek").addEventListener("input", function () { quadStop(false); var v = Number(this.value); qCur = Q && Q.now && v >= Q.now.index ? null : v; renderQuad(); });
  if (Q && Q.now) { if (window.ResizeObserver) new ResizeObserver(function () { renderQuad(); }).observe($("quad-card")); else window.addEventListener("resize", renderQuad); }

  function renderAll() { renderBoard(); renderTiles(); renderNews(); renderList(); renderChart(); renderRecord(); renderQuad(); renderQuadRecord(); }

  // ---------- 이벤트 ----------
  $("list").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-toggle]");
    if (!b) return;
    var k = b.getAttribute("data-toggle"); state.open[k] = !state.open[k]; save(); renderList();
    var again = document.querySelector('button[data-toggle="' + k.replace(/"/g, '\\"') + '"]'); if (again) again.focus();
  });
  $("list").addEventListener("change", function (ev) {
    var id = ev.target.getAttribute && ev.target.getAttribute("data-ind");
    if (!id) return;
    if (ev.target.checked) state.checked[id] = true; else { delete state.checked[id]; delete state.hidden[id]; }
    save(); renderChart(); renderRecord();
  });
  $("chips").addEventListener("click", function (ev) {
    var eye = ev.target.closest("button[data-eye]"), go = ev.target.closest("button[data-go]");
    if (eye) {
      var id = eye.getAttribute("data-eye");
      if (state.hidden[id]) delete state.hidden[id]; else state.hidden[id] = true;
      save(); renderChart(); renderRecord();
      var again = document.querySelector('#chips button[data-eye="' + id.replace(/"/g, '\\"') + '"]'); if (again) again.focus();
    } else if (go) jumpTo(go.getAttribute("data-go"));
  });
  $("board").addEventListener("click", function (ev) {
    var go = ev.target.closest("button[data-go]"), tog = ev.target.closest("button[data-tog]"), all = ev.target.closest("button[data-all]");
    if (go) { jumpTo(go.getAttribute("data-go")); return; }
    if (tog) {
      var k = tog.getAttribute("data-tog"), cur = state.boardAll ? state.boardOpen[k] !== false : !!state.boardOpen[k];
      state.boardOpen[k] = !cur; save(); renderBoard();
      var again = document.querySelector('#board button[data-tog="' + k.replace(/"/g, '\\"') + '"]'); if (again) again.focus();
    } else if (all) { state.boardAll = !state.boardAll; state.boardOpen = {}; save(); renderBoard(); var b2 = document.querySelector("#board button[data-all]"); if (b2) b2.focus(); }
  });
  $("news").addEventListener("click", function (ev) { var b = ev.target.closest("button[data-go]"); if (b) jumpTo(b.getAttribute("data-go")); });
  $("btn-nasdaq").addEventListener("click", function () { state.chart = "nasdaq"; save(); renderChart(); renderRecord(); });
  $("btn-sp500").addEventListener("click", function () { if (!D.prices.sp500) return; state.chart = "sp500"; save(); renderChart(); renderRecord(); });
  $("btn-preset").addEventListener("click", function () { state.checked = {}; state.hidden = {}; standardLead.forEach(function (id) { state.checked[id] = true; }); save(); renderList(); renderChart(); renderRecord(); });
  $("btn-clear").addEventListener("click", function () { state.checked = {}; state.hidden = {}; save(); renderList(); renderChart(); renderRecord(); });

  // ---------- 지표 패널 열고 닫기 ----------
  // 넓은 화면: 옆에 붙은 패널이 접히고 펴진다. 좁은 화면: 오른쪽에서 밀려 나오는 서랍이 된다.
  var narrow = window.matchMedia ? window.matchMedia("(max-width: 1080px)") : { matches: false };
  var panelOpen = narrow.matches ? false : state.panelOpen !== false;
  function setPanel(open, focus) {
    panelOpen = open;
    document.body.classList.toggle("panel-closed", !open);
    Array.prototype.forEach.call(document.querySelectorAll("[data-panel-toggle]"), function (b) { b.setAttribute("aria-expanded", String(open)); });
    if (!narrow.matches) { state.panelOpen = open; save(); }
    if (focus) { if (open) $("btn-panel-close").focus(); else (narrow.matches ? $("btn-panel-fab") : $("btn-panel")).focus(); }
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-panel-toggle]"), function (b) { b.addEventListener("click", function () { setPanel(!panelOpen, narrow.matches); }); });
  $("backdrop").addEventListener("click", function () { setPanel(false, true); });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && panelOpen && narrow.matches) setPanel(false, true); });
  if (narrow.addEventListener) narrow.addEventListener("change", function () { setPanel(narrow.matches ? false : state.panelOpen !== false, false); });
  setPanel(panelOpen, false);

  $("asof").textContent = "기준 " + monthStr(LAST) + " · 자료 생성 " + D.generated.slice(0, 10);
  $("gen").textContent = "자료 생성 시각: " + D.generated.replace("T", " ").slice(0, 16) + " (UTC) · 설정 파일 버전 " + D.configVersion + " · 최근 한두 달은 일부 지표가 발표 전이라 직전 값을 이어 쓴 것입니다.";
  if (D.notes && D.notes.length) { $("notes-box").hidden = false; $("notes").innerHTML = D.notes.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join(""); }
  renderAll();
})();
