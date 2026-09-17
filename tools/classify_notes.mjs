/* 주관식 피드백 일괄 분류 — 자연어를 '숫자'가 아니라 '이유 코드'로 바꾼다.
 *
 * 왜 숫자가 아니라 분류인가 —
 *   "갑자기 신나는 노래가 나와서 깼어요" 를 −0.6 으로 바꾸면 "왜 −0.4 가 아니냐"에 답할 수 없다.
 *   이유 코드로 분류하면 근거가 "N명 중 M명" 이라는 횟수가 된다. 앱의 원칙과 같다:
 *   LLM 은 자연어→스키마 변환만 하고, 판단에 쓰는 값은 셀 수 있는 것만 쓴다.
 *
 * 분류 결과는 **팀의 알고리즘 수정 근거로만** 쓴다. 개인 취향 점수에는 넣지 않는다.
 *
 * 이유 코드는 index.html 의 MISFIT_REASONS 에서 읽는다(한 곳에서만 관리). 앱의 칩과 같은 표에 합산된다.
 *
 * ── 사용 ──────────────────────────────────────────────────────────────
 *   입력: CSV 또는 JSON. 최소한 글이 든 열 하나가 있으면 된다.
 *         · tools/export_notes.mjs 가 만든 notes.json (앱의 '한 줄 기록')
 *         · 구글 폼 응답 CSV (서술형 문항) — --col 로 열 이름을 지정
 *
 *   GEMINI_API_KEY=... node tools/classify_notes.mjs notes.json
 *   GEMINI_API_KEY=... node tools/classify_notes.mjs 설문응답.csv --col "불편했던 점을 자유롭게 적어주세요"
 *
 *   출력: <입력이름>.classified.csv  (id, text, primary, codes, reason)
 *         화면에 코드별 건수 요약
 *
 * ── 분류를 믿어도 되는지 검증 (발표용 근거) ─────────────────────────────
 *   1) 팀원이 30개쯤 직접 분류한다:  node tools/classify_notes.mjs notes.json --sample 30
 *      → notes.sample.csv 가 생긴다. human 열에 코드 하나를 적는다(아래 코드 목록, 해당 없으면 none).
 *        ※ Gemini 결과를 보기 전에 먼저 적을 것. 보고 나서 적으면 검증이 아니다.
 *   2) 대조:  node tools/classify_notes.mjs notes.json --validate notes.sample.csv
 *      → "30개 중 27개 일치" + 어긋난 문장 목록
 *
 *   옵션: --model gemini-...  (생략하면 앱과 같은 방식으로 사용 가능한 flash 모델을 자동 선택)
 *         --batch 10          (한 번 호출에 묶는 문장 수)
 *         --selftest          (네트워크 없이 파이프라인만 점검)
 *
 * ⚠️ 주관식 원문이 Google 서버로 전송된다. 이름·연락처가 적힌 응답은 입력 파일에서 먼저 지울 것.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://generativelanguage.googleapis.com/v1beta";

// ── 인자 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const valueFlags = new Set(["--col", "--validate", "--model", "--batch", "--sample", "--id-col"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1]));

// ── 이유 코드: index.html 의 MISFIT_REASONS 를 그대로 읽는다 ──────────────
function loadReasons() {
  const html = fs.readFileSync(path.join(HERE, "..", "index.html"), "utf8");
  const m = html.match(/const MISFIT_REASONS = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error("index.html 에서 MISFIT_REASONS 를 찾지 못했습니다.");
  const rows = [...m[1].matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)]
    .map((r) => ({ code: r[1], label: r[2], part: r[3] }));
  if (!rows.length) throw new Error("MISFIT_REASONS 가 비어 있습니다.");
  return rows;
}

// ── CSV (따옴표·줄바꿈 포함 필드 지원) ────────────────────────────────────
export function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = ""; rows.push(row); row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim());
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCSV = (rows, cols) => "\uFEFF" + [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";

function loadNotes(file, col, idCol) {
  const raw = fs.readFileSync(file, "utf8");
  const recs = file.toLowerCase().endsWith(".json") ? JSON.parse(raw) : parseCSV(raw);
  if (!Array.isArray(recs)) throw new Error("JSON 입력은 배열이어야 합니다.");
  const textKey = col || ["text", "note"].find((k) => recs[0] && k in recs[0]);
  if (!textKey || !(recs[0] && textKey in recs[0])) {
    throw new Error("글이 든 열을 찾지 못했습니다. --col \"열 이름\" 으로 지정하세요. 있는 열: " + Object.keys(recs[0] || {}).join(" | "));
  }
  const idKey = idCol || ["id", "event_id"].find((k) => recs[0] && k in recs[0]);
  return recs.map((r, i) => ({ id: String(idKey ? r[idKey] : i + 1), text: String(r[textKey] ?? "").trim() }))
             .filter((n) => n.text.length > 0);
}

// ── Gemini ──────────────────────────────────────────────────────────────
function buildPrompt(reasons, batch) {
  return [
    "너는 음악 추천 앱 사용자 의견을 분류하는 분류기다. 의견을 해석해 점수를 매기지 말고, 아래 코드 중에서 고르기만 하라.",
    "이 앱은 사용자의 '지금 기분'에서 '원하는 기분'으로 조금씩 옮겨 가도록 곡을 순서대로 추천한다.",
    "",
    "코드 목록:",
    ...reasons.map((r) => `- ${r.code}: ${r.label}`),
    "- none: 위 어느 것에도 해당하지 않음 (칭찬, 화면·로그인·재생 오류, 기능 요청, 의미 없는 글 포함)",
    "",
    "규칙:",
    "1) primary 에는 그 의견의 주된 불만 하나를 적는다. 불만이 없으면 none.",
    "2) codes 에는 해당하는 코드를 전부 적는다(primary 포함). none 이면 빈 배열.",
    "3) 글에 실제로 적힌 내용만 근거로 삼는다. 짐작으로 코드를 붙이지 않는다.",
    "4) reason 에는 그렇게 분류한 근거가 된 표현을 원문에서 짧게 인용한다.",
    "",
    'JSON 배열만 출력: [{"id":"...","primary":"코드","codes":["코드",...],"reason":"..."}]',
    "",
    "의견 목록:",
    JSON.stringify(batch.map((n) => ({ id: n.id, text: n.text }))),
  ].join("\n");
}

async function pickModel(key) {
  const r = await fetch(`${BASE}/models?pageSize=200&key=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error("모델 목록 조회 실패 HTTP " + r.status);
  const names = ((await r.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter((n) => /^gemini-\d/.test(n) && n.includes("flash"))
    .filter((n) => !/(image|tts|audio|live|thinking|robotics|embed)/.test(n));
  // 앱(index.html)과 같은 우선순위: 최신 버전 > lite > 정식판
  const score = (n) => {
    let s = parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0) * 100;
    if (n.includes("lite")) s += 30;
    if (/(preview|exp)/.test(n)) s -= 50;
    if (/-\d{2}-\d{2}$|-\d{3,}$/.test(n)) s -= 5;
    return s;
  };
  const sorted = [...new Set(names)].sort((a, b) => score(b) - score(a));
  if (!sorted.length) throw new Error("이 키로 쓸 수 있는 flash 모델이 없습니다.");
  return sorted[0];
}

async function callGemini(key, model, prompt) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },   // 0 = 같은 입력에 같은 분류
      }),
    });
    if (r.ok) {
      const data = await r.json();
      return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    }
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      const wait = 5000 * attempt;
      console.warn(`  HTTP ${r.status} — ${wait / 1000}초 뒤 재시도 (${attempt}/3)`);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    throw new Error(`Gemini 호출 실패 HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

/* 모델 응답을 그대로 믿지 않는다 — 허용된 코드만 통과시키고, 빠진 문장은 'error' 로 표시한다. */
export function sanitize(rawText, batch, allowed) {
  let arr;
  try { arr = JSON.parse(String(rawText).replace(/```json|```/g, "").trim()); } catch { arr = null; }
  const byId = new Map(Array.isArray(arr) ? arr.map((o) => [String(o?.id), o]) : []);
  return batch.map((n) => {
    const o = byId.get(n.id);
    if (!o) return { ...n, primary: "error", codes: "", reason: "모델 응답에 이 문장이 없음" };
    const codes = [...new Set((Array.isArray(o.codes) ? o.codes : []).map(String).filter((c) => allowed.has(c)))];
    let primary = allowed.has(String(o.primary)) ? String(o.primary) : "none";
    if (primary !== "none" && !codes.includes(primary)) codes.unshift(primary);
    if (primary === "none" && codes.length) primary = codes[0];
    return { ...n, primary, codes: codes.join("|"), reason: String(o.reason ?? "").slice(0, 200) };
  });
}

