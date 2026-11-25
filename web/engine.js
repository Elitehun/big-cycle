// BIG CYCLE 계산 엔진: 화면(브라우저)과 데이터 생성 스크립트(Node)가 같은 계산을 쓰도록 한 파일에 둔다.
// 규칙의 근거: docs/design-spec.md 4장, 6장, 11장
(function (root) {
  "use strict";
  var E = {};

  // 별점 가중 평균. 그 시점에 점수가 있는 지표만 쓴다. 몇 개가 들어갔는지도 돌려준다.
  E.composite = function (inds, n) {
    var value = new Array(n).fill(null), used = new Array(n).fill(0);
    for (var i = 0; i < n; i++) {
      var s = 0, w = 0, k = 0;
      for (var j = 0; j < inds.length; j++) {
        var v = inds[j].score[i];
        if (v === null || v === undefined) continue;
        var wt = inds[j].stars || 1;
        s += wt * v; w += wt; k++;
      }
      if (k) { value[i] = s / w; used[i] = k; }
    }
    return { value: value, used: used, total: inds.length };
  };

  // 점수 배열을 신호 배열로: 기준 미만이 minMonths개월 연속이면 켜짐(true)
  E.toSignal = function (score, threshold, minMonths) {
    return score.map(function (v, i) {
      if (v === null || v === undefined) return null;
      for (var k = 0; k < minMonths; k++) { var p = score[i - k]; if (p === null || p === undefined || p >= threshold) return false; }
      return true;
    });
  };

  E.episodes = function (sig) {
    var eps = [], s = null;
    for (var i = 0; i < sig.length; i++) {
      if (sig[i] === true) { if (s === null) s = i; }
      else if (s !== null) { eps.push([s, i - 1]); s = null; }
    }
    if (s !== null) eps.push([s, sig.length - 1]);
    return eps;
  };

  // 침체 채점
  //  적중: 침체 시작 전 W개월 창과 겹치는 신호 구간이 있고, 그 구간이 직전 침체가 끝난 뒤에 시작됨
  //  오신호: 침체 밖에서 시작된 신호 구간인데, 구간이 이어지는 동안에도 시작 후 W개월 안에도 침체가 없었음
  //  선행 개월은 창(W)을 넘지 않게 자른다. 대상 침체는 창 시작 시점에 이미 점수가 있던 것만.
  E.recessionEval = function (sig, recs, bt0, W, lastIdx) {
    var eps = E.episodes(sig), eligible = 0, hits = 0, leads = [], missed = [];
    recs.forEach(function (rec, r) {
      var rs = rec[0];
      if (rs < bt0 || rs - W < 0 || sig[rs - W] === null || sig[rs - W] === undefined) return;
      eligible++;
      var prevEnd = r > 0 ? recs[r - 1][1] : -1;
      var ok = eps.filter(function (e) { return e[0] > prevEnd && e[0] < rs && e[1] >= rs - W; });
      if (ok.length) { hits++; leads.push(Math.min(rs - ok[ok.length - 1][0], W)); } else missed.push(rs);
    });
    var falseSignals = 0, counted = 0;
    eps.forEach(function (e) {
      var s = e[0], en = e[1];
      if (s < bt0 || s > lastIdx - W) return;
      if (recs.some(function (rec) { return s >= rec[0] && s <= rec[1]; })) return;
      counted++;
      if (!recs.some(function (rec) { return rec[0] > s && (rec[0] <= en + 1 || rec[0] <= s + W); })) falseSignals++;
    });
    var on = 0, tot = 0;
    for (var i = bt0; i <= lastIdx; i++) if (sig[i] !== null && sig[i] !== undefined) { tot++; if (sig[i]) on++; }
    return {
      eligible: eligible, hits: hits, missed: missed,
      avgLead: leads.length ? leads.reduce(function (a, b) { return a + b; }, 0) / leads.length : null,
      falseSignals: falseSignals, counted: counted, onShare: tot ? on / tot : null
    };
  };

  // 이후 H개월 수익률(연율)과 그 사이(최대 12개월) 최대 하락
  E.forward = function (px, H) {
    var n = px.length, ret = new Array(n).fill(null), dd = new Array(n).fill(null);
    for (var i = 0; i + H < n; i++) {
      if (px[i] === null || px[i + H] === null || px[i] === undefined || px[i + H] === undefined) continue;
      ret[i] = Math.pow(px[i + H] / px[i], 12 / H) - 1;
      var worst = 0;
      for (var k = 1; k <= Math.min(H, 12); k++) if (px[i + k] !== null && px[i + k] !== undefined) worst = Math.min(worst, px[i + k] / px[i] - 1);
      dd[i] = worst;
    }
    return { ret: ret, dd: dd };
  };

  E.fwdStats = function (mask, f, from, to) {
    var r = [], d = [];
    for (var i = from; i <= to; i++) if (mask(i) && f.ret[i] !== null) { r.push(f.ret[i]); d.push(f.dd[i]); }
    if (!r.length) return { n: 0, mean: null, neg: null, dd: null };
    var mean = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
    return { n: r.length, mean: mean(r), neg: r.filter(function (x) { return x < 0; }).length / r.length, dd: mean(d) };
  };

  // 방향: lookback개월 전보다 나아졌는가. confirm개월 연속 같은 쪽일 때만 바꾼다.
  E.direction = function (series, improvingWhenRising, lookback, confirm) {
    var n = series.length, raw = new Array(n).fill(null), out = new Array(n).fill(null), cur = null;
    for (var i = lookback; i < n; i++) {
      var a = series[i], b = series[i - lookback];
      if (a === null || b === null || a === undefined || b === undefined) continue;
      raw[i] = improvingWhenRising ? a - b >= 0 : a - b <= 0;
    }
    for (var j = 0; j < n; j++) {
      if (raw[j] !== null) {
        if (cur === null) cur = raw[j];
        else if (raw[j] !== cur) {
          var stable = true;
          for (var k = 1; k < confirm; k++) if (raw[j - k] !== raw[j]) stable = false;
          if (stable) cur = raw[j];
        }
      }
      out[j] = cur;
    }
    return out;
  };

  root.BCEngine = E;
})(typeof window !== "undefined" ? window : globalThis);
