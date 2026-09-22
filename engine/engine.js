/*
 * AZT 추천 알고리즘 v2.2 (JavaScript) — 앱 런타임용.
 *
 * 규칙(숫자)은 여기 없습니다 — rules/rules.compiled.json 에 있습니다.
 * (Python 검증기 engine.py 는 현재 저장소에 없습니다. 복구되면 이 파일과 같은 결과를 내야 합니다.)
 *
 *   1) 좌표 변환   원 V/A → 퍼센타일 좌표
 *   2) 하드 제약   게이트 / 싫어요 / 최근재생 / 아티스트 상한 / 장르
 *   3) 영역 후보   waypoint 이웃 반경 (사분면 박스 아님)
 *   4) 두 레인     기하가 어디로 갈지, 선호가 동급 중 무엇을 (2.5.0: μ>0 이면 선호도 비용에 직접 더해진다)
 *   5) 빔 탐색     경로 전체 비용 최소화
 */

/* 엔진 코드 버전. 규칙(rules_hash)은 그대로인데 엔진 동작이 바뀌는 경우를 로그에서 구분한다.
   2.2.0 (2026-09-17): iso.min_step_span 구현, 영역 풀 걸음당 1회 계산, song_count 출력.
   2.3.0 (2026-09-17): 개인화 재배선 — '들어본 곡 중 좋아요한 비율'을 가수·곡 특징 단위로 집계(aggregateAffinity),
                       선호 결합 방식 preference.combine = "mean_like_rate".
   2.4.0 (2026-09-21): (1) 스트레스 연동 최대 보폭 제약 제거 — inputs.stress·modulators.stress_step_limit·iso.max_step_jump·
                       iso.step_limit_scale·후보 제외 필터·완화 폴백. 실카탈로그 4,117곡 600 시나리오에서 발동 0.01회/세션, 제거해도 지표 동일.
                       (2) path.fit_weight 제거 — 균등 배율이라 결과 무관.
                       (3) 전환 비용(transition cost) 추가 — cost += path.jump_weight × 인접 곡 거리. λ=0.1 에서 최대 전환 거리 −13%.
                       근거: 2026-09-21 민감도 분석(파라미터 9개, one-at-a-time).
   2.5.0 (2026-09-22): 개인화 신호 4종 — (1) 완주·스킵을 표로 센다(items.completion·skipped, preference.implicit).
                       (2) 벽에 붙인 곡·가수(items.pinned)는 좋아요와 같은 무게로 세되 시간 감쇠하지 않는다.
                       (3) 가수 "A;B;C" 다중 표기를 쪼개 각 가수에 표를 준다(artistKeys). 협업곡 좋아요가 단독 가수로 넘어간다.
                       (4) 선호를 동률 깨기에서 비용 항으로 승격 — cost += preference.pref_weight(μ) × (내 중립점 − 선호 점수).
                           μ=0 이면 2.4.0 과 결과 동일(회귀 확인). μ 값은 스윕으로 정한다. */
export const ENGINE_VERSION = "2.5.0";

const R9 = (x) => Math.round(x * 1e9) / 1e9;
const R6 = (x) => Math.round(x * 1e6) / 1e6;