async function classifyAll(notes, reasons, responder, batchSize) {
  const allowed = new Set(reasons.map((r) => r.code));
  const out = [];
  for (let i = 0; i < notes.length; i += batchSize) {
    const batch = notes.slice(i, i + batchSize);
    process.stdout.write(`  분류 중 ${Math.min(i + batchSize, notes.length)}/${notes.length}\r`);
    out.push(...sanitize(await responder(buildPrompt(reasons, batch), batch), batch, allowed));
  }
  process.stdout.write("\n");
  return out;
}

function summarize(rows, reasons) {
  const n = rows.length;
  console.log(`\n주된 이유(primary) — 의견 ${n}건`);
  for (const r of [...reasons, { code: "none", label: "해당 없음", part: "—" }, { code: "error", label: "분류 실패", part: "—" }]) {
    const k = rows.filter((x) => x.primary === r.code).length;
    if (r.code === "error" && !k) continue;
    console.log(`  ${String(k).padStart(3)}건 ${(n ? (k / n * 100).toFixed(0) : 0).toString().padStart(3)}%  ${r.label}  → ${r.part}`);
  }
  const none = rows.filter((x) => x.primary === "none").length;
  if (n >= 10 && none / n > 0.4) console.log("\n  ※ '해당 없음'이 40%를 넘습니다. 원문을 읽어 보고 새 이유 칩이 필요한지 검토하세요.");
}

