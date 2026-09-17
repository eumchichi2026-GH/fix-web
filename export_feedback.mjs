/* 정성 피드백 내려받기 + 이유 칩 집계.
 *
 * 앱(브라우저)은 보안규칙 때문에 본인 기록만 읽을 수 있다. 전체 집계는 관리자 권한이 필요해서
 * 서비스 계정 키로 읽는다 — eumchichi-data 저장소에서 Firestore 업로드에 쓰는 것과 같은 키다.
 * ⚠️ 서비스 계정 JSON 은 절대 이 저장소에 커밋하지 말 것 (이 저장소는 public).
 *
 * 준비(한 번):  npm i firebase-admin
 * 실행:        GOOGLE_APPLICATION_CREDENTIALS=/경로/serviceAccount.json node tools/export_feedback.mjs
 *              옵션  --since 2026-09-17   이 날짜(포함) 이후 기록만
 *                    --out feedback        출력 파일 이름 앞부분 (기본 feedback)
 *
 * 출력:  feedback.notes.json   주관식 원문 [{id, text, change, reasons, created_at}]  → tools/classify_notes.mjs 의 입력
 *        feedback.reasons.csv  이유 칩 원자료 (세션 단위 + 곡 단위)
 *        화면에 이유별 건수 요약
 *
 * user_id 는 내보내지 않는다 — 집계에 필요 없고, 주관식 원문과 계정을 한 파일에 묶지 않기 위해서다.
 * 사람 수는 '서로 다른 사용자 수'로만 센다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };

function loadReasons() {
  const html = fs.readFileSync(path.join(HERE, "..", "index.html"), "utf8");
  const m = html.match(/const MISFIT_REASONS = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error("index.html 에서 MISFIT_REASONS 를 찾지 못했습니다.");
  return [...m[1].matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)].map((r) => ({ code: r[1], label: r[2], part: r[3] }));
}

/* 이벤트 배열 → 집계. Firestore 와 분리해 둬서 네트워크 없이 검증할 수 있다.
   events: [{id, type, user_id, payload, created_at(ISO 문자열|null)}] */
export function tally(events, reasons) {
  const notes = [], rows = [];
  const sessionUsers = new Set(), sessionN = { total: 0 };
  const by = Object.fromEntries(reasons.map((r) => [r.code, { session: 0, sessionUsers: new Set(), song: 0, songUsers: new Set() }]));
  for (const e of events) {
    const p = e.payload || {};
    if (e.type === "post_change") {
      if (!Array.isArray(p.misfit_reasons)) continue;          // 정성 피드백 도입 이전 기록
      sessionN.total++; sessionUsers.add(e.user_id);
      for (const c of p.misfit_reasons) if (by[c]) {
        by[c].session++; by[c].sessionUsers.add(e.user_id);
        rows.push({ level: "session", code: c, song_id: "", position: "", change: p.change ?? "", created_at: e.created_at || "" });
      }
      if (typeof p.note === "string" && p.note.trim())
        notes.push({ id: e.id, text: p.note.trim(), change: p.change ?? null, reasons: p.misfit_reasons, created_at: e.created_at || null });
    } else if (e.type === "dislike_reason" && by[p.reason]) {
      by[p.reason].song++; by[p.reason].songUsers.add(e.user_id);
      rows.push({ level: "song", code: p.reason, song_id: p.song_id || "", position: p.position ?? "", change: "", created_at: e.created_at || "" });
    }
  }
  return { notes, rows, by, sessions: sessionN.total, sessionUsers: sessionUsers.size };
}

export function printSummary(t, reasons) {
  console.log(`\n세션 단위 응답 ${t.sessions}건 (서로 다른 사용자 ${t.sessionUsers}명) · 주관식 ${t.notes.length}건`);
  console.log("  세션(건/명)   곡 싫어요(건/명)   이유  → 가리키는 부품");
  for (const r of reasons) {
    const b = t.by[r.code];
    console.log(`  ${String(b.session).padStart(4)} / ${String(b.sessionUsers.size).padEnd(4)}  ${String(b.song).padStart(6)} / ${String(b.songUsers.size).padEnd(6)}   ${r.label}  → ${r.part}`);
  }
  console.log("\n  ※ 근거로 인용할 때는 '건'이 아니라 '명'을 쓰세요 — 한 사람이 여러 번 응답할 수 있습니다.");
}

async function main() {
  const reasons = loadReasons();
  let admin;
  try { admin = (await import("firebase-admin")).default; }
  catch { console.error("firebase-admin 이 없습니다. 먼저 `npm i firebase-admin` 을 실행하세요."); process.exit(1); }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("환경변수 GOOGLE_APPLICATION_CREDENTIALS 에 서비스 계정 JSON 경로를 넣으세요."); process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const since = opt("--since") ? new Date(opt("--since") + "T00:00:00+09:00") : null;
  const events = [];
  for (const type of ["post_change", "dislike_reason"]) {
    const snap = await db.collection("context_events").where("type", "==", type).get();   // 단일 필드 조건 — 복합 색인 불필요
    snap.forEach((d) => {
      const x = d.data();
      const at = x.created_at && typeof x.created_at.toDate === "function" ? x.created_at.toDate() : null;
      if (since && (!at || at < since)) return;
      events.push({ id: d.id, type: x.type, user_id: x.user_id, payload: x.payload, created_at: at ? at.toISOString() : null });
    });
  }
  const t = tally(events, reasons);
  const out = opt("--out", "feedback");
  fs.writeFileSync(out + ".notes.json", JSON.stringify(t.notes, null, 2));
  const cols = ["level", "code", "song_id", "position", "change", "created_at"];
  fs.writeFileSync(out + ".reasons.csv", "\uFEFF" + [cols.join(","), ...t.rows.map((r) => cols.map((c) => r[c]).join(","))].join("\n") + "\n");
  console.log(`→ ${out}.notes.json (${t.notes.length}건) · ${out}.reasons.csv (${t.rows.length}행)`);
  printSummary(t, reasons);
  if (t.notes.length) console.log(`\n다음: GEMINI_API_KEY=... node tools/classify_notes.mjs ${out}.notes.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("오류:", e.message); process.exit(1); });
}