function bisectLeft(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function bisectRight(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

// ── 시드 난수 (engine.py 와 비트 단위로 동일해야 함) ────
const TE = new TextEncoder();
function fnv1a32(text) {
  let h = 2166136261;
  for (const b of TE.encode(text)) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function jitterOf(seed, songId, step) {
  if (!seed) return 0;
  let x = fnv1a32(`${seed}|${songId}|${step}`) || 0x9e3779b9;
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  return x / 4294967296;
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (!n) return 0;
  const m = Math.floor(n / 2);
  return n % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function percentile(values, p) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (!n) return 0;
  return v[Math.max(0, Math.min(n - 1, Math.ceil(p * n) - 1))];
}

function ecdf(sorted, x) {
  const n = sorted.length;
  if (!n) return 0.5;
  const lo = bisectLeft(sorted, x), hi = bisectRight(sorted, x);
  return (lo + (hi - lo) / 2) / n;
}

// ── 준비 ────────────────────────────────────────────────
function prepare(catalog, rules) {
  const sv = catalog.map((s) => Number(s.V)).sort((a, b) => a - b);
  const sa = catalog.map((s) => Number(s.A)).sort((a, b) => a - b);
  const pct = rules.coordinate_space === "percentile";

  const coords = new Map();
  for (const s of catalog) {
    const v = Number(s.V), a = Number(s.A);
    coords.set(s.song_id, pct ? [ecdf(sv, v), ecdf(sa, a)] : [v, a]);
  }

  const base = {};
  for (const [ax, spec] of Object.entries(rules.baselines)) {
    if (spec && typeof spec === "object" && "stat" in spec) {
      const i = ax === "V" ? 0 : 1;
      base[ax] = median(catalog.map((s) => coords.get(s.song_id)[i]));
    }
  }

  const th = {};
  for (const g of rules.gates) {
    if (g.op === "percentile_below") {
      const vals = catalog.map((s) => Number(s[g.field])).filter((x) => !Number.isNaN(x));
      th[g.id] = percentile(vals, g.value);
    }
  }
  return { sv, sa, pct, coords, base, th };
}

function toCoord(ctx, p) {
  return ctx.pct ? [ecdf(ctx.sv, Number(p.V)), ecdf(ctx.sa, Number(p.A))] : [Number(p.V), Number(p.A)];
}

function quadrantOf(c, ctx, rules) {
  for (const [name, cond] of Object.entries(rules.quadrants)) {
    const okV = cond.V === "above" ? c[0] >= ctx.base.V : c[0] < ctx.base.V;
    const okA = cond.A === "above" ? c[1] >= ctx.base.A : c[1] < ctx.base.A;
    if (okV && okA) return name;
  }
  return null;
}

function dist(c1, c2, term) {
  const dv = c1[0] - c2[0], da = c1[1] - c2[1];
  return Math.sqrt(term.axes.V * dv * dv + term.axes.A * da * da);
}

// ── 게이트 / 모듈레이터 ─────────────────────────────────
function passesGate(song, g, th) {
  const val = song[g.field];
  if (g.op === "percentile_below") return val === undefined || val === null || Number(val) < th[g.id];
  if (g.op === "is_true") return Boolean(val);
  if (g.op === "is_false") return !val;
  throw new Error(`unknown gate op: ${g.op}`);
}

function applyModulators(rules, inputs) {
  /* 2.4.0: 게이트 추가형 모듈레이터만 남는다. 스트레스→걸음 상한(max_step_jump) 사슬은
     후보가 이미 경유지 반경 안에서만 나오므로 결과를 바꾸지 않아 제거했다. */
  const active = [];
  for (const m of rules.modulators || []) {
    const val = inputs[m.input];
    if (val === undefined || val === null) continue;
    if (m.applies_to === "gates" && m.when_gte !== undefined) {
      if (Number(val) >= Number(m.when_gte)) active.push(m.adds_gate);
    }
  }
  return { active };
}

// ── 선호 레인 ───────────────────────────────────────────
/* (긍정 + prior·k) / (전체 + k) — "기록이 없으면 prior 에서 출발하고, 기록이 쌓일수록 실제 비율에 가까워진다."
   prior = 0.5, k = 2 이면 (좋아요 + 1) / (전체 + 2) : 라플라스의 계승 규칙.
   k = 2 는 '가상의 관측 2건'(라플라스 규칙에서 성공 1·실패 1 에 해당)의 무게를 뜻한다. */
function shrunk(pos, neg, k, decay = 1, prior = 0.5, pin = 0) {
  /* pin = 벽에 붙인 표(2.5.0). 감쇠하지 않는 '좋음' 표로, 좋아요와 같은 무게. */
  const n = (pos + neg) * decay + pin;
  if (n <= 0) return prior;
  return (pos * decay + pin + prior * k) / (n + k);
}

/* 가수 문자열 → 키 목록 (2.5.0). DB 의 artist 는 "A;B;C" 다중 표기가 있어 세미콜론으로 쪼갠다.
   키는 앱의 artistKeyOf 와 같은 식(공백 제거·소문자)이라 "IU"/"iu" 가 같은 묶음에 든다. */
export function artistKeys(artist) {
  return String(artist || "").split(/[;]/).map((a) => a.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
}

/* ── 곡 특징 구간 ─────────────────────────────────────────
   "이 곡을 좋아했다"를 "이런 곡을 좋아한다"로 넓히려면 곡을 몇 개의 묶음으로 나눠야 한다.
   연속값(말 비중·빠르기)은 **전체 카탈로그의 3분위**로 낮음/중간/높음 — 경계는 상수가 아니라
   카탈로그에서 계산하는 통계량이라, 곡이 늘어도 세 묶음의 크기가 같게 유지된다.
   3 은 '낮음'과 '높음'을 가르면서 가운데를 둘 수 있는 가장 작은 수다(묶음이 많을수록 묶음당 기록이 희박해진다).
   참/거짓 값(연주곡 여부)은 그대로 두 묶음.
   ⚠️ 반드시 '전체 카탈로그'로 만들 것. 장르·가사 조건으로 걸러낸 풀로 만들면 조건마다 경계가 달라져
      같은 좋아요가 다른 묶음으로 들어간다. */
const BIN_NAMES = { 2: ["low", "high"], 3: ["low", "mid", "high"] };
export function makeFeatureBinner(fullCatalog, rules) {
  const specs = (rules.preference && rules.preference.features) || [];
  const cuts = {};
  for (const f of specs) {
    if (f.bins === "boolean") continue;
    const vals = fullCatalog.map((s) => s[f.field]).filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
    const nb = Number(f.bins);
    cuts[f.id] = vals.length ? Array.from({ length: nb - 1 }, (_, i) => vals[Math.min(vals.length - 1, Math.floor(vals.length * (i + 1) / nb))]) : null;
  }
  const bin = (song) => {
    const out = {};
    for (const f of specs) {
      const v = song[f.field];
      if (f.bins === "boolean") { if (typeof v === "boolean") out[f.id] = v ? "yes" : "no"; continue; }
      if (typeof v !== "number" || !Number.isFinite(v) || !cuts[f.id]) continue;   // 값을 모르면 묶지 않는다(중간으로 치지 않는다)
      let i = 0; while (i < cuts[f.id].length && v >= cuts[f.id][i]) i++;
      out[f.id] = (BIN_NAMES[Number(f.bins)] || [])[i] ?? String(i);
    }
    return out;
  };
  bin.cuts = cuts;
  return bin;
}

/* ── 들은 곡·좋아요 → 가수·특징별 '좋아요 비율' 집계 ─────────
   items: 사용자가 **실제로 들어본 곡**(좋아요를 누를 수 있었던 곡) 한 곡당 하나.
     { song_id?, liked: bool, disliked?: bool, reason?: 싫어요 이유 코드|null,
       completion?: 0~1 완주율, skipped?: bool, pinned?: bool(벽에 붙임),
       artist?, genres?: [], feature_bins?: {id: bin}, days?: 경과일 }
   각 가수·특징 묶음마다 "들어본 곡 N개 중 좋아요한 곡 M개" 를 센다 (pos = M, neg = N − M).

   [2.5.0] 한 곡이 주는 표 (rules.preference.implicit):
     벽에 붙임(pinned)              → pin += pinned_weight (감쇠 없음, '내 평균'에는 안 셈)
     좋아요                          → pos 1
     싫어요                          → neg 1 (범위는 dislike_scope)
     일찍 넘김(skipped)              → neg skip_weight
     끝까지 들음(completion ≥ completion_min), 좋아요 없음 → pos completion_weight, neg 1 − completion_weight
     들었지만 아무 반응 없음         → neg 1 (2.4.0 과 같음)
   완주·스킵 값을 안 주면(옛 앱) 2.4.0 과 똑같이 센다.

   왜 '좋아요 수'가 아니라 '들은 것 중 비율'인가 —
     좋아요만 세면 흔한 묶음이 무조건 이긴다. 카탈로그의 90% 가 보컬곡이면 좋아요의 90% 도 보컬곡이라
     "보컬곡을 좋아한다"는 결론이 나오는데, 이건 취향이 아니라 기저율이다. 들은 곡 수로 나누면 사라진다.

   싫어요는 그 이유가 정한다 (rules.preference.dislike_scope):
     취향(not_my_taste·이유 없음) → 모든 묶음에서 '좋아하지 않음' 1건
     가사·목소리(vocal_bother)    → 말 비중·연주곡 여부에서만 1건, 나머지 묶음에서는 세지 않음
     경로·기분·반복               → 어느 묶음에서도 세지 않음 (그 곡의 가수·특징 탓이 아니다)
   반환: { like_base:{pos,neg}, song_likes, artist_affinity, genre_affinity, feature_affinity } */
export function aggregateAffinity(items, rules) {
  const scopeMap = (rules.preference && rules.preference.dislike_scope) || {};
  const featIds = ((rules.preference && rules.preference.features) || []).map((f) => f.id);
  const imp = (rules.preference && rules.preference.implicit) || {};
  const CW = Number(imp.completion_weight ?? 0.5), CMIN = Number(imp.completion_min ?? 0.8);
  const SW = Number(imp.skip_weight ?? 1), PW = Number(imp.pinned_weight ?? 1);
  const out = { like_base: { pos: 0, neg: 0 }, song_likes: {}, artist_affinity: {}, genre_affinity: {}, feature_affinity: {} };
  const vote = (table, key, v, days) => {
    const r = table[key] || (table[key] = { pos: 0, neg: 0, pin: 0, _d: 0 });
    r.pos += v.pos; r.neg += v.neg; r.pin += v.pin;
    r._d += (v.pos + v.neg) * (Number(days) || 0);   // 감쇠용 경과일은 감쇠 대상 표에만
  };
  const ALL = ["base", "song", "artist", "genre", "features"];
  for (const it of items || []) {
    const liked = !!it.liked && !it.disliked;
    let scope = ALL;
    if (it.disliked) {
      const key = it.reason && it.reason in scopeMap ? it.reason : "_no_reason";
      const sc = scopeMap[key] || [];
      /* 취향 전체를 가리키는 싫어요만 '내 평균'과 '이 곡' 에도 센다 */
      scope = sc.includes("artist") && sc.includes("features") ? ALL : sc;
    }
    /* 이 곡이 주는 표 */
    let v;
    if (it.pinned) v = { pos: 0, neg: 0, pin: PW };
    else if (liked) v = { pos: 1, neg: 0, pin: 0 };
    else if (it.disliked) v = { pos: 0, neg: 1, pin: 0 };
    else if (it.skipped) v = { pos: 0, neg: SW, pin: 0 };
    else if (Number(it.completion) >= CMIN) v = { pos: CW, neg: 1 - CW, pin: 0 };
    else v = { pos: 0, neg: 1, pin: 0 };
    const has = (x) => scope.includes(x);
    if (has("base") && !it.pinned) { out.like_base.pos += v.pos; out.like_base.neg += v.neg; }
    if (has("song") && it.song_id) vote(out.song_likes, it.song_id, v, it.days);
    if (has("artist") && it.artist) for (const k of artistKeys(it.artist)) vote(out.artist_affinity, k, v, it.days);
    if (has("genre")) for (const g of it.genres || []) vote(out.genre_affinity, g, v, it.days);
    for (const id of featIds) {
      const b = it.feature_bins && it.feature_bins[id];
      if (b !== undefined && (has("features") || has(id))) vote(out.feature_affinity, id + ":" + b, v, it.days);
    }
  }
  for (const table of [out.song_likes, out.artist_affinity, out.genre_affinity, out.feature_affinity])
    for (const r of Object.values(table)) { r.last_days = (r.pos + r.neg) ? r._d / (r.pos + r.neg) : 0; delete r._d; }
  return out;
}

const PREF_LABELS = { song: "이 곡", artist: "가수", genre: "장르" };

/* 내 평균 좋아요 비율 — 기록이 없는 묶음의 출발점. (좋아요 + 1) / (들은 곡 + 2). */
function likeBaseRate(user) {
  const b = (user && user.like_base) || {};
  const n = (b.pos || 0) + (b.neg || 0);
  return n > 0 ? ((b.pos || 0) + 1) / (n + 2) : null;
}

/* 선호 점수와 그 근거를 함께 돌려준다. { score, neutral(이 사용자의 중립점), basis:[{id, score}] } */
function prefDetail(song, rules, user) {
  const p = rules.preference;
  if (!p || !user) return { score: 0.5, neutral: 0.5, basis: [] };
  const pk = p.shrinkage.personal_k, gk = p.shrinkage.global_k;
  const hl = p.decay.half_life_days;
  const decayOf = (rec) => (hl ? Math.pow(0.5, Number(rec.last_days || 0) / hl) : 1);
  const gs = (user.global_stats || {})[song.song_id];
  const globalScore = gs && ((gs.pos || 0) + (gs.neg || 0)) > 0 ? shrunk(gs.pos || 0, gs.neg || 0, gk) : null;

  if (p.combine === "mean_like_rate") {
    /* 선호 점수 = 이 곡이 속한 묶음들(이 곡·가수·장르·각 특징)의 '내 좋아요 비율' 단순 평균.
       묶음 점수 = (그 묶음에서 좋아요한 곡 + 2·p0) / (그 묶음에서 들어본 곡 + 2),  p0 = 내 평균 좋아요 비율.
       기록이 없는 묶음은 p0 — "모르면 내 평균". 묶음 사이에 가중치를 두지 않는다: 어느 것이 더 중요한지
       정할 근거가 없고 사람마다 다를 수 있기 때문이다.
       들어본 곡이 하나도 없을 때만(콜드스타트) 전체 사용자 통계를 쓴다. 내 기록이 생기면 남의 평균은 쓰지 않는다. */
    /* [2.5.0] 들어본 곡이 없어도 벽에 붙인 게 있으면 개인화한다 — 중립점은 0.5. */
    const hasPins = Object.values(user.artist_affinity || {}).some((r) => r.pin > 0) || Object.values(user.song_likes || {}).some((r) => r.pin > 0);
    const p0 = likeBaseRate(user) ?? (hasPins ? 0.5 : null);
    if (p0 === null) return { score: globalScore ?? 0.5, neutral: 0.5, basis: [] };
    const basis = [];
    const sc = (rec) => shrunk(rec.pos || 0, rec.neg || 0, pk, decayOf(rec), p0, rec.pin || 0);
    const rate = (id, rec) => { basis.push({ id, score: rec ? sc(rec) : p0 }); };
    rate("song", (user.song_likes || {})[song.song_id]);
    if (song.artist) {   // "A;B;C" 는 가수별 점수 중 가장 높은 것 (장르와 같은 방식)
      const aa = user.artist_affinity || {};
      const recs = artistKeys(song.artist).map((k) => aa[k]).filter(Boolean);
      rate("artist", recs.length ? recs.reduce((a, b) => (sc(b) > sc(a) ? b : a)) : null);
    }
    if ((song.genres || []).length) {
      const ga = user.genre_affinity || {};
      const recs = song.genres.map((g) => ga[g]).filter(Boolean);
      rate("genre", recs.length ? recs.reduce((a, b) => (sc(b) > sc(a) ? b : a)) : null);
    }
    const fa = user.feature_affinity || {};
    for (const f of p.features || []) {
      const b = song.feature_bins && song.feature_bins[f.id];
      if (b !== undefined) rate(f.id, fa[f.id + ":" + b]);
    }
    return { score: basis.reduce((a, x) => a + x.score, 0) / basis.length, neutral: p0, basis };
  }

  /* 이전 방식(가중합) — 비교 실험용. preference.combine 을 "weighted" 로 두면 이 경로. */
  const w = p.weights;
  const sf = (user.song_feedback || {})[song.song_id];
  const af = (user.artist_affinity || {})[song.artist];
  const ga = user.genre_affinity || {};
  const hits = (song.genres || []).filter((g) => g in ga).map((g) => shrunk(ga[g].pos || 0, ga[g].neg || 0, pk, decayOf(ga[g])));
  const personal = sf ? shrunk(sf.pos || 0, sf.neg || 0, pk, decayOf(sf)) : 0.5;
  const artist = af ? shrunk(af.pos || 0, af.neg || 0, pk, decayOf(af)) : 0.5;
  const genre = hits.length ? Math.max(...hits) : 0.5;
  return { score: w.personal_feedback * personal + w.liked_artist * artist + w.liked_genre * genre + w.global_feedback * (globalScore ?? 0.5),
           neutral: 0.5, basis: [] };
}

function tiebreakKeys(song, rules) {
  const keys = [];
  for (const tb of rules.ranking.tiebreakers) {
    if (tb.type === "ordinal_map") {
      const i = tb.order.indexOf(song[tb.field]);
      keys.push(i === -1 ? tb.order.length : i);
    } else if (tb.type === "numeric") {
      const v = Number(song[tb.field] || 0);
      keys.push(tb.direction === "desc" ? -v : v);
    }
  }
  return keys;
}

function cmpKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === "string" || typeof y === "string") return String(x) < String(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// ── 후보 생성 ───────────────────────────────────────────
function eligibleUniverse(catalog, rules, ctx, inputs, gates) {
  const user = inputs.user || {};
  const disliked = new Set(user.disliked || []);
  const recent = new Set(rules.diversity.exclude_recent_played ? user.recent_played || [] : []);

  const uni = [];
  let blocked = 0;
  for (const s of catalog) {
    if (disliked.has(s.song_id) || recent.has(s.song_id)) { blocked++; continue; }
    if (!gates.every((g) => passesGate(s, g, ctx.th))) { blocked++; continue; }
    uni.push(s);
  }

  const want = new Set(inputs.genres || []);
  let genreApplied = false;
  if (want.size && rules.genre_policy?.mode === "hard_if_sufficient") {
    const sub = uni.filter((s) => (s.genres || []).some((g) => want.has(g)));
    if (sub.length >= inputs._n_songs) return { uni: sub, blocked, genreApplied: true };
  }
  return { uni, blocked, genreApplied };
}

function regionPool(universe, ctx, wp, term, rules) {
  const r = rules.selection.region;
  let radius = Number(r.radius);
  const minPool = Number(r.min_pool);
  let pool = [];
  for (let i = 0; i <= Number(r.max_grow); i++) {
    pool = universe.filter((s) => dist(ctx.coords.get(s.song_id), wp, term) <= radius);
    if (pool.length >= minPool) return pool;
    radius *= Number(r.grow_factor);
  }
  return pool.length ? pool : universe;
}

// ── ISO ─────────────────────────────────────────────────
function songCount(rules, durationMin) {
  const c = rules.iso.song_count;
  return Math.max(c.min, Math.min(c.max, Math.floor(durationMin / c.per_minutes)));
}
function transitionAt(rules, durationMin) {
  for (const row of rules.iso.transition_point) if (durationMin <= row.up_to) return Number(row.at);
  return Number(rules.iso.transition_point.at(-1).at);
}
function waypoints(nowC, tgtC, n, at) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 1 : at > 0 ? Math.min(1, k / (n - 1) / at) : 1;
    pts.push([nowC[0] + (tgtC[0] - nowC[0]) * t, nowC[1] + (tgtC[1] - nowC[1]) * t]);
  }
  return pts;
}

// ── 탐색 ────────────────────────────────────────────────
function stepCandidates(pool, state, ctx, wp, tgtC, term, rules, inputs, band, nExpand,
                       stepI = 0, seed = null, pbucket = 0) {
  /* pool = 이 걸음의 영역 후보. 같은 걸음의 빔 상태들은 경유지가 같아 영역 풀도 같으므로
     recommend() 가 걸음당 1회만 계산해 넘긴다 (결과 동일, 속도만 개선). */
  const cap = Number(rules.diversity.max_per_artist);

  let cands = [];
  for (const s of pool) {
    if (state.used.includes(s.song_id)) continue;
    if ((state.artistCount[s.artist] || 0) >= cap) continue;
    cands.push(s);
  }
  const relaxed = false;   // 걸음 상한이 없어졌으므로 항상 false. trace 호환용으로 한 버전 유지 후 제거 예정.
  if (!cands.length) return { cands: [], bandSize: 0, relaxed };

  const scored = cands.map((s) => {
    const c = ctx.coords.get(s.song_id);
    const fit = R9(dist(c, wp, term));
    const prog = state.prev
      ? R9(Math.max(0, dist(c, tgtC, term) - dist(state.prev, tgtC, term)))
      : 0;
    const jump = state.prev ? R9(dist(c, state.prev, term)) : 0;   // 인접 곡 전환 거리 (transition cost 대상)
    const pd = prefDetail(s, rules, inputs.user);
    const pref = pd.score;
    const pmarg = R9((pd.neutral ?? 0.5) - pref);   // 내 중립점 − 선호. 좋아하는 곡일수록 음수 → 비용 감소 (2.5.0 μ 항)
    return {
      song: s, fit, prog, jump, pref, pmarg, basis: pd.basis, neutral: pd.neutral,
      band: band > 0 ? Math.floor(fit / band) : 0,
      pbucket: pbucket > 0 ? Math.floor(R9(pref) / pbucket) : 0,
      jitter: R9(jitterOf(seed, s.song_id, stepI)),
    };
  });

  const bestBand = Math.min(...scored.map((x) => x.band));
  const bandSize = scored.filter((x) => x.band === bestBand).length;

  // 우선순위: 기하 밴드 > 선호 버킷 > 시드 변이 > 결정론적 동점처리
  scored.sort((a, b) =>
    cmpKeys([a.band, -a.pbucket, a.jitter, ...tiebreakKeys(a.song, rules), String(a.song.song_id)],
            [b.band, -b.pbucket, b.jitter, ...tiebreakKeys(b.song, rules), String(b.song.song_id)]));

  return { cands: scored.slice(0, nExpand), bandSize, relaxed };
}

export function renderExplanations(rules, trace) {
  const msgs = [];
  for (const e of rules.explanations || []) {
    if (e.when && trace[e.when.trace_key] !== e.when.equals) continue;
    let t = e.template;
    for (const b of e.binds) t = t.split(`{${b}}`).join(String(trace[b]));
    msgs.push(t);
  }
  return msgs;
}

export function recommend(catalog, rules, inputsIn) {
  const term = rules.ranking.terms[0];
  const ctx = prepare(catalog, rules);

  const dur = inputsIn.duration_min ?? 30;
  const nowC = toCoord(ctx, inputsIn.now), tgtC = toCoord(ctx, inputsIn.target);

  /* 경유 곡 수 = max(min, min(시간 기준, floor(여정거리 / min_step_span) + 1))
     지금·목표가 가까운데 곡을 많이 끼우면 한 걸음이 preference.band 보다 잘게 쪼개져
     순위가 곡을 구분하지 못하고, 경로가 좁은 덩어리 안을 맴돈다(rules 의 min_step_span_evidence).
     여정거리는 band 와 같은 작업 좌표계(coordinate_space)에서 잰다 — band 가 그 좌표계의 폭이기 때문. */
  const byTime = songCount(rules, dur);
  const journey = R9(dist(nowC, tgtC, term));
  const span = Number(rules.iso.min_step_span || 0);
  const byJourney = span > 0 ? Math.floor(journey / span) + 1 : byTime;
  const n = Math.max(Number(rules.iso.song_count.min), Math.min(byTime, byJourney));
  const songCountOut = { by_time: byTime, by_journey: byJourney, effective: n, journey: R6(journey) };
  const inputs = { ...inputsIn, _n_songs: n };

  const { active } = applyModulators(rules, inputs);
  const gateIds = new Set([...active, ...(inputs.gates || [])]);
  const gates = rules.gates.filter((g) => gateIds.has(g.id));
  const { uni: universe, blocked, genreApplied } = eligibleUniverse(catalog, rules, ctx, inputs, gates);

  const baseOut = {};
  for (const [k, v] of Object.entries(ctx.base)) baseOut[k] = R6(v);
  if (!universe.length) {
    return { rules_version: rules.rules_version, rules_hash: rules.rules_hash, engine_version: ENGINE_VERSION,
             baselines: baseOut, song_count: songCountOut, sequence: [] };
  }

  const wps = waypoints(nowC, tgtC, n, transitionAt(rules, dur));

  const band = Number(rules.preference.band);
  const varc = rules.variation || {};
  const seed = varc.enabled ? inputs[varc.seed_input || "seed"] ?? null : null;
  const pbucket = varc.enabled ? Number(varc.pref_bucket || 0) : 0;
  const pw = Number(rules.path.progress_weight);
  const jw = Number(rules.path.jump_weight || 0);   // 전환 비용 λ (2.4.0)
  const mu = Number(rules.preference.pref_weight || 0);   // 선호 비용 μ (2.5.0). 0 이면 동률 깨기만 (2.4.0 동일)
  const strategy = rules.search.strategy;
  const beamW = strategy === "beam" ? Number(rules.search.beam_width) : 1;
  const nExpand = strategy === "beam" ? Number(rules.search.expand_per_step) : 1;

  let beam = [{ used: [], artistCount: {}, prev: null, cost: 0, prefSum: 0, pbSum: 0, jitSum: 0, picks: [] }];

  for (let wi = 0; wi < wps.length; wi++) {
    const wp = wps[wi];
    const next = [];
    const stepPool = regionPool(universe, ctx, wp, term, rules);   // 걸음당 1회
    for (const st of beam) {
      const { cands, bandSize, relaxed } = stepCandidates(stepPool, st, ctx, wp, tgtC, term, rules, inputs, band, nExpand, wi, seed, pbucket);
      for (const c of cands) {
        const s = c.song;
        const ac = { ...st.artistCount };
        ac[s.artist] = (ac[s.artist] || 0) + 1;
        next.push({
          used: [...st.used, s.song_id],
          artistCount: ac,
          prev: ctx.coords.get(s.song_id),
          cost: st.cost + c.band * band + pw * c.prog + jw * c.jump + mu * c.pmarg,
          prefSum: st.prefSum + c.pref,
          pbSum: st.pbSum + c.pbucket,
          jitSum: st.jitSum + c.jitter,
          picks: [...st.picks, { song: s, fit: c.fit, pref: c.pref, basis: c.basis, neutral: c.neutral, bandSize, wp, pool: universe.length, relaxed, pbucket: c.pbucket, jitter: c.jitter }],
        });
      }
    }
    if (!next.length) break;
    next.sort((a, b) => cmpKeys([R9(a.cost), -a.pbSum, R9(a.jitSum), ...a.used],
                                [R9(b.cost), -b.pbSum, R9(b.jitSum), ...b.used]));
    beam = next.slice(0, beamW);
  }

  const best = beam[0];
  const out = best.picks.map((pk, i) => {
    const s = pk.song;
    const c = ctx.coords.get(s.song_id);
    const trace = {
      step_index: i + 1,
      step_total: best.picks.length,
      wp_V: R6(pk.wp[0]),
      wp_A: R6(pk.wp[1]),
      va_distance: R6(pk.fit),
      quadrant: quadrantOf(c, ctx, rules),
      gates_passed: gates.map((g) => g.id).sort(),
      gates_failed: blocked,
      band_size: pk.bandSize,
      pref_score: R6(pk.pref),
      /* 선호 점수가 어떤 기록에서 나왔는지 — 화면 설명과 사후 분석용.
         '닮았다'고 말하는 기준은 순위가 실제로 구분하는 폭(variation.pref_bucket)과 같다:
         이 사용자의 중립점(내 평균 좋아요 비율)보다 한 버킷 이상 높을 때만. 그보다 작은 차이는 순위를 바꾸지 못하므로 설명으로도 내세우지 않는다.
         pref_basis 에는 그만큼 높았던 항목만 적는다(예: "말 비중" — 세 특징을 전부 나열하지 않는다). */
      ...(() => {
        const pb = pbucket > 0 ? pbucket : 0.05;
        const neutral = pk.neutral ?? 0.5;
        const above = (v) => Math.floor(R9(v) / pb) > Math.floor(R9(neutral) / pb);
        const featLabel = Object.fromEntries(((rules.preference && rules.preference.features) || []).map((f) => [f.id, f.label || f.id]));
        const pos = (pk.basis || []).filter((x) => above(x.score)).map((x) => PREF_LABELS[x.id] || featLabel[x.id] || x.id);
        const match = above(pk.pref) && pos.length > 0;
        return { pref_basis: match ? pos.join("·") : null, pref_match: match };
      })(),
      chosen_by: pk.bandSize > 1 ? "preference" : "geometry",
      tiebreak_used: null,
      path_cost: R6(best.cost),
      coord_space: rules.coordinate_space ?? null,
      strategy,
      pool_size: pk.pool,
      step_relaxed: pk.relaxed,
      seed: seed ?? null,
      pref_bucket: pk.pbucket,
      jitter: R6(pk.jitter),
      artist: s.artist ?? null,
      /* wp_V/wp_A 는 작업 좌표계(coord_space)의 값이다. song_V/song_A 를 원좌표로만
         남기면 로그에서 두 점의 거리를 다시 계산할 때 좌표계가 섞여 틀린 값이 나온다
         (percentile 사용 시 0.280 vs 실제 0.126). wp_* 와 같은 공간의 값을 함께 남긴다.
         raw 좌표계에서는 두 쌍의 값이 동일하므로 기존 분석과 호환된다. */
      song_V: R6(c[0]),            // 작업 좌표계 — wp_V 와 짝
      song_A: R6(c[1]),            // 작업 좌표계 — wp_A 와 짝
      song_V_raw: Number(s.V),     // 원좌표 (카탈로그 값)
      song_A_raw: Number(s.A),
      va_source: s.va_source ?? null,
      rules_hash: rules.rules_hash,
    };
    return { song_id: s.song_id, trace, explanations: renderExplanations(rules, trace) };
  });

  return {
    rules_version: rules.rules_version,
    rules_hash: rules.rules_hash,
    engine_version: ENGINE_VERSION,
    baselines: baseOut,
    song_count: songCountOut,
    genre_restricted: genreApplied,
    relaxed_steps: best.picks.filter((p) => p.relaxed).length,
    sequence: out,
  };
}