export function validate(rows, humanRows) {
  const human = new Map(humanRows.filter((h) => String(h.human ?? "").trim()).map((h) => [String(h.id), String(h.human).trim()]));
  const pairs = rows.filter((r) => human.has(r.id)).map((r) => ({ ...r, human: human.get(r.id) }));
  const agree = pairs.filter((p) => p.human === p.primary);
  return { n: pairs.length, agree: agree.length, misses: pairs.filter((p) => p.human !== p.primary) };
}

// ── 실행 ────────────────────────────────────────────────────────────────
async function main() {
  const reasons = loadReasons();

  if (flag("--selftest")) {
    const notes = [{ id: "1", text: "3번째 곡에서 갑자기 분위기가 확 바뀜" }, { id: "2", text: "좋았어요!" }, { id: "3", text: "랩이 너무 많아서 집중이 안 됨" }];
    const fake = async (_p, batch) => "```json\n" + JSON.stringify([
      { id: "1", primary: "path_jump", codes: ["path_jump"], reason: "갑자기 분위기가 확 바뀜" },
      { id: "2", primary: "praise", codes: ["made_up_code"], reason: "" },          // 허용되지 않은 코드 → none
      /* id 3 누락 → error */
    ]) + "\n```";
    const rows = await classifyAll(notes, reasons, fake, 10);
    const v = validate(rows, [{ id: "1", human: "path_jump" }, { id: "2", human: "none" }, { id: "3", human: "vocal_bother" }]);
    const ok = rows[0].primary === "path_jump" && rows[1].primary === "none" && rows[1].codes === "" && rows[2].primary === "error"
      && v.n === 3 && v.agree === 2 && parseCSV('id,text\n1,"a,""b""\nc"\n')[0].text === 'a,"b"\nc';
    console.log(ok ? "selftest 통과" : "selftest 실패", JSON.stringify(rows.map((r) => r.primary)), `${v.agree}/${v.n}`);
    process.exit(ok ? 0 : 1);
  }

  const file = positional[0];
  if (!file) { console.error("입력 파일을 지정하세요. 파일 맨 위 주석의 '사용'을 보세요."); process.exit(1); }
  const notes = loadNotes(file, opt("--col"), opt("--id-col"));
  const stem = file.replace(/\.(json|csv)$/i, "");
  console.log(`의견 ${notes.length}건 (${file})`);
  console.log("코드: " + reasons.map((r) => r.code).join(" · ") + " · none");

  if (opt("--sample")) {   // 사람이 먼저 분류할 표본 — 고정 간격 추출(다시 돌려도 같은 표본)
    const k = Math.min(Number(opt("--sample")) || 30, notes.length);
    const step = notes.length / k;
    const pick = Array.from({ length: k }, (_, i) => notes[Math.floor(i * step)]);
    const outFile = stem + ".sample.csv";
    fs.writeFileSync(outFile, toCSV(pick.map((n) => ({ ...n, human: "" })), ["id", "text", "human"]));
    console.log(`→ ${outFile} (${k}건). human 열에 코드 하나씩 적으세요: ${reasons.map((r) => r.code).join(" / ")} / none`);
    return;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error("환경변수 GEMINI_API_KEY 가 필요합니다 (Vercel 에 넣어 둔 것과 같은 키)."); process.exit(1); }
  const model = opt("--model") || await pickModel(key);
  console.log("모델: " + model);

  const rows = await classifyAll(notes, reasons, (prompt) => callGemini(key, model, prompt), Number(opt("--batch")) || 10);
  const outFile = stem + ".classified.csv";
  fs.writeFileSync(outFile, toCSV(rows, ["id", "text", "primary", "codes", "reason"]));
  console.log("→ " + outFile);
  summarize(rows, reasons);

  if (opt("--validate")) {
    const v = validate(rows, parseCSV(fs.readFileSync(opt("--validate"), "utf8")));
    console.log(`\n사람 분류와 대조: ${v.n}개 중 ${v.agree}개 일치 (${v.n ? (v.agree / v.n * 100).toFixed(0) : 0}%)  · 모델 ${model}`);
    for (const m of v.misses) console.log(`  ✗ [사람 ${m.human} / Gemini ${m.primary}] ${m.text.slice(0, 70)}`);
    if (v.n < 20) console.log("  ※ 대조 표본이 20개 미만입니다. 일치율을 근거로 쓰려면 30개 안팎을 권합니다.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
}
