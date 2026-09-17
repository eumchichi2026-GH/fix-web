/*
 * AZT 추천 알고리즘 v2.2 (JavaScript) — 앱 런타임용.
 *
 * 규칙(숫자)은 여기 없습니다 — rules/rules.compiled.json 에 있습니다.
 * (Python 검증기 engine.py 는 현재 저장소에 없습니다. 복구되면 이 파일과 같은 결과를 내야 합니다.)
 *
 *   1) 좌표 변환   원 V/A → 퍼센타일 좌표
 *   2) 하드 제약   게이트 / 싫어요 / 최근재생 / 아티스트 상한 / 걸음 상한 / 장르
 *   3) 영역 후보   waypoint 이웃 반경 (사분면 박스 아님)
 *   4) 두 레인     기하가 어디로 갈지, 선호가 동급 중 무엇을
 *   5) 빔 탐색     경로 전체 비용 최소화
 */

/* 엔진 코드 버전. 규칙(rules_hash)은 그대로인데 엔진 동작이 바뀌는 경우를 로그에서 구분한다.
   2.2.0 (2026-09-17): iso.min_step_span 구현, 영역 풀 걸음당 1회 계산, song_count 출력. */
export const ENGINE_VERSION = "2.2.0";

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
  let maxStep = Number(rules.iso.max_step_jump);
  const active = [];
  for (const m of rules.modulators || []) {
    const val = inputs[m.input];
    if (val === undefined || val === null) continue;
    if (m.applies_to === "iso.max_step_jump" && m.map) {
      const key = String(Math.trunc(Number(val)));
      if (key in m.map) maxStep = Number(m.map[key]);
    } else if (m.applies_to === "gates" && m.when_gte !== undefined) {
      if (Number(val) >= Number(m.when_gte)) active.push(m.adds_gate);
    }
  }
  return { maxStep, active };
}

// ── 선호 레인 ───────────────────────────────────────────
function shrunk(pos, neg, k, decay = 1) {
  const n = (pos + neg) * decay;
  if (n <= 0) return 0.5;
  const ratio = pos / (pos + neg);
  return (ratio * n + 0.5 * k) / (n + k);
}

function prefScore(song, rules, user) {
  const p = rules.preference;
  if (!p || !user) return 0.5;
  const w = p.weights;
  const pk = p.shrinkage.personal_k, gk = p.shrinkage.global_k;
  const hl = p.decay.half_life_days;
  const decayOf = (rec) => (hl ? Math.pow(0.5, Number(rec.last_days || 0) / hl) : 1);

  const sf = (user.song_feedback || {})[song.song_id];
  const personal = sf ? shrunk(sf.pos || 0, sf.neg || 0, pk, decayOf(sf)) : 0.5;

  const gs = (user.global_stats || {})[song.song_id];
  const glob = gs ? shrunk(gs.pos || 0, gs.neg || 0, gk) : 0.5;

  const af = (user.artist_affinity || {})[song.artist];
  const artist = af ? shrunk(af.pos || 0, af.neg || 0, pk, decayOf(af)) : 0.5;

  const ga = user.genre_affinity || {};
  const hits = (song.genres || []).filter((g) => g in ga)
    .map((g) => shrunk(ga[g].pos || 0, ga[g].neg || 0, pk, decayOf(ga[g])));
  const genre = hits.length ? Math.max(...hits) : 0.5;

  return w.personal_feedback * personal + w.liked_artist * artist
       + w.liked_genre * genre + w.global_feedback * glob;
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
function stepCandidates(pool, state, ctx, wp, tgtC, term, rules, inputs, maxStep, band, nExpand,
                       stepI = 0, seed = null, pbucket = 0) {
  /* pool = 이 걸음의 영역 후보. 같은 걸음의 빔 상태들은 경유지가 같아 영역 풀도 같으므로
     recommend() 가 걸음당 1회만 계산해 넘긴다 (결과 동일, 속도만 개선). */
  const cap = Number(rules.diversity.max_per_artist);

  let cands = [];
  for (const s of pool) {
    if (state.used.includes(s.song_id)) continue;
    if ((state.artistCount[s.artist] || 0) >= cap) continue;
    const c = ctx.coords.get(s.song_id);
    if (state.prev && dist(c, state.prev, term) > maxStep) continue;
    cands.push(s);
  }
  let relaxed = false;
  if (!cands.length) {   // 걸음 상한 완화. 반드시 기록에 남긴다.
    relaxed = true;
    cands = pool.filter((s) => !state.used.includes(s.song_id) && (state.artistCount[s.artist] || 0) < cap);
  }
  if (!cands.length) return { cands: [], bandSize: 0, relaxed: false };

  const scored = cands.map((s) => {
    const c = ctx.coords.get(s.song_id);
    const fit = R9(dist(c, wp, term));
    const prog = state.prev
      ? R9(Math.max(0, dist(c, tgtC, term) - dist(state.prev, tgtC, term)))
      : 0;
    const pref = prefScore(s, rules, inputs.user);
    return {
      song: s, fit, prog, pref,
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

  let { maxStep, active } = applyModulators(rules, inputs);
  maxStep *= Number((rules.iso.step_limit_scale || {})[rules.coordinate_space || "raw"] ?? 1.0);
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
  const fw = Number(rules.path.fit_weight), pw = Number(rules.path.progress_weight);
  const strategy = rules.search.strategy;
  const beamW = strategy === "beam" ? Number(rules.search.beam_width) : 1;
  const nExpand = strategy === "beam" ? Number(rules.search.expand_per_step) : 1;

  let beam = [{ used: [], artistCount: {}, prev: null, cost: 0, prefSum: 0, pbSum: 0, jitSum: 0, picks: [] }];

  for (let wi = 0; wi < wps.length; wi++) {
    const wp = wps[wi];
    const next = [];
    const stepPool = regionPool(universe, ctx, wp, term, rules);   // 걸음당 1회
    for (const st of beam) {
      const { cands, bandSize, relaxed } = stepCandidates(stepPool, st, ctx, wp, tgtC, term, rules, inputs, maxStep, band, nExpand, wi, seed, pbucket);
      for (const c of cands) {
        const s = c.song;
        const ac = { ...st.artistCount };
        ac[s.artist] = (ac[s.artist] || 0) + 1;
        next.push({
          used: [...st.used, s.song_id],
          artistCount: ac,
          prev: ctx.coords.get(s.song_id),
          cost: st.cost + fw * (c.band * band) + pw * c.prog,
          prefSum: st.prefSum + c.pref,
          pbSum: st.pbSum + c.pbucket,
          jitSum: st.jitSum + c.jitter,
          picks: [...st.picks, { song: s, fit: c.fit, pref: c.pref, bandSize, wp, pool: universe.length, relaxed, pbucket: c.pbucket, jitter: c.jitter }],
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
