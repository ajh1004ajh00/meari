"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SR = 16000;
const BUSY = { recording: t("녹음 중"), transcribing: t("받아쓰는 중"), speakers: t("화자별 원고 만드는 중"), summarizing: t("요약 노트 만드는 중"),
  translating: t("영어로 번역하는 중"), studying: t("복습 자료 만드는 중"), waiting: t("엔진 켜는 중(약 3분) — 켜지면 이어서 정리해요") };
const RM = matchMedia("(prefers-reduced-motion: reduce)");
const TAU = Math.PI * 2;
let engineOn = false, current = null, data = null, pollTimer = null, rec = null, editMode = false, viewing = null;
let items = [], lens = null, docTab = "summary", noteMode = "note", finWatch = false, engineTimer = 0;

const store = {
  get(k, d) { try { return localStorage.getItem("meari." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("meari." + k, v); } catch {} },
};
const canTab = !!navigator.mediaDevices?.getDisplayMedia;
const S = { source: store.get("source", "mic"), translate: store.get("translate", "0") === "1" };
if (!canTab || !["mic", "tab", "both"].includes(S.source)) S.source = "mic";

// every request carries X-SoriNote: 1 (the server rejects writes without it)
const api = async (path, opts = {}) => {
  const r = await fetch("/api" + path, { ...opts, headers: { ...(opts.headers || {}), "X-SoriNote": "1", "X-Meari-Lang": LANG } });  // summary/quiz/answer language
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
};
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const fmt = (t) => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60); return (h ? h + ":" : "") + pad(m) + ":" + pad(t % 60); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isBusy = (m) => BUSY[m.status] && m.status !== "recording";
const ic = (id, cls = "s") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const PING = '<span class="ping"><i></i></span>';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
const when = (ts, o) => new Date(ts * 1000).toLocaleString(LOCALE, o);
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// markdown → sections; "한 줄 요약" becomes the lead, tasks/exams get the amber box
function md(src) {
  const out = []; let list = false, sec = false;
  const close = () => { if (list) { out.push("</ul>"); list = false; } };
  for (const raw of (src || "").split("\n")) {
    const l = esc(raw).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    const li = l.match(/^\s*[-*•]\s+(.*)/);
    if (li) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${li[1]}</li>`); continue; }
    close();
    const h = l.match(/^(#{1,3})\s+(.*)/);
    if (h && h[1].length < 3) {
      if (sec) out.push("</section>");
      const cls = /한\s*줄|one-line/i.test(h[2]) ? "sec--key" : /할 일|질문거리|과제|시험|공지|to-do|open question|assignment|exam/i.test(h[2]) ? "sec--exam" : "";
      out.push(`<section class="${cls}"><h2>${h[2]}</h2>`); sec = true;
    } else if (h) out.push(`<h3>${h[2]}</h3>`);
    else if (l.trim() && !l.startsWith("&lt;!--")) out.push(`<p>${l}</p>`);
  }
  close(); if (sec) out.push("</section>");
  return out.join("");
}

// ---------------------------------------------------------------- toast · dialog
function toast(msg, err) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " is-err" : "");
  el.innerHTML = ic(err ? "alert" : "check") + `<span>${esc(msg)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("is-out"); setTimeout(() => el.remove(), 300); }, err ? 5200 : 2800);
}
const fail = (e) => toast(tMsg(e?.message || String(e)), true);
function confirmDlg(title, body, ok) {
  const d = $("#dlg");
  $("#dlgT").textContent = title; $("#dlgP").textContent = body; $("#dlgOk").textContent = ok;
  d.returnValue = "";
  return new Promise((res) => { d.onclose = () => res(d.returnValue === "yes"); d.showModal(); });
}

// ---------------------------------------------------------------- engine
let engineState = "boot";
async function checkEngine() {
  let st = { state: "starting" };
  try { st = await api("/status"); } catch {}
  if (st.boot_s && st.boot_s < 60) useFastBoot(BUSY);
  engineOn = st.state === "ready";
  engineState = st.state === "ready" ? "on" : st.state === "off" ? "off" : "boot";
  document.body.dataset.engine = engineState;
  const T = { on: [t("엔진 준비됨"), t("Nemotron · 이 PC 안에서만"), t("준비됨")],
    boot: [t("엔진 켜는 중… (약 3분)"), t("녹음은 지금 바로 할 수 있어요"), t("켜는 중")],
    off: [t("엔진 꺼짐 · GPU 비워 둠"), t("녹음하면 자동으로 켜져요 (약 3분)"), t("꺼짐")] }[engineState];
  $("#engineText").textContent = T[0];
  $("#engineMeta").textContent = st.backlog ? t("밀린 받아쓰기 {n}개 · 켜지면 처리해요", { n: st.backlog }) : T[1].replace(/\((약|~) /, "($1 ");  // keep "(약 20초)" on one line
  $$("[data-engine-short]").forEach((e) => (e.textContent = T[2]));
  const b = $("#engineBtn");
  b.textContent = engineState === "off" ? t("엔진 켜기") : t("엔진 끄기"); b.disabled = engineState === "boot";
  $("#engineIdle").textContent = engineState === "on" && st.idle_left_s != null
    ? (st.idle_left_s > 60 ? t("안 쓰면 {n}분 뒤 자동으로 꺼져요", { n: Math.ceil(st.idle_left_s / 60) }) : t("곧 자동으로 꺼져요")) : "";
}
$("#engineBtn").onclick = async () => {
  try {
    if (engineState === "off") { await api("/engine/start", { method: "POST" }); toast(t("엔진을 켜는 중이에요 (약 3분)")); }
    else { await api("/engine/stop", { method: "POST" }); toast(t("엔진을 껐어요. GPU 메모리를 비웠어요")); }
  } catch (e) { fail(e); }
  checkEngine();
};
$("#shutdownBtn").onclick = async () => {
  if (rec) return toast(t("녹음을 먼저 멈춰 주세요."), true);
  if (!await confirmDlg(t("메아리를 모두 끌까요?"), t("엔진과 앱을 끄고 GPU 메모리(약 42GB)를 비워요. 노트는 그대로 남아요. 다시 쓰려면 바탕화면 메아리(Ctrl+Alt+M)를 누르세요. GPU만 비우려면 '엔진 끄기'를 쓰세요."), t("모두 끄기"))) return;
  try { await api("/shutdown", { method: "POST" }); } catch {}
  clearInterval(engineTimer); clearTimeout(pollTimer); lakeStop(); stageStop();
  document.body.innerHTML = `<div class='off'><img class='mark' src='icon.svg' alt=''><h1>${t("메아리를 껐어요")}</h1><p>${t("GPU 메모리를 비웠어요. 이 창을 닫아도 됩니다.")}</p></div>`;
  if (window.meariDesktop) setTimeout(() => location.assign("/__meari_quit"), 1500); // desktop app: the app catches this and exits
};

// ---------------------------------------------------------------- views
function setView(v) {
  document.body.dataset.view = v;
  $("#empty").hidden = v !== "home"; $("#note").hidden = v !== "note"; $("#recView").hidden = v !== "rec";
  setMenu(false);
  lakeSync(); stageSync();
  if (v === "note") requestAnimationFrame(drawNoteTl);
}
function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  $("#menuBtn").setAttribute("aria-expanded", open);
}
$("#menuBtn").onclick = () => setMenu(!document.body.classList.contains("menu-open"));

function goHome() {
  if (rec) return toast(t("녹음 중에는 홈으로 갈 수 없어요."), true);
  current = null; data = null; finWatch = false; clearTimeout(pollTimer); resetAudio(); P.dataset.key = "";
  setView("home");
  loadList().catch(fail);
}

// ---------------------------------------------------------------- list, home & search
async function loadList() {
  if ($("#search").value.trim()) return runSearch();
  items = await api("/sessions");
  if ($("#search").value.trim()) return;
  renderSide(); renderHome();
}

function groupName(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  return days <= 0 ? t("오늘") : days === 1 ? t("어제") : days < 7 ? t("이번 주") : d.toLocaleDateString(LOCALE, { year: "numeric", month: "long" });
}
function sideStatus(m) {
  if (isBusy(m)) return `<span class="nrow__m is-busy">${BUSY[m.status]}${m.progress != null ? " " + m.progress + "%" : ""}</span>`;
  if (m.status === "error") return `<span class="nrow__m is-err">${t("오류")}</span>`;
  return `<span class="nrow__m">${fmt(m.duration || 0)}</span>`;
}
function renderSide() {
  $("#listLabel").textContent = t("노트"); $("#noteCount").textContent = items.length || "";
  if (!items.length) { $("#list").innerHTML = `<div class="notes__empty"><b>${t("아직 노트가 없어요")}</b>${t("첫 녹음을 마치면 여기에 날짜순으로 쌓여요.")}</div>`; return; }
  let g = "", h = "";
  for (const m of items) {
    const gn = groupName(m.created);
    if (gn !== g) { g = gn; h += `<div class="ngroup">${g}</div>`; }
    h += `<button class="nrow" data-id="${m.id}"${m.id === current ? ' aria-current="true"' : ""}><span class="nrow__t">${esc(m.title)}</span>` +
      `<span class="nrow__m">${when(m.created, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>${sideStatus(m)}</button>`;
  }
  $("#list").innerHTML = h;
}

// every note gets its own fingerprint, seeded by its id
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function fp(id) {
  const r = mulberry(parseInt(id.slice(0, 8), 16) || 7); let s = '<svg class="fp" viewBox="0 0 84 28" aria-hidden="true">', e = .5;
  for (let i = 0; i < 28; i++) {
    e = clamp(e + (r() - .5) * .7, .14, 1);
    const h = Math.max(2, Math.round(e * (r() < .12 ? .22 : 1) * 26));
    s += `<rect x="${i * 3}" y="${(28 - h) / 2}" width="2" height="${h}" rx="1" fill="currentColor"/>`;
  }
  return s + "</svg>";
}
function renderHome() {
  const none = !items.length;
  $("#first").hidden = !none; $("#homeNotes").hidden = none;
  lakeSync();
  if (none) return;
  $("#recentCount").textContent = items.length;
  $("#recent").innerHTML = items.slice(0, 12).map((m) => {
    const busy = isBusy(m), err = m.status === "error";
    const sub = busy ? `<span class="row__s is-busy">${PING}<span>${BUSY[m.status]}${m.progress != null ? ` <span class="num">${m.progress}%</span>` : ""}</span>${m.progress != null ? `<span class="prog"><i style="width:${m.progress}%"></i></span>` : ""}</span>`
      : err ? `<span class="row__s is-err">${ic("alert")}<span>${esc(tMsg(m.error) || t("오류"))}</span></span>`
      : `<span class="row__s">${esc(m.source ? t("파일 · {s}", { s: m.source }) : m.terms ? t("용어 · {s}", { s: m.terms }) : m.duration ? t("녹음") : t("아직 녹음하지 않았어요"))}</span>`;
    return `<button class="row${busy ? " is-busy" : ""}${err ? " is-err" : ""}" data-id="${m.id}">${fp(m.id)}<span class="row__main"><span class="row__t">${esc(m.title)}</span>${sub}</span>` +
      `<span class="row__d">${fmt(m.duration || 0)}</span><span class="row__w">${when(m.created, { month: "numeric", day: "numeric", weekday: "short" })}<br>${when(m.created, { hour: "2-digit", minute: "2-digit" })}</span></button>`;
  }).join("");
  // last 7 days
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() - 6 + i); return { d, s: 0 }; });
  let total = 0, n = 0;
  for (const m of items) {
    const k = Math.floor((m.created * 1000 - days[0].d) / 864e5);
    if (k >= 0 && k < 7) { days[k].s += m.duration || 0; total += m.duration || 0; n++; }
  }
  const max = Math.max(1, ...days.map((x) => x.s));
  $("#weekCard").innerHTML = `<div class="card__l"><span>${t("최근 7일")}</span><span class="num">${when(days[0].d / 1000, { month: "numeric", day: "numeric" })} – ${when(today / 1000, { month: "numeric", day: "numeric" })}</span></div>` +
    `<p class="stat">${fmt(total)}<small>${n ? t("노트 {n}개를 녹음했어요", { n }) : t("이번 주에는 아직 녹음이 없어요")}</small></p>` +
    `<div class="bars" aria-hidden="true">${days.map((x, i) => `<div${i === 6 ? ' class="is-today"' : ""}><i style="height:${(x.s / max * 100).toFixed(0)}%"></i><span>${x.d.toLocaleDateString(LOCALE, { weekday: LANG === "en" ? "narrow" : "short" })}</span></div>`).join("")}</div>`;
}

let searchTimer, hits = [];
$("#search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch().catch(fail), 250); };
async function runSearch() {
  const q = $("#search").value.trim();
  if (!q) return loadList();
  const res = await api("/search?q=" + encodeURIComponent(q));
  if ($("#search").value.trim() !== q) return;  // a newer query is on its way
  hits = res;
  const re = new RegExp(escRe(esc(q)), "gi");
  const hl = (t) => esc(t).replace(re, (m) => `<mark>${m}</mark>`);
  $("#listLabel").textContent = t("검색 결과"); $("#noteCount").textContent = hits.length;
  $("#list").innerHTML = hits.map((h, i) => `<button class="nrow" data-hit="${i}"><span class="nrow__t">${esc(h.title)}</span>` +
    `<span class="nrow__m">${esc(tWhere(h.where))}${h.start != null ? " · " + fmt(h.start) : ""}</span><span></span><span class="nrow__snip">${hl(h.text)}</span></button>`).join("") ||
    `<div class="notes__empty"><b>${t("검색 결과가 없어요")}</b>${t("제목·원고·요약·번역·자료에서 찾아요.")}</div>`;
}
async function openHit(h) {
  await openNote(h.id);
  if (current !== h.id || !data) return;
  setMode("note");
  const w = h.where;
  if (w === "원고") { setLens("live"); if (h.start != null) jumpTo(h.start); }
  else if (w === "화자별 원고") setLens("final");
  else if (w === "요약") setDoc("summary");
  else if (w === "번역") setDoc("translation");
  else if (w.startsWith("자료")) {
    const mm = w.match(/^자료 (.*) p\.(\d+)$/), mat = mm && data.materials.find((x) => x.name === mm[1]);
    setDoc("materials"); if (mat) openMaterial(mat.id, +mm[2], true);
  }
}
$("#list").onclick = (e) => {
  const b = e.target.closest(".nrow"); if (!b) return;
  if (b.dataset.hit != null) openHit(hits[+b.dataset.hit]).catch(fail); else openNote(b.dataset.id).catch(fail);
};
$("#recent").onclick = (e) => { const b = e.target.closest(".row"); if (b) openNote(b.dataset.id).catch(fail); };

// ---------------------------------------------------------------- note
async function openNote(id) {
  if (rec && id !== current) return toast(t("녹음 중에는 다른 노트로 옮길 수 없어요."), true);
  if (id !== current) {
    viewing = null; editMode = false; lens = null; docTab = "summary"; noteMode = "note"; finWatch = false;
    segKey = finKey = studyKey = ""; dens = null; resetAudio(); P.dataset.key = "";
    $("#viewer").innerHTML = ""; $("#viewer").dataset.key = "";
    $("#summary").hidden = false; $("#summaryEditor").hidden = true;
  }
  current = id;
  setView("note"); applyMode(); setDoc(docTab); applyEdit();
  try { await refresh(); } catch (e) { fail(e); if (current === id && !data) goHome(); return; }
  loadList().catch(() => {});
}

async function refresh() {
  if (!current) return;
  const id = current, d = await api(`/sessions/${id}`);
  if (id !== current) return;
  data = d;
  const m = d.meta, hasAudio = m.duration > 0;
  if (document.activeElement !== $("#title")) $("#title").value = m.title;
  if (document.activeElement !== $("#recTitle")) $("#recTitle").value = m.title;
  if (document.activeElement !== $("#terms")) $("#terms").value = m.terms || "";
  $("#exportBtn").href = `/api/sessions/${id}/export.md?lang=${LANG}`;
  $("#recorder").hidden = hasAudio || !!rec;
  $("#playerBar").hidden = !hasAudio || !!rec;
  if (hasAudio && !rec) {
    if (P.dataset.key !== id + ":" + m.duration) { resetAudio(); P.dataset.key = id + ":" + m.duration; }
    $("#pDur").textContent = fmt(m.duration); $("#noteTl").setAttribute("aria-valuemax", Math.round(m.duration));
  }
  const err = $("#noteErr");
  err.hidden = m.status !== "error";
  if (!err.hidden) err.innerHTML = ic("alert") + `<span>${esc(t("오류: {e}", { e: tMsg(m.error) }))}</span>`;
  const spk = d.final ? new Set(d.final.paragraphs.map((x) => x.speaker)).size : 0;
  $("#nmeta").textContent = when(m.created, { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit" }) +
    ` · ${fmt(m.duration)}${spk ? t(" · 화자 {n}", { n: spk }) : ""}${d.materials.length ? t(" · 자료 {n}", { n: d.materials.length }) : ""}${isBusy(m) ? " · " + BUSY[m.status] : ""}`;
  if (!lens) lens = d.final ? "final" : "live";
  if (!editMode || !document.activeElement?.isContentEditable) { renderSegments(); renderFinal(); }
  applyLens();
  renderSummary(); renderTranslation(); renderQA(); renderMaterials(); renderStudy();
  const busy = isBusy(m);
  $("#resummarizeBtn").disabled = $("#translateBtn").disabled = busy || !hasAudio;
  $("#studyBtn").disabled = busy || !(d.final || d.segments.length);
  $("#editBtn").disabled = !!rec;
  $("#matCount").textContent = d.materials.length; $("#qaCount").textContent = d.qa.length;
  buildDensity(); drawNoteTl();
  if (finWatch) updateFin(m);
  clearTimeout(pollTimer);
  if (busy) pollTimer = setTimeout(async () => { try { await refresh(); } catch {} loadList().catch(() => {}); }, 2000);
}

const busyBlock = (m, lines = 6) => `<div class="busy"><p class="busy__l">${PING}${BUSY[m.status] || t("처리하는 중")}${m.progress != null ? `<span class="num">${m.progress}%</span>` : ""}</p>${'<i class="skel"></i>'.repeat(lines)}</div>`;
const ce = () => (editMode ? ' contenteditable="plaintext-only" spellcheck="false"' : "");

// transcript, lens 1: what was written down live (timestamps, page badges, English)
let segKey = "", finKey = "", hasEn = false, curIdx = -1;
function renderSegments(force) {
  const m = data.meta, key = editMode + m.status + JSON.stringify(data.segments);
  if (!force && key === segKey) return;
  segKey = key;
  const box = $("#segments");
  box.innerHTML = data.segments.length ? data.segments.map((s, i) => `<div class="ln" data-t="${s.start}" data-i="${i}"><span class="ln__t num">${fmt(s.start)}</span><div class="ln__b">` +
      `<p class="ln__ko"><span class="tx__t"${ce()}>${esc(s.text)}</span>${s.edited ? `<span class="tag">${t("수정됨")}</span>` : ""}` +
      `${s.page ? `<button class="pg" type="button" data-mat="${esc(s.mat)}" data-page="${s.page}" title="${t("강의 자료 {n}쪽 보기", { n: s.page })}">p.${s.page}</button>` : ""}</p>` +
      `${s.en ? `<p class="ln__en" lang="en">${esc(s.en)}</p>` : ""}</div></div>`).join("")
    : `<div class="tx__empty">${m.status === "transcribing" ? busyBlock(m) : `<p class='empty-tx'>${t("녹음을 시작하면 여기에 실시간으로 받아써져요.")}</p>`}</div>`;
  hasEn = data.segments.some((s) => s.en);
  curIdx = -1; markCur(false);
}
// transcript, lens 2: the speaker pass made after stopping
function renderFinal(force) {
  const m = data.meta, f = data.final, key = editMode + m.status + JSON.stringify(f);
  if (!force && key === finKey) return;
  finKey = key;
  if (!f) {
    $("#final").innerHTML = `<div class="tx__empty">${["speakers", "transcribing"].includes(m.status) ? busyBlock(m) : `<p class='empty-tx'>${t("녹음을 멈추면 화자별로 정리된 원고가 만들어져요.")}</p>`}</div>`;
    return;
  }
  let part = null;
  $("#final").innerHTML = f.paragraphs.map((p, i) => {
    let h = "";
    if (p.part && p.part !== part) { part = p.part; h = `<div class="part">${data.final.linked ? t("{n}분 ~", { n: (part - 1) * 30 }) : t("{n}분 ~ (화자 번호는 30분 구간마다 새로 매겨져요)", { n: (part - 1) * 30 })}</div>`; }
    return h + `<div class="para" data-i="${i}" data-s="${(p.speaker % 4) + 1}"><button class="who" type="button" tabindex="${editMode ? 0 : -1}">${t("화자 {n}", { n: p.speaker + 1 })}</button>` +
      `<p class="tx__ko"><span class="tx__t"${ce()}>${esc(p.text)}</span></p></div>`;
  }).join("");
}
function setLens(l) { lens = l; applyLens(); }
function applyLens() {
  $$("#lensSeg button").forEach((b) => b.setAttribute("aria-checked", b.dataset.lens === lens));
  $("#final").hidden = lens !== "final"; $("#segments").hidden = lens !== "live";
  $("#enBtn").hidden = !(lens === "live" && hasEn);
  if (!data) return;
  const f = data.final;
  $("#txStat").textContent = lens === "final" ? (f ? t("{a}문단 · 화자 {b}명", { a: f.paragraphs.length, b: new Set(f.paragraphs.map((x) => x.speaker)).size }) : "")
    : data.segments.length ? t("{n}줄 · 받아쓴 그대로", { n: data.segments.length }) : "";
}
$("#lensSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) setLens(b.dataset.lens); };
$("#enBtn").onclick = () => {
  const on = $("#enBtn").getAttribute("aria-pressed") !== "true";
  $("#enBtn").setAttribute("aria-pressed", on); $("#txBody").classList.toggle("show-en", on);
};

function bindEdit(el, url) {
  const orig = el.textContent;
  let last = orig.trim(), timer;
  const save = async () => {
    clearTimeout(timer);
    const t = el.textContent.trim();
    if (!t || t === last) return;
    try { await api(url(), json("PATCH", { text: t })); last = t; el.classList.add("saved"); setTimeout(() => el.classList.remove("saved"), 900); }
    catch (e) { toast(t("저장 실패: {e}", { e: tMsg(e.message) }), true); }
  };
  el.oninput = () => { clearTimeout(timer); timer = setTimeout(save, 800); }; // autosave after typing pauses
  el.onblur = save;
  el.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.blur(); } if (e.key === "Escape") { el.textContent = orig; save(); el.blur(); } };
}
// edit handlers are bound lazily (one listener for 500+ lines), before the first keystroke can land
function lazyBind(e) {
  const el = e.target.closest?.(".tx__t");
  if (!editMode || !el || el.dataset.bound) return;
  el.dataset.bound = "1";
  const ln = el.closest(".ln"), para = el.closest(".para");
  bindEdit(el, () => ln ? `/sessions/${current}/segments/${ln.dataset.i}` : `/sessions/${current}/final/${para.dataset.i}`);
}
$("#txBody").addEventListener("pointerdown", lazyBind);
$("#txBody").addEventListener("focusin", lazyBind);
$("#txBody").onclick = async (e) => {
  const pg = e.target.closest(".pg");
  if (pg) { setDoc("materials"); openMaterial(pg.dataset.mat, +pg.dataset.page, true); return; }
  const who = e.target.closest(".who");
  if (who && editMode) {
    const i = +who.closest(".para").dataset.i, sp = (data.final.paragraphs[i].speaker + 1) % 6;
    try { await api(`/sessions/${current}/final/${i}`, json("PATCH", { speaker: sp })); data.final.paragraphs[i].speaker = sp; renderFinal(true); }
    catch (err) { fail(err); }
    return;
  }
  if (editMode) return;
  const ln = e.target.closest("#segments .ln");
  if (ln) seekAudio(+ln.dataset.t, true);
};

function applyEdit() {
  const b = $("#editBtn");
  b.setAttribute("aria-pressed", editMode); $("span", b).textContent = editMode ? t("편집 끝") : t("편집");
  $("#editHint").hidden = !editMode; $("#txBody").classList.toggle("is-edit", editMode);
}
function setEdit(on) {
  editMode = on; applyEdit();
  if (on) { pauseAudio(); if (noteMode !== "note") setMode("note"); }
  if (data) { renderSegments(true); renderFinal(true); applyLens(); }
}
$("#editBtn").onclick = async () => { if (editMode) { document.activeElement?.blur(); try { await refresh(); } catch (e) { fail(e); } } setEdit(!editMode); };

// left pane documents
function setDoc(d) {
  docTab = d;
  $$("#docTabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.doc === d));
  $$("[data-docpanel]").forEach((p) => (p.hidden = p.dataset.docpanel !== d));
  if (d === "materials" && data && !viewing && data.materials.length) openMaterial(data.materials[0].id, 1);
  $("#docBody").scrollTop = 0;
}
$("#docTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) setDoc(b.dataset.doc); };
function setMode(mo) {
  noteMode = mo; applyMode();
  if (mo === "study") { pauseAudio(); if (editMode) setEdit(false); } else requestAnimationFrame(drawNoteTl);
}
function applyMode() {
  $("#note").dataset.mode = noteMode;
  $$("#modeSeg button").forEach((b) => b.setAttribute("aria-selected", b.dataset.mode === noteMode));
}
$("#modeSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) setMode(b.dataset.mode); };

function renderSummary() {
  const m = data.meta;
  const hasTx = !!(data.final?.paragraphs?.length || data.segments.length);
  $("#resummarizeBtn").hidden = !data.summary; $("#editSummaryBtn").hidden = !data.summary;
  if (["speakers", "summarizing", "transcribing"].includes(m.status)) $("#summary").innerHTML = busyBlock(m, 9);
  else if (data.summary) $("#summary").innerHTML = md(data.summary);
  else if (hasTx && !isBusy(m)) $("#summary").innerHTML = summaryPrompt();
  else $("#summary").innerHTML = `<p class='empty-tx'>${t("녹음을 멈추면 화자별 원고가 만들어지고, 그다음 요약 노트를 만들 수 있어요.")}</p>`;
  $("#editSummaryBtn").disabled = !data.summary || isBusy(m);
}
$("#editSummaryBtn").onclick = () => { $("#summaryText").value = data.summary || ""; $("#summary").hidden = true; $("#summaryEditor").hidden = false; $("#summaryText").focus(); };
$("#cancelSummaryBtn").onclick = () => { $("#summary").hidden = false; $("#summaryEditor").hidden = true; };
$("#saveSummaryBtn").onclick = async () => {
  try { await api(`/sessions/${current}/summary`, json("PUT", { text: $("#summaryText").value })); } catch (e) { return fail(e); }
  $("#summary").hidden = false; $("#summaryEditor").hidden = true; toast(t("요약 노트를 저장했어요")); refresh().catch(fail);
};

function renderTranslation() {
  const m = data.meta;
  $("#translation").innerHTML = m.status === "translating" ? busyBlock(m) : data.translation ? md(data.translation)
    : `<p class='empty-tx'>${t("화자별 원고를 영어로 번역해요. (이 모델은 영어 번역만 안정적으로 지원해요)")}</p>`;
}
function renderQA() {
  $("#qa").innerHTML = data.qa.map((x) => `<div class="qa__item"><div class="qa__q">${esc(x.q)}</div><div class="qa__a doc">${md(x.a)}</div></div>`).join("") ||
    `<p class='empty-tx'>${t("아직 질문이 없어요. 아래 칸에 물어보세요.")}</p>`;
}
$("#askForm").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("#question").value.trim(); if (!q || !current) return;
  setDoc("qa");
  $("#question").value = ""; $("#question").disabled = true;
  if (!data.qa.length) $("#qa").innerHTML = "";
  $("#qa").insertAdjacentHTML("beforeend", `<div class="qa__item"><div class="qa__q">${esc(q)}</div><div class="qa__a"><p class="busy__l">${PING}${t("원고와 자료에서 찾는 중…")}</p></div></div>`);
  $("#docBody").scrollTop = $("#docBody").scrollHeight;
  try { await api(`/sessions/${current}/ask`, json("POST", { question: q })); } catch (err) { fail(err); }
  $("#question").disabled = false; $("#question").focus();
  try { await refresh(); } catch (err) { fail(err); }
  $("#docBody").scrollTop = $("#docBody").scrollHeight;
};

// ---------------------------------------------------------------- materials
function renderMaterials() {
  $("#materials").innerHTML = data.materials.map((m) => `<div class="mat__file" role="button" tabindex="0" data-id="${m.id}"${viewing?.id === m.id ? ' aria-current="true"' : ""}>` +
    `${ic("file")}<b>${esc(m.name)}</b><span class="num">${t("{n}쪽", { n: m.pages.length })}</span><button class="btn sm quiet danger" data-del="${m.id}">${ic("trash")}${t("삭제")}</button></div>`).join("");
  if (viewing && !data.materials.some((x) => x.id === viewing.id)) { viewing = null; $("#viewer").innerHTML = ""; $("#viewer").dataset.key = ""; }
  if (!data.materials.length) { $("#viewer").innerHTML = ""; $("#viewer").dataset.key = ""; }
  else if (docTab === "materials" && !viewing) openMaterial(data.materials[0].id, 1);
  else if (viewing) renderRefs();
}
$("#materials").onclick = async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    if (!await confirmDlg(t("이 자료를 지울까요?"), t("원고에 붙은 쪽 번호도 함께 사라져요."), t("삭제"))) return;
    try { await api(`/sessions/${current}/materials/${del.dataset.del}`, { method: "DELETE" }); } catch (err) { return fail(err); }
    if (viewing?.id === del.dataset.del) { viewing = null; $("#viewer").innerHTML = ""; $("#viewer").dataset.key = ""; }
    segKey = ""; refresh().catch(fail);
    return;
  }
  const f = e.target.closest(".mat__file"); if (f) openMaterial(f.dataset.id, 1);
};
$("#materials").onkeydown = (e) => { const f = e.target.closest(".mat__file"); if (f && e.target === f && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openMaterial(f.dataset.id, 1); } };

function openMaterial(id, page, flash) {
  const m = data?.materials.find((x) => x.id === id); if (!m) return;
  page = clamp(page || 1, 1, Math.max(1, m.pages.length));
  viewing = { id, page };
  $$("#materials .mat__file").forEach((el) => el.setAttribute("aria-current", el.dataset.id === id));
  const v = $("#viewer"), key = id + ":" + page, url = `/api/sessions/${current}/materials/${id}/file`;
  if (v.dataset.key !== key) {
    v.dataset.key = key;
    const nav = `<button class="btn sm icon" data-p="${page - 1}"${page <= 1 ? " disabled" : ""} aria-label="${t("이전 쪽")}">${ic("chev-l")}</button>` +
      `<span class="num">p.${page} / ${m.pages.length}</span><button class="btn sm icon" data-p="${page + 1}"${page >= m.pages.length ? " disabled" : ""} aria-label="${t("다음 쪽")}">${ic("chev-r")}</button>`;
    v.innerHTML = `<div class="viewer-bar"><b>${esc(m.name)}</b>${nav}<span class="sp"></span><a class="btn sm quiet" href="${url}" target="_blank" rel="noopener">${ic("ext")}${t("새 창에서 열기")}</a></div>` +
      (m.kind === "pdf" ? `<iframe src="${url}#page=${page}" title="${esc(m.name)}"></iframe>`
        : `<div class="page-text">${esc(m.pages[page - 1] || t("(이 쪽에는 글자가 없어요)"))}</div>`) + '<div class="refs" id="refs"></div>';
  }
  renderRefs();
  if (flash) { const t = $(".page-text, iframe", v); if (t) restart(t, "is-flash"); }
}
// the lines of the transcript that were linked to this page
function renderRefs() {
  const box = $("#refs"); if (!box || !viewing || !data) return;
  const refs = data.segments.filter((s) => s.mat === viewing.id && s.page === viewing.page);
  box.innerHTML = `<h3>${t("이 쪽을 설명한 곳")}</h3>` + (refs.length ? refs.slice(0, 30).map((s) => `<button class="ref" data-t="${s.start}"><span class="num">${fmt(s.start)}</span><span>${esc(s.text)}</span></button>`).join("")
    : `<p class='hint'>${t("이 쪽과 이어진 문장이 없어요.")}</p>`);
}
$("#viewer").onclick = (e) => {
  const p = e.target.closest("[data-p]"); if (p && viewing) return openMaterial(viewing.id, +p.dataset.p);
  const r = e.target.closest(".ref"); if (r) { setLens("live"); jumpTo(+r.dataset.t); }
};
$("#materialInput").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return; e.target.value = "";
  const fd = new FormData(); fd.append("file", f);
  $("#materials").insertAdjacentHTML("beforeend", `<p class="busy__l">${PING}${t("자료 읽는 중…")}</p>`);
  try {
    const r = await api(`/sessions/${current}/materials`, { method: "POST", body: fd });
    if (r.textless === r.pages) toast(t("자료에서 글자를 찾지 못했어요(스캔본일 수 있어요). 보기는 되지만 원고와 연결되지는 않아요."), true);
    viewing = { id: r.id, page: 1 }; $("#viewer").dataset.key = "";
  } catch (err) { fail(err); }
  segKey = "";
  try { await refresh(); } catch (err) { fail(err); }
  if (viewing) openMaterial(viewing.id, 1);
};

// ---------------------------------------------------------------- study (quiz + flashcards)
let studyKey = "", picks = {}, ci = 0;
function renderStudy() {
  const m = data.meta, s = data.study;
  const k = current + (s?.created || "") + m.status + (m.error || "");
  if (k === studyKey) return;
  if (!studyKey.startsWith(current + (s?.created || ""))) { picks = {}; ci = 0; }
  studyKey = k;
  $("#studyBtn span").textContent = s ? t("새로 만들기") : t("복습 자료 만들기");
  $("#modeScore").textContent = "";
  if (m.status === "studying") {
    $("#study").innerHTML = busyBlock(m, 6); $("#deck").innerHTML = ""; $("#scoreRings").innerHTML = ""; $("#scoreTx").innerHTML = "";
    return;
  }
  if (!s || (!s.quiz.length && !s.cards.length)) {
    $("#scoreRings").innerHTML = ""; $("#scoreTx").innerHTML = "";
    // another job on this note (translation, summary, ...) keeps the button disabled: say why instead of a dead button
    const why = isBusy(m) && BUSY[m.status] ? `<p class="study__wait">${t("지금 {job} — 끝나면 복습 자료를 만들 수 있어요.", { job: BUSY[m.status] })}</p>` : "";
    $("#study").innerHTML = `<div class="study__empty"><h3>${t("퀴즈와 암기카드")}</h3><p>${t("원고를 바탕으로 객관식 퀴즈와 암기카드를 만들어요. 위의 <b>복습 자료 만들기</b>를 눌러 주세요.")}</p>${why}</div>`;
    $("#deck").innerHTML = `<p class='empty-tx'>${t("복습 자료를 만들면 여기에 암기카드가 나와요.")}</p>`;
    return;
  }
  renderQuiz(); renderDeck();
}
function renderQuiz() {
  const Q = data.study.quiz, L = "ABCDEFG";
  $("#study").innerHTML = Q.length ? Q.map((q, i) => {
    const pick = picks[i], done = pick != null, st = !done ? "open" : pick === q.answer ? "right" : "wrong";
    return `<article class="quiz" data-state="${st}" data-q="${i}"><header><span class="qn">${pad(i + 1)}</span><h3>${esc(q.q)}</h3><span class="qs">${st === "right" ? t("정답") : st === "wrong" ? t("오답") : ""}</span></header>` +
      `<div class="choices">${q.choices.map((c, j) => {
        const cls = done && j === q.answer ? " right" : done && j === pick ? " wrong" : "";
        return `<button class="choice${cls}" data-k="${j}"${done ? ' tabindex="-1"' : ""}><span class="key">${L[j]}</span><span>${esc(c)}</span><span class="mk">${cls === " right" ? t("정답") : cls === " wrong" ? t("내 답") : ""}</span></button>`;
      }).join("")}</div>` +
      (done ? `<p class="explain"><b>${st === "right" ? t("정답!") : t("오답 — 정답은 {k}.", { k: L[q.answer] })}</b> ${esc(q.explain || "")}</p>` : "") + "</article>";
  }).join("") : `<p class='empty-tx'>${t("이번에는 퀴즈가 만들어지지 않았어요.")}</p>`;
  const done = Object.keys(picks).length, right = Q.filter((q, i) => picks[i] === q.answer).length;
  $("#scoreRings").innerHTML = Q.map((q, i) => `<i class="${picks[i] == null ? "" : picks[i] === q.answer ? "r" : "w"}"></i>`).join("");
  $("#scoreTx").innerHTML = !Q.length ? "" : done ? t("<b>{a}문제 중 {b}문제</b> 풀었어요 · {c}개 맞음", { a: Q.length, b: done, c: right }) : t("<b>퀴즈 {n}문제</b> · 보기를 눌러 풀어 보세요", { n: Q.length });
  $("#modeScore").textContent = Q.length ? `${done}/${Q.length}` : "";
}
$("#study").onclick = (e) => {
  const c = e.target.closest(".choice"); if (!c) return;
  const i = +c.closest(".quiz").dataset.q;
  if (picks[i] != null) return;
  picks[i] = +c.dataset.k; renderQuiz();
  $(`.quiz[data-q="${i}"] .explain`)?.scrollIntoView({ block: "nearest", behavior: RM.matches ? "auto" : "smooth" });
};
function renderDeck() {
  const C = data.study.cards;
  if (!C.length) { $("#deck").innerHTML = `<p class='empty-tx'>${t("이번에는 암기카드가 만들어지지 않았어요.")}</p>`; return; }
  ci = (ci + C.length) % C.length;
  const c = C[ci];
  $("#deck").innerHTML = `<button class="fcard" id="fcard" aria-label="${t("암기카드 뒤집기")}"><span class="f front"><b>${esc(c.front)}</b><span class="hint">${t("눌러서 뜻 보기")}</span></span>` +
    `<span class="f back"><small>${esc(c.front)}</small><p>${esc(c.back)}</p></span></button>` +
    `<div class="deck-dots" aria-hidden="true">${C.length <= 40 ? C.map((_, j) => `<i${j === ci ? ' class="on"' : ""}></i>`).join("") : ""}</div>` +
    `<div class="deck-ctl"><button class="btn icon" data-card="${ci - 1}" aria-label="${t("이전 카드")}">${ic("chev-l")}</button><span class="cnt num">${ci + 1} / ${C.length}</span>` +
    `<button class="btn icon" data-card="${ci + 1}" aria-label="${t("다음 카드")}">${ic("chev-r")}</button></div>` +
    `<div class="deck-all">${C.map((x, j) => `<button data-card="${j}" aria-current="${j === ci}"><b>${esc(x.front)}</b><span class="num">${pad(j + 1)}</span></button>`).join("")}</div>`;
}
$("#deck").onclick = (e) => {
  if (e.target.closest("#fcard")) { $("#fcard").classList.toggle("flip"); return; }
  const b = e.target.closest("[data-card]");
  if (b) { ci = +b.dataset.card; renderDeck(); $("#fcard").focus({ preventScroll: true }); }
};
$("#studyBtn").onclick = async () => {
  try { await api(`/sessions/${current}/study`, { method: "POST" }); } catch (e) { return fail(e); }
  refresh().catch(fail);
};

// ---------------------------------------------------------------- misc note actions
const saveTitle = (v) => api(`/sessions/${current}`, json("PATCH", { title: v })).then(loadList).catch(fail);
$("#title").onchange = () => { $("#recTitle").value = $("#title").value; saveTitle($("#title").value); };
$("#recTitle").onchange = () => { $("#title").value = $("#recTitle").value; saveTitle($("#recTitle").value); };
$("#terms").onchange = () => api(`/sessions/${current}`, json("PATCH", { terms: $("#terms").value })).catch(fail);
$$("#title, #recTitle, #terms").forEach((i) => (i.onkeydown = (e) => { if (e.key === "Enter") i.blur(); }));
$("#deleteBtn").onclick = async () => {
  if (rec) return toast(t("녹음 중에는 지울 수 없어요."), true);
  if (!await confirmDlg(t("이 노트를 지울까요?"), t("'{t}' 노트와 녹음 파일을 지울까요? 되돌릴 수 없어요.", { t: data.meta.title }), t("삭제"))) return;
  try { await api(`/sessions/${current}`, { method: "DELETE" }); } catch (e) { return fail(e); }
  current = null; data = null; clearTimeout(pollTimer); resetAudio(); P.dataset.key = "";
  setView("home"); loadList().catch(fail); toast(t("노트를 지웠어요"));
};
// The summary is made on request (not right after recording), with the summary engine chosen at that moment.
const engineName = () => ($("#llmSel")?.selectedOptions[0]?.textContent || "").split(" · ")[0];
function summaryPrompt() {
  const en = engineName();
  return `<div class="sum-make"><p>${t("원고가 준비됐어요. 요약 노트를 만들까요?")}</p>` +
    `<button type="button" class="btn" id="makeSummaryBtn">${ic("note")}${t("요약 노트 만들기")}</button>` +
    (en ? `<small>${esc(t("요약 엔진: {s}", { s: en }))} · ${t("사이드바에서 바꿀 수 있어요")}</small>` : "") + "</div>";
}
async function makeSummary() {
  try { await api(`/sessions/${current}/summarize`, { method: "POST" }); } catch (e) { return fail(e); }
  refresh().catch(fail);
}
$("#summary").addEventListener("click", (e) => { if (e.target.closest("#makeSummaryBtn")) makeSummary(); });
$("#resummarizeBtn").onclick = async () => {
  if (data?.summary && !await confirmDlg(t("요약 노트를 새로 만들까요?"),
    t("지금 고른 요약 엔진({s})으로 다시 만들어요. 직접 고친 내용은 사라져요.", { s: engineName() || "-" }), t("새로 만들기"))) return;
  makeSummary();
};
$("#translateBtn").onclick = async () => {
  try { await api(`/sessions/${current}/translate`, { method: "POST" }); } catch (e) { return fail(e); }
  refresh().catch(fail);
};

async function newNote() {
  if (rec) return false;
  const m = await api("/sessions", json("POST", {}));
  await openNote(m.id); setLens("live");
  return current === m.id;
}
$("#newBtn").onclick = () => newNote().catch(fail);
async function uploadFile(f) {
  if (!f) return;
  if (rec) return toast(t("녹음 중에는 파일을 올릴 수 없어요."), true);
  if (!engineOn) toast(t("엔진을 켜는 중이에요. 켜지면(약 3분) 받아쓰기를 시작해요"));
  const m = await api("/sessions", json("POST", { title: f.name.replace(/\.[^.]+$/, "") }));
  await openNote(m.id); setLens("live");
  $("#segments").innerHTML = `<div class="tx__empty"><p class="busy__l">${PING}${t("파일 올리는 중…")}</p></div>`; segKey = "";
  const fd = new FormData(); fd.append("file", f);
  try { await api(`/sessions/${m.id}/upload`, { method: "POST", body: fd }); } catch (err) { fail(err); }
  refresh().catch(fail); loadList().catch(() => {});
}
["#fileInput", "#homeFile", "#homeFile2"].forEach((s) => ($(s).onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; setMenu(false); uploadFile(f).catch(fail); }));

// ---------------------------------------------------------------- player + timeline
// The /audio endpoint has no range support, so a plain src is not seekable in Chromium.
// The WAV is fetched once (on the first play or seek) into a Blob URL, which is.
const P = $("#player");
let rate = 1, dens = null, flags = [], headT = 0, audioFor = "", audioLoading = null;
const RATES = [1, 1.25, 1.5, 2];
function pauseAudio() { if (!P.paused) P.pause(); }
function resetAudio() {
  P.pause();
  if (P.src.startsWith("blob:")) URL.revokeObjectURL(P.src);
  P.removeAttribute("src"); P.load();
  audioFor = ""; headT = 0; $("#pCur").textContent = fmt(0); updPlayBtn();
}
function ensureAudio() {
  const id = current, dur = data?.meta.duration, key = id + ":" + dur;
  if (audioFor === key) return audioLoading || Promise.resolve();
  audioFor = key;
  $("#playBtn").classList.add("is-loading");
  audioLoading = fetch(`/api/sessions/${id}/audio?d=${dur}`, { headers: { "X-SoriNote": "1" } })
    .then((r) => { if (!r.ok) throw new Error(t("녹음 파일을 불러오지 못했어요 ({n})", { n: r.status })); return r.blob(); })
    .then((b) => {
      if (audioFor !== key) return;
      if (P.src.startsWith("blob:")) URL.revokeObjectURL(P.src);
      P.src = URL.createObjectURL(b);
      return new Promise((res) => P.addEventListener("loadedmetadata", res, { once: true }));
    })
    .catch((e) => { audioFor = ""; throw e; })
    .finally(() => { audioLoading = null; $("#playBtn").classList.remove("is-loading"); });
  return audioLoading;
}
function updPlayBtn() { const b = $("#playBtn"); b.innerHTML = ic(P.paused ? "play" : "pause", ""); b.setAttribute("aria-label", P.paused ? t("재생") : t("일시정지")); }
$("#playBtn").onclick = async () => {
  if (!P.paused) return P.pause();
  try { await ensureAudio(); if (Math.abs(P.currentTime - headT) > .5) P.currentTime = headT; await P.play(); } catch (e) { fail(e); }
};
P.onplay = P.onpause = updPlayBtn;
function showHead(t) {
  headT = t;
  $("#pCur").textContent = fmt(t);
  const tl = $("#noteTl"); tl.setAttribute("aria-valuenow", Math.round(t)); tl.setAttribute("aria-valuetext", fmt(t));
}
P.ontimeupdate = () => { if (!P.src) return; showHead(P.currentTime); drawNoteTl(); markCur(!P.paused); };
$("#rateBtn").onclick = () => { rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length]; P.playbackRate = rate; $("#rateBtn").textContent = rate.toFixed(rate === 1.25 ? 2 : 1) + "×"; };
P.onloadedmetadata = () => { P.playbackRate = rate; };
async function seekAudio(t, play) {
  if ($("#playerBar").hidden) return;
  showHead(t); drawNoteTl(); markCur(true);
  try { await ensureAudio(); } catch (e) { return fail(e); }
  P.currentTime = headT;
  if (play) P.play().catch(() => {});
}
function jumpTo(t) {
  const el = $(`#segments .ln[data-t="${t}"]`);
  if (el) { el.scrollIntoView({ block: "center" }); restart(el, "is-flash"); }
  if (!$("#playerBar").hidden) { showHead(t); drawNoteTl(); if (P.src) P.currentTime = t; }
}
function segIndexAt(t) {
  const s = data?.segments; if (!s?.length) return -1;
  let lo = 0, hi = s.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid].start <= t + .05) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  return k;
}
function markCur(scroll) {
  if (!data || $("#playerBar").hidden) return;
  const k = headT > 0 ? segIndexAt(headT) : -1;
  if (k === curIdx) return;
  const box = $("#segments");
  box.children[curIdx]?.classList.remove("is-cur");
  curIdx = k;
  const el = k >= 0 ? box.children[k] : null;
  if (el?.classList.contains("ln")) {
    el.classList.add("is-cur");
    if (scroll && lens === "live" && !editMode) el.scrollIntoView({ block: "nearest", behavior: RM.matches ? "auto" : "smooth" });
  }
}
// no waveform is stored, so the timeline shows how densely words were spoken
function buildDensity() {
  const dur = data?.meta.duration || 0, n = Math.max(1, Math.ceil(dur)), a = new Float32Array(n);
  flags = [];
  let lastPg = null;
  for (const s of data.segments) {
    const end = s.end ?? s.start + 10, len = Math.max(1, end - s.start), v = .25 + .75 * Math.min(1, s.text.length / len / 9);
    for (let i = Math.floor(s.start); i < Math.min(n, Math.ceil(end)); i++) if (v > a[i]) a[i] = v;
    const pk = s.page ? s.mat + s.page : null;
    if (pk && pk !== lastPg) flags.push({ t: s.start, pg: s.page });
    lastPg = pk;
  }
  dens = a;
}
const C = { echo: "138,216,232", voice: "255,163,108", amber: "245,196,106", line: "165,195,235", err: "255,138,138" };
const NUMF = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
function fit(cv) {
  const b = cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(b.width)), h = Math.max(1, Math.round(b.height));
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
  const x = cv.getContext("2d"); x.setTransform(d, 0, 0, d, 0, 0);
  return { x, w, h };
}
function drawTl(cv, o) {
  const { x, w, h } = fit(cv);
  if (w < 16 || h < 16) return;
  x.clearRect(0, 0, w, h);
  const top = o.flags ? 15 : 5, rul = 16, mid = top + (h - top - rul) / 2, amp = (h - top - rul) / 2 - 1;
  const n = o.wave.length, cols = Math.max(1, Math.floor(w / 3));
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * n / cols), b = Math.max(a + 1, Math.floor((c + 1) * n / cols));
    let m = 0; for (let i = a; i < b && i < n; i++) if (o.wave[i] > m) m = o.wave[i];
    const bh = Math.max(.75, m * amp);
    x.fillStyle = o.color((c + .5) / cols * o.total, c, cols);
    x.fillRect(c * 3, mid - bh, 2, bh * 2);
  }
  x.fillStyle = `rgba(${C.line},.16)`; x.fillRect(0, h - rul, w, 1);
  const steps = [15, 30, 60, 120, 300, 600, 900, 1800, 3600]; let st = steps[steps.length - 1];
  for (const s of steps) if (s / o.total * w >= 64) { st = s; break; }
  x.font = "500 10px " + NUMF; x.textBaseline = "alphabetic"; x.textAlign = "left";
  for (let t = 0; t < o.total; t += st) {
    const px = Math.round(t / o.total * w);
    x.fillStyle = `rgba(${C.line},.32)`; x.fillRect(px, h - rul, 1, 4);
    if (px < w - 40) { x.fillStyle = "#8996b0"; x.fillText(fmt(t), px + 4, h - 3); }
  }
  if (o.ticks) { x.fillStyle = `rgba(${C.line},.36)`; for (const t of o.ticks) x.fillRect(Math.round(t / o.total * w), 0, 1, 3); }
  if (o.flags) {
    x.font = "500 9.5px " + NUMF; let lastX = -99;
    for (const g of o.flags) {
      const px = Math.round(g.t / o.total * w);
      x.fillStyle = `rgba(${C.amber},.95)`; x.fillRect(px, 10, 1, 5);
      if (px - lastX > 30 && px < w - 24) { x.fillText("p." + g.pg, px, 8); lastX = px; }
    }
  }
  if (o.now) { x.fillStyle = `rgb(${C.voice})`; x.fillRect(w - 2, top - 2, 2, h - rul - top + 4); }
  if (o.head != null) {
    const px = clamp(Math.round(o.head / o.total * w), 1, w - 2);
    x.fillStyle = "#fff"; x.fillRect(px - .75, top - 3, 1.5, h - rul - top + 6);
    x.beginPath(); x.arc(px, top - 3, 3.2, 0, TAU); x.fill();
  }
}
function drawNoteTl() {
  if (!data || !dens || $("#note").hidden || $("#playerBar").hidden || noteMode !== "note") return;
  const total = Math.max(1, data.meta.duration), cur = headT;
  drawTl($("canvas", $("#noteTl")), { wave: dens, total, flags, head: cur, color: (t) => (t <= cur ? `rgba(${C.voice},.95)` : `rgba(${C.echo},.4)`) });
}
(function bindNoteTl() {
  const el = $("#noteTl"), hair = $(".tl__hair", el), tip = $(".tl__tip", el);
  const at = (e) => { const b = el.getBoundingClientRect(); return { px: clamp(e.clientX - b.left, 0, b.width), w: b.width }; };
  const tAt = (p) => p.px / p.w * (data?.meta.duration || 0);
  let down = false;
  el.addEventListener("pointermove", (e) => {
    if (!data) return;
    const p = at(e), t = tAt(p), k = segIndexAt(t);
    hair.hidden = tip.hidden = false;
    hair.style.left = p.px + "px"; tip.style.left = clamp(p.px, Math.min(120, p.w / 2), Math.max(p.w - 120, p.w / 2)) + "px";
    tip.innerHTML = `<span class="num">${fmt(t)}</span>${k >= 0 ? esc(data.segments[k].text) : ""}`;
    if (down) seekAudio(t);
  });
  el.addEventListener("pointerleave", () => { hair.hidden = tip.hidden = true; });
  el.addEventListener("pointerdown", (e) => { if (e.button || !data) return; down = true; try { el.setPointerCapture(e.pointerId); } catch {} seekAudio(tAt(at(e))); });
  el.addEventListener("pointerup", () => { down = false; });
  el.addEventListener("pointercancel", () => { down = false; });
  el.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 }[e.key];
    if (d) { e.preventDefault(); seekAudio(clamp(headT + d, 0, data?.meta.duration || 0)); }
    else if (e.key === "Home") { e.preventDefault(); seekAudio(0); }
  });
})();

// ---------------------------------------------------------------- recording controls (shared by every deck)
const SRCNAME = { mic: t("마이크"), tab: t("탭 소리"), both: t("마이크 + 탭 소리") };
function syncControls() {
  $$("[data-src] button").forEach((b) => {
    b.setAttribute("aria-checked", b.dataset.v === S.source);
    if (b.dataset.v !== "mic" && !canTab) { b.disabled = true; b.title = t("이 브라우저는 탭 소리 녹음을 지원하지 않아요"); }
  });
  $$("[data-tr]").forEach((b) => b.setAttribute("aria-checked", S.translate));
}
document.addEventListener("click", (e) => {
  const sb = e.target.closest("[data-src] button");
  if (sb) {
    if (rec) return toast(t("녹음 중에는 녹음할 소리를 바꿀 수 없어요."));
    S.source = sb.dataset.v; store.set("source", S.source); syncControls(); return;
  }
  const tr = e.target.closest("[data-tr]");
  if (tr) {
    S.translate = !S.translate; store.set("translate", S.translate ? "1" : "0"); syncControls();
    if (rec) { rec.translate = S.translate; toast(S.translate ? t("다음 줄부터 영어 번역을 함께 받아써요") : t("다음 줄부터 영어 번역 없이 받아써요")); }
    return;
  }
  const sr = e.target.closest("[data-start-rec]");
  if (sr) { onStartRec(sr).catch(fail); return; }
  if (e.target.closest("[data-home]")) { e.preventDefault(); goHome(); return; }
  if (e.target.closest("[data-close-menu]")) setMenu(false);
});
async function onStartRec(btn) {
  if (rec) return;
  if (!engineOn) { api("/engine/start", { method: "POST" }).catch(() => {}); toast(t("녹음은 바로 시작해요. 엔진이 켜지면(약 3분) 따라잡아 받아써요")); }
  if (btn.id === "recBtn") return startRec();
  if (await newNote()) await startRec();
}

// ---------------------------------------------------------------- recorder
const WORKLET = `class P extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("p",P)`;
// what the dial draws; reset on every start
const D = { bars: new Float32Array(120), ghost: null, ghostN: 0, rings: [], shots: [], lastRing: 0, sinceCut: 9, L: 0, peak: 0, wave: [], acc: 0, finT: 0, muted: false, sec: -1 };

async function startRec() {
  if (rec || !data || !current) return;
  if (!navigator.mediaDevices?.getUserMedia) return toast(t("이 주소에서는 마이크를 쓸 수 없어요. 휴대폰이라면 https 주소로 접속해 주세요."), true);
  if (editMode) setEdit(false);
  pauseAudio();
  const src = S.source, streams = [];
  try {
    if (src !== "tab") streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: src === "both", noiseSuppression: true, autoGainControl: true } }));
    if (src !== "mic") {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error(t("이 브라우저는 탭 소리 녹음을 지원하지 않아요"));
      const d = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      d.getVideoTracks().forEach((t) => t.stop());
      if (!d.getAudioTracks().length) { streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); return toast(t("공유 창에서 '탭 오디오 공유'(또는 시스템 오디오)를 켜 주세요."), true); }
      streams.push(d);
    }
  } catch (e) { streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); return toast(t("오디오를 가져올 수 없어요: {e}", { e: e.message }), true); }

  let ctx, node;
  try {
    ctx = new AudioContext({ sampleRate: SR });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    node = new AudioWorkletNode(ctx, "p");
    streams.forEach((s) => ctx.createMediaStreamSource(s).connect(node));
    const sink = ctx.createGain(); sink.gain.value = 0; node.connect(sink).connect(ctx.destination);
  } catch (e) {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); ctx?.close();
    return toast(t("오디오를 처리할 수 없어요: {e}", { e: e.message }), true);
  }

  rec = { ctx, streams, node, buf: new Float32Array(SR * 60), len: 0, sent: 0, queue: Promise.resolve(), inflight: 0, level: 0, translate: S.translate };
  rec.sent = Math.round((data.meta.duration || 0) * SR);
  node.port.onmessage = (e) => onAudio(e.data);
  streams.forEach((s) => s.getAudioTracks()[0].addEventListener("ended", () => rec && stopRec()));
  rec.t0 = rec.lastSignal = rec.lastSpeech = performance.now();
  rec.micLabel = streams.map((s) => s.getAudioTracks()[0]?.label).filter(Boolean).join(" + ");
  Object.assign(D, { bars: new Float32Array(120), ghost: null, ghostN: 0, rings: [], shots: [], lastRing: 0, sinceCut: 9, L: 0, peak: 0, wave: [], acc: 0, finT: 0, muted: false, sec: -1 });

  const v = $("#recView");
  v.dataset.mode = "rec";
  $("#recStateT").textContent = t("녹음 중"); $("#recLed").className = "led led--rec";
  $("#stageLbl").textContent = SRCNAME[src];
  $("#recTitle").value = data.meta.title;
  $("#recInT").textContent = rec.micLabel ? t("입력 · {m}", { m: rec.micLabel }) : t("입력 장치 이름을 알 수 없어요");
  $("#recIn").title = rec.micLabel || ""; $("#recIn").classList.remove("is-bad");
  $("#stateText").textContent = t("말하는 내용이 10초 안팎 간격으로 받아써져요") + (rec.micLabel ? t(" · 입력: {m}", { m: rec.micLabel }) : "");
  $("#stopBtn").disabled = false;
  $$("#finSteps li").forEach((li) => (li.className = ""));
  $$("#recView [data-src]").forEach((g) => g.classList.add("is-locked"));
  liveAll = false; fillLive();
  syncControls(); setView("rec");
  $("#editBtn").disabled = true;
  rec.tick = setInterval(() => { recTick(); checkSilence(); }, 200);
  rec.pull = setInterval(pullBacklog, 4000);
  if (ctx.state === "suspended") gestureStart(ctx);
  try { rec.wake = await navigator.wakeLock?.request("screen"); } catch {}
}

// A muted microphone delivers digital silence: warn within seconds instead of recording nothing for an hour.
function micWarn(kind) {
  const el = $("#micWarn"), hard = kind === "hard";
  if (!kind) { el.hidden = true; el.dataset.kind = ""; $("#recIn").classList.remove("is-bad"); document.title = t("메아리"); D.muted = false; return; }
  if (el.dataset.kind !== kind) {
    el.dataset.kind = kind; el.className = "alert" + (hard ? " hard" : "");
    $("b", el).textContent = hard ? t("소리가 전혀 들어오지 않아요 — 지금은 아무것도 녹음되지 않고 있어요") : t("30초 동안 말소리가 감지되지 않았어요");
    $("p", el).textContent = (hard ? t("마이크가 음소거된 것 같아요 — 키보드의 마이크 키나 Windows 설정 > 시스템 > 소리 > 입력에서 음소거를 풀어 주세요.")
      : t("마이크 위치나 입력 장치를 확인해 보세요.")) + (rec?.micLabel ? t(" (지금 입력: {m})", { m: rec.micLabel }) : "");
  }
  el.hidden = false; D.muted = hard;
  $("#recIn").classList.toggle("is-bad", hard);
  document.title = hard ? t("⚠ 소리 없음 — 메아리") : t("메아리");
}
function checkSilence() {
  const now = performance.now(), muted = rec.streams.some((s) => s.getAudioTracks()[0]?.muted);
  if (muted || now - rec.lastSignal > 3000) micWarn("hard");
  else if (now - rec.lastSpeech > 30000) micWarn("soft");
  else micWarn("");
}

function onAudio(f) {
  if (!rec) return;
  let s = 0, peak = 0; for (const v of f) { s += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
  const rms = Math.sqrt(s / f.length), now = performance.now();
  if (peak > 0.0003) rec.lastSignal = now;   // anything above digital silence
  if (rms > 0.008) rec.lastSpeech = now;     // roughly speech level
  rec.level = Math.max(rec.level * 0.85, rms);
  if (rec.len + f.length > rec.buf.length) { const b = new Float32Array(rec.buf.length * 2); b.set(rec.buf.subarray(0, rec.len)); rec.buf = b; }
  rec.buf.set(f, rec.len); rec.len += f.length;
  const L = Math.min(1, rms * 6), i = Math.min(119, Math.floor(rec.len / SR / 16 * 120));   // the dial: this chunk's loudness so far
  if (L > D.bars[i]) D.bars[i] = L;
  if (L > D.acc) D.acc = L;
  if (rec.len - (rec.checked || 0) < SR / 10) return; // look for a cut every 100 ms
  rec.checked = rec.len;
  const cut = findCut(rec.buf, rec.len);
  if (cut) { sendChunk(cut); rec.checked = rec.len; }
}

// cut after >=8 s at a 400 ms pause; force a cut at the quietest point by 16 s
function findCut(buf, len) {
  const hop = SR / 10, minF = 80, maxF = 160, n = Math.floor(len / hop);
  if (n < minF) return 0;
  const e = []; for (let i = 0; i < n; i++) { let s = 0; for (let j = i * hop; j < (i + 1) * hop; j++) s += buf[j] * buf[j]; e.push(Math.sqrt(s / hop)); }
  const sorted = [...e].sort((a, b) => a - b), thr = Math.max(0.004, sorted[Math.floor(n * 0.2)] * 1.5);
  for (let i = minF; i + 3 < n; i++) if (e[i] < thr && e[i + 1] < thr && e[i + 2] < thr && e[i + 3] < thr) return (i + 2) * hop;
  if (n >= maxF) { let k = minF; for (let i = minF; i < maxF; i++) if (e[i] < e[k]) k = i; return k * hop; }
  return 0;
}

function sendChunk(n) {
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, rec.buf[i] * 32767));
  rec.buf.copyWithin(0, n, rec.len); rec.len -= n;
  const start = rec.sent / SR; rec.sent += n; rec.inflight++;
  D.ghost = D.bars; D.ghostN = Math.min(119, Math.floor(n / SR / 16 * 120)); D.bars = new Float32Array(120); D.sinceCut = 0;
  if (!D.muted) D.shots.push({ age: 0 });
  const id = current, r = rec;
  addPending(start);
  r.queue = r.queue.then(async () => {
    let seg = null;
    try {
      seg = await api(`/sessions/${id}/chunk?start=${start}&translate=${r.translate ? 1 : 0}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: pcm.buffer });
      if (seg.text && current === id) data.segments.push(seg);
    } catch (e) { $("#stateText").textContent = t("받아쓰기 실패: {e}", { e: tMsg(e.message) }); }
    r.inflight--;
    if (current === id && seg?.pending) { markWaiting(); r.waiting = (r.waiting || 0) + 1; return; }
    if (current === id) resolvePending(seg?.text ? seg : null);
  });
}

// live list in focus mode: append-only, keeps the last rows in the DOM
const MAXROWS = 40;
let liveAll = false;
const nearEnd = (l) => l.scrollHeight - l.scrollTop - l.clientHeight < 140;
function liveEl(s, fresh) {
  const d = document.createElement("div");
  d.className = "ln" + (fresh ? " is-new" : "");
  d.innerHTML = `<span class="ln__t num">${fmt(s.start)}</span><div class="ln__b"><p class="ln__ko">${esc(s.text)}${s.page ? `<span class="pg">p.${s.page}</span>` : ""}</p>${s.en ? `<p class="ln__en" lang="en">${esc(s.en)}</p>` : ""}</div>`;
  return d;
}
function fillLive() {
  const L = $("#liveList"), segs = data?.segments || [], keep = liveAll ? segs : segs.slice(-MAXROWS);
  L.innerHTML = "";
  if (segs.length > keep.length) { const b = document.createElement("button"); b.className = "fold"; b.textContent = t("앞의 {n}줄은 접어 두었어요 · 눌러서 펼치기", { n: segs.length - keep.length }); L.append(b); }
  if (!segs.length) L.innerHTML = `<p class="live__empty">${t("말이 멈출 때마다 여기에 한 줄씩 받아써져요.")}</p>`;
  keep.forEach((s) => L.append(liveEl(s)));
  markLast(); L.scrollTop = L.scrollHeight; $("#liveJump").hidden = true;
}
function markLast() {
  const rows = $$("#liveList .ln:not(.ln--pend)");
  rows.forEach((el, i) => el.classList.toggle("is-last", i === rows.length - 1));
  $("#liveCount").textContent = t("{n}줄", { n: data?.segments.length || 0 });
}
function addPending(start) {
  const L = $("#liveList"), stick = nearEnd(L);
  $(".live__empty", L)?.remove();
  const d = document.createElement("div");
  d.className = "ln ln--pend";
  d.innerHTML = `<span class="ln__t num">${fmt(start)}</span><div class="ln__b"><p class="ln__ko">${PING}${t("받아쓰는 중…")}</p></div>`;
  L.append(d);
  if (stick) L.scrollTop = L.scrollHeight;
}
// a chunk recorded while the engine was warming: keep a quiet row; pullBacklog() fills it in later
function markWaiting() {
  const p = $(".ln--pend", $("#liveList"));
  if (p) { p.classList.replace("ln--pend", "ln--wait"); $(".ln__ko", p).textContent = t("엔진이 켜지면 받아써요 · 소리는 저장됐어요"); }
}
let pulling = false;
async function pullBacklog() {
  if (!rec?.waiting || pulling || !engineOn) return;
  pulling = true;
  try {
    const id = current, fresh = await api(`/sessions/${id}`);
    if (id !== current || !rec) return;
    const known = new Set(data.segments.map((x) => x.start));
    if (fresh.segments.some((x) => !known.has(x.start))) {
      data.segments = fresh.segments;
      $$("#liveList .ln--wait").forEach((el) => el.remove());
      fillLive();
    }
    rec.waiting = (fresh.meta.pending || []).length;
    $$("#liveList .ln--wait").slice(rec.waiting).forEach((el) => el.remove());
  } catch {} finally { pulling = false; }
}
function resolvePending(seg) {
  const L = $("#liveList"), stick = nearEnd(L), pend = $(".ln--pend", L);
  if (!seg) { pend?.remove(); if (!$(".ln", L)) L.innerHTML = `<p class="live__empty">${t("말이 멈출 때마다 여기에 한 줄씩 받아써져요.")}</p>`; return; }
  const el = liveEl(seg, true);
  pend ? pend.replaceWith(el) : L.append(el);
  if (!liveAll) {
    const rows = $$(".ln:not(.ln--pend)", L);
    if (rows.length > MAXROWS) {
      rows[0].remove();
      let f = $(".fold", L);
      if (!f) { f = document.createElement("button"); f.className = "fold"; L.prepend(f); }
      f.textContent = t("앞의 {n}줄은 접어 두었어요 · 눌러서 펼치기", { n: data.segments.length - MAXROWS });
    }
  }
  markLast();
  if (stick) L.scrollTop = L.scrollHeight; else $("#liveJump").hidden = false;
}
$("#liveList").onclick = (e) => { if (e.target.closest(".fold")) { liveAll = true; fillLive(); } };
$("#liveList").onscroll = () => { if (nearEnd($("#liveList"))) $("#liveJump").hidden = true; };
$("#liveJump").onclick = () => { const L = $("#liveList"); L.scrollTop = L.scrollHeight; $("#liveJump").hidden = true; };

function recTick() {
  const t = rec.sent / SR + rec.len / SR, s = fmt(t);
  if ($("#timer").textContent !== s) { $("#timer").textContent = s; $("#recNow").textContent = s; }
  const c = rec.len / SR, cs = (c < 10 ? "0" : "") + c.toFixed(1);
  $("#chunkNow").textContent = cs; $("#chunkBox").classList.toggle("is-armed", c >= 8);
  const sec = Math.floor(t);
  if (sec !== D.sec) { D.sec = sec; D.wave.push(D.acc); D.acc = 0; drawRecTl(); }
}
function drawRecTl() {
  if ($("#recView").hidden) return;
  const total = Math.max(1, D.wave.length), base = data?.meta.duration || 0;
  drawTl($("canvas", $("#recTl")), { wave: D.wave, total, now: !!rec, ticks: (data?.segments || []).map((s) => s.start - base).filter((x) => x >= 0),
    color: (t, c, cols) => `rgba(${C.echo},${c > cols - 5 ? .95 : .5})` });
}

async function stopRec() {
  const r = rec; if (!r || r.stopping) return;
  r.stopping = true;
  clearInterval(r.tick); clearInterval(r.pull); micWarn("");
  r.node.port.onmessage = null;
  r.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  if (r.len > SR / 2) sendChunk(r.len);
  $("#stopBtn").disabled = true; $("#stateText").textContent = t("남은 부분 받아쓰는 중…");
  // finishing: the echoes come home while the note is made
  $("#recView").dataset.mode = "fin"; $("#recStateT").textContent = t("정리하는 중"); $("#recLed").className = "led led--echo";
  $("#stageLbl").textContent = t("녹음 끝"); D.finT = 0; finWatch = true;
  setFinStep("rest");
  await r.queue; await r.ctx.close();
  try { await r.wake?.release(); } catch {}
  rec = null;
  $("#stopBtn").disabled = false; $("#stateText").textContent = "";
  $$("#recView [data-src]").forEach((g) => g.classList.remove("is-locked"));
  syncControls();
  setFinStep("speakers");
  try { await api(`/sessions/${current}/finalize`, { method: "POST" }); docTab = "summary"; }
  catch (e) { fail(e); leaveFin(); }
  try { await refresh(); } catch (e) { fail(e); }
  loadList().catch(() => {});
}
const FIN = ["rest", "speakers"];   // the summary is made later, on request
function setFinStep(step, pct) {
  const k = FIN.indexOf(step);
  $$("#finSteps li").forEach((li, i) => {
    li.classList.toggle("is-done", i < k || step === "done"); li.classList.toggle("is-on", i === k);
    const n = $(".num", li); if (n) n.textContent = i === k && pct != null ? pct + "%" : "";
  });
}
function updateFin(m) {
  if (m.status === "speakers") setFinStep("speakers", m.progress);
  else if (m.status === "summarizing") setFinStep("summarizing", m.progress);
  else if (m.status === "done") { setFinStep("done"); setTimeout(() => { if (finWatch) { leaveFin(); toast(t("원고가 준비됐어요 — 요약 노트는 버튼을 눌러 만들어요")); } }, 450); }
  else if (m.status === "error") leaveFin();
}
function leaveFin() {
  finWatch = false;
  if (rec) return;
  setView(current ? "note" : "home"); setMode("note"); setDoc("summary");
  if (data?.final) setLens("final");
  if (data) { $("#recorder").hidden = data.meta.duration > 0; $("#playerBar").hidden = !(data.meta.duration > 0); }
  $("#editBtn").disabled = false;
}
$("#finGo").onclick = leaveFin;

// hold to stop: 700 ms, shown as an arc closing around the key (Enter stops at once)
let holdT = 0, lastNudge = 0;
const stopBtn = $("#stopBtn");
function holdStart() {
  if (!rec || holdT) return;
  stopBtn.classList.add("is-hold");
  holdT = setTimeout(() => { holdT = 0; stopBtn.classList.remove("is-hold"); stopRec(); }, 700);
}
function holdEnd(nudge) {
  if (!holdT) return;
  clearTimeout(holdT); holdT = 0; stopBtn.classList.remove("is-hold");
  if (nudge) { restart(stopBtn, "is-nudge"); if (performance.now() - lastNudge > 2500) { lastNudge = performance.now(); toast(t("멈추려면 0.7초 동안 길게 눌러 주세요")); } }
}
stopBtn.addEventListener("pointerdown", (e) => { if (!e.button) holdStart(); });
stopBtn.addEventListener("pointerup", () => holdEnd(true));
stopBtn.addEventListener("pointerleave", () => holdEnd(false));
stopBtn.addEventListener("pointercancel", () => holdEnd(false));
stopBtn.addEventListener("contextmenu", (e) => e.preventDefault());
stopBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); stopRec(); }
  else if (e.key === " ") { e.preventDefault(); if (!e.repeat) holdStart(); }
});
stopBtn.addEventListener("keyup", (e) => { if (e.key === " ") { e.preventDefault(); holdEnd(true); } });

// ---------------------------------------------------------------- the dial (canvas runs only while the focus view is visible)
let stageRaf = 0, stageLast = 0, stageDrawn = 0, timerFs = "";
function stageSync() {
  const on = document.body.dataset.view === "rec" && !pageHidden();
  if (on && !stageRaf) { stageLast = performance.now(); stageRaf = requestAnimationFrame(stageFrame); requestAnimationFrame(drawRecTl); }
  else if (!on) stageStop();
}
function stageStop() { cancelAnimationFrame(stageRaf); stageRaf = 0; }
function stageFrame(now) {
  stageRaf = requestAnimationFrame(stageFrame);
  const dt = Math.min(.1, (now - stageLast) / 1000); stageLast = now;
  const target = rec ? Math.min(1, rec.level * 6) : 0;
  D.L += (target - D.L) * (1 - Math.exp(-dt * (target > D.L ? 30 : 10)));
  D.peak = Math.max(D.L, D.peak - dt * .35);
  D.sinceCut += dt; D.lastRing += dt; if (!rec) D.finT += dt;
  if (rec && D.L > .34 && D.lastRing > .46) { D.rings.push({ age: 0, amp: D.L }); D.lastRing = 0; }
  for (const g of D.rings) g.age += dt;
  for (const s of D.shots) s.age += dt;
  while (D.rings.length && D.rings[0].age > 4.2) D.rings.shift();
  while (D.shots.length && D.shots[0].age > 1.8) D.shots.shift();
  if (now - stageDrawn < (RM.matches ? 250 : 33)) return;   // ≤30 fps; 4 fps and no travel with reduced motion
  stageDrawn = now;
  drawStage(); updMeter();
}
function updMeter() {
  const m = $("#meter");
  m.style.setProperty("--lv", (clamp(D.L * 1.1, 0, 1) * 100).toFixed(1) + "%");
  m.style.setProperty("--pk", (Math.floor(clamp(D.peak * 1.1, 0, .999) * 22) / 22 * 100).toFixed(2) + "%");
  const lv = rec?.level || 0, t = lv > .00005 ? "−" + Math.min(90, Math.round(-20 * Math.log10(lv))) + " dB" : "−∞ dB";
  if ($("#dbT").textContent !== t) $("#dbT").textContent = t;
}
function drawStage() {
  const cv = $("#stageCv"), { x, w, h } = fit(cv);
  if (w < 8 || h < 8) return;
  const ph = w < 560, cx = w / 2, cy = h * (ph ? .5 : .42);
  const R = clamp(Math.min(w, h) * (ph ? .3 : .27), 64, 188);
  const recOn = !!rec, total = rec ? rec.sent / SR + rec.len / SR : 0;
  const fs = (clamp(R * .44, 30, 76) * (total >= 3600 ? .74 : 1)).toFixed(0);
  if (fs !== timerFs) { timerFs = fs; $("#timer").style.fontSize = fs + "px"; }
  const rm = RM.matches, step = R * .46, base = R + 16, far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  const chunkT = rec ? rec.len / SR : 0, muted = recOn && D.muted;
  x.clearRect(0, 0, w, h); x.lineCap = "butt";
  // graticule: an echo travels one ring per second
  x.lineWidth = 1;
  for (let k = 1; base + k * step < far; k++) { x.strokeStyle = `rgba(${C.line},${k % 2 ? .08 : .045})`; x.beginPath(); x.arc(cx, cy, base + k * step, 0, TAU); x.stroke(); }
  // echoes
  if (!rm) {
    if (recOn) {
      for (const g of D.rings) {
        const k = 1 - g.age / 4.2; if (k <= 0) continue;
        x.strokeStyle = `rgba(${C.echo},${Math.min(.9, g.amp * k * k * 1.05).toFixed(3)})`; x.lineWidth = 1 + g.amp * 2.4 * k;
        x.beginPath(); x.arc(cx, cy, base + g.age * step, 0, TAU); x.stroke();
      }
    } else {
      for (let k = 0; k < 4; k++) {   // finishing: the echoes come home
        const p = (D.finT * .45 + k / 4) % 1;
        x.strokeStyle = `rgba(${C.echo},${(p * p * .55).toFixed(3)})`; x.lineWidth = 1 + p * 1.5;
        x.beginPath(); x.arc(cx, cy, base + (1 - p) * step * 4, 0, TAU); x.stroke();
      }
    }
    const a0 = ph ? Math.PI / 2 : 0;   // a cut chunk leaves toward the transcript
    x.lineCap = "round";
    for (const s of D.shots) {
      const k = 1 - s.age / 1.7; if (k <= 0) continue;
      const r = base + s.age * step * 3.4;
      x.strokeStyle = `rgba(${C.echo},${(k * .95).toFixed(3)})`; x.lineWidth = 2.5; x.beginPath(); x.arc(cx, cy, r, a0 - .42, a0 + .42); x.stroke();
      x.strokeStyle = `rgba(${C.echo},${(k * .4).toFixed(3)})`; x.lineWidth = 1.5; x.beginPath(); x.arc(cx, cy, Math.max(base, r - 14), a0 - .3, a0 + .3); x.stroke();
    }
    x.lineCap = "butt";
  }
  // warm core: the voice
  const gl = x.createRadialGradient(cx, cy, R * .15, cx, cy, R);
  gl.addColorStop(0, `rgba(${C.voice},${(recOn ? .03 + D.L * .12 : 0).toFixed(3)})`); gl.addColorStop(1, `rgba(${C.voice},0)`);
  x.fillStyle = gl; x.beginPath(); x.arc(cx, cy, R - 1, 0, TAU); x.fill();
  // dial track (dashed red when nothing comes in)
  const flash = recOn && !rm ? Math.max(0, 1 - D.sinceCut / .55) : 0;
  x.lineWidth = 1; x.strokeStyle = muted ? `rgba(${C.err},.7)` : `rgba(${C.line},${(.22 + flash * .5).toFixed(3)})`;
  if (muted) x.setLineDash([3, 5]);
  x.beginPath(); x.arc(cx, cy, R, 0, TAU); x.stroke(); x.setLineDash([]);
  if (recOn) { x.strokeStyle = `rgba(${C.amber},.55)`; x.setLineDash([1.5, 4.5]); x.beginPath(); x.arc(cx, cy, R - 7, Math.PI / 2, Math.PI * 1.5); x.stroke(); x.setLineDash([]); }
  if (!ph && R > 110) {
    x.font = "500 10px " + NUMF; x.textAlign = "center"; x.textBaseline = "middle"; x.fillStyle = "rgba(137,150,176,.95)";
    const rr = R - 21; x.fillText("0", cx, cy - rr); x.fillText("4", cx + rr, cy); x.fillText("8", cx, cy + rr); x.fillText("12", cx - rr, cy);
  }
  // the chunk so far, as a waveform laid around the dial (8–16 s is the window in which a pause cuts it)
  const live = recOn && !muted, idx = Math.min(119, Math.floor(chunkT / 16 * 120)), r1 = R + 6;
  for (let i = 0; i < 120; i++) {
    const a = -Math.PI / 2 + i / 120 * TAU, ca = Math.cos(a), sa = Math.sin(a);
    let r2;
    if (live && i <= idx) { r2 = r1 + 2 + D.bars[i] * R * .36; x.strokeStyle = `rgba(${i >= 60 ? C.amber : C.echo},.95)`; x.lineWidth = 2; }
    else { const major = i % 15 === 0; r2 = r1 + (major ? 7 : 3); x.strokeStyle = `rgba(${C.line},${major ? .5 : .24})`; x.lineWidth = 1; }
    x.beginPath(); x.moveTo(cx + ca * r1, cy + sa * r1); x.lineTo(cx + ca * r2, cy + sa * r2); x.stroke();
  }
  if (flash > 0 && D.ghost) {   // the chunk that just left, lifting off
    const off = (1 - flash) * R * .42;
    x.lineWidth = 2; x.strokeStyle = `rgba(${C.echo},${(flash * .7).toFixed(3)})`;
    for (let i = 0; i <= D.ghostN; i++) {
      const a = -Math.PI / 2 + i / 120 * TAU, ca = Math.cos(a), sa = Math.sin(a), g1 = r1 + off, g2 = g1 + 2 + D.ghost[i] * R * .36;
      x.beginPath(); x.moveTo(cx + ca * g1, cy + sa * g1); x.lineTo(cx + ca * g2, cy + sa * g2); x.stroke();
    }
  }
  if (live) {
    const ang = -Math.PI / 2 + clamp(chunkT / 16, 0, 1) * TAU;
    x.lineWidth = 2; x.strokeStyle = `rgb(${C.echo})`; x.beginPath(); x.arc(cx, cy, R, -Math.PI / 2, Math.min(ang, Math.PI / 2)); x.stroke();
    if (chunkT > 8) { x.strokeStyle = `rgb(${C.amber})`; x.beginPath(); x.arc(cx, cy, R, Math.PI / 2, ang); x.stroke(); }
    x.fillStyle = "#fff"; x.beginPath(); x.arc(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, 3.5, 0, TAU); x.fill();
  } else if (!recOn) {
    const p = clamp(D.finT / 8, 0, .97);
    x.lineWidth = 2; x.strokeStyle = `rgb(${C.echo})`; x.beginPath(); x.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + p * TAU); x.stroke();
  }
}

// ---------------------------------------------------------------- the lake (first-run home only)
const WARM = [255, 176, 128], COOL = [138, 216, 232];
const mix = (k, a) => `rgba(${WARM.map((w, i) => Math.round(w + (COOL[i] - w) * k)).join(",")},${a.toFixed(3)})`;
class Lake {
  constructor(el, anchor) {
    this.el = el; this.cv = $("canvas", el); this.ctx = this.cv.getContext("2d"); this.anchor = $(anchor, el);
    this.t = 7; this.seed = 7; this.level = .2; this.env = .25; this.excite = 0; this.lastEmit = 0; this.W = 0; this.pts = [];
    this.rings = [.04, .11, .21, .35, .53, .76].map((p) => ({ p, e: .4 }));
    new ResizeObserver(() => this.resize()).observe(el);
  }
  resize() {
    const r = this.cv.getBoundingClientRect(); if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), a = this.anchor.getBoundingClientRect();
    this.W = r.width; this.H = r.height; this.dpr = dpr;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.cx = a.left + a.width / 2 - r.left;
    this.hz = Math.round(a.bottom - r.top + 4);
    this.sy = this.hz + clamp(this.H * .07, 30, 66);
    this.el.style.setProperty("--hz", this.hz + "px");
    this.build(); this.draw();
  }
  build() {
    const rnd = mulberry(this.seed);
    const mk = (base, oct) => {
      const ph = Array.from({ length: oct }, () => [rnd() * TAU, .7 + rnd() * .6]);
      return (x) => { let v = 0, amp = 1, f = base, s = 0; for (const [p, k] of ph) { v += amp * (.5 + .5 * Math.sin(x * f * k + p)); s += amp; amp *= .55; f *= 2.1; } return v / s; };
    };
    this.far = mk(9, 4); this.near = mk(15, 4);
    const n = Math.max(14, Math.round(this.W * this.hz / 15000));
    this.stars = Array.from({ length: n }, () => ({ x: rnd() * this.W, y: rnd() * rnd() * this.hz * .92, r: rnd() < .14 ? 1.6 : 1, a: .25 + rnd() * .55, f: .5 + rnd() * 1.6, p: rnd() * TAU }));
  }
  step(dt) {
    if (!this.W) return;
    const t = this.t += dt, target = .18 + .07 * Math.sin(t * .7) + this.excite * .45;
    this.level += (target - this.level) * (target > this.level ? .3 : .07);
    this.env += (this.level - this.env) * .045;
    if (t - this.lastEmit > (this.excite ? .75 : 2.6)) { this.lastEmit = t; if (this.rings.length < 26) this.rings.push({ p: .008, e: this.excite ? .62 : .4 }); }
    let k = 0;
    for (const r of this.rings) { r.p += dt * .055 * (1 - r.p * .3); if (r.p < 1) this.rings[k++] = r; }
    this.rings.length = k;
    this.draw();
  }
  ridge(fn, amp, fill, front) {
    const { ctx: c, W, hz, cx, pts } = this, half = Math.max(cx, W - cx), nw = front ? 150 : 104;
    pts.length = 0;
    for (let x = -6; x <= W + 12; x += 6) {
      const d = x - cx, u = Math.min(1, Math.abs(d) / half);
      let h = Math.pow(fn(x / W), 1.6) * amp * (front ? .4 + .6 * u : 1);
      h *= 1 - Math.exp(-d * d / (nw * nw)) * (front ? .97 : .72);
      pts.push(x, hz - h);
    }
    c.beginPath(); c.moveTo(-6, hz + 1);
    for (let i = 0; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.lineTo(W + 12, hz + 1); c.closePath(); c.fillStyle = fill; c.fill();
    if (!front) return;
    c.beginPath(); for (let i = 0; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.strokeStyle = "rgba(150,190,240,.10)"; c.lineWidth = 1.2; c.lineJoin = "round"; c.stroke();
  }
  draw() {
    if (!this.W) return;
    const { ctx: c, W, H, dpr, cx, hz, sy, t } = this, still = RM.matches;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    c.fillStyle = "#CFE2FF";
    for (const s of this.stars) { c.globalAlpha = s.a * (still ? .8 : .55 + .45 * Math.sin(t * s.f + s.p)); c.fillRect(s.x, s.y, s.r, s.r); }
    c.globalAlpha = 1;
    const gr = Math.max(W * .42, 260), g = c.createRadialGradient(cx, hz, 0, cx, hz, gr);
    g.addColorStop(0, `rgba(104,160,236,${(.2 + this.env * .25).toFixed(3)})`); g.addColorStop(1, "rgba(104,160,236,0)");
    c.fillStyle = g; c.fillRect(cx - gr, hz - gr, gr * 2, gr);
    this.ridge(this.far, H * .07, "#0C1834", false);
    this.ridge(this.near, H * .042, "#060C1B", true);
    c.fillStyle = "rgba(170,205,255,.09)"; c.fillRect(0, hz, W, 1);
    c.save(); c.beginPath(); c.rect(0, hz + 1, W, H - hz); c.clip();
    const tilt = .3, maxR = Math.max(Math.max(cx, W - cx) * 1.06, (H - sy) / tilt * 1.03);
    for (const r of this.rings) {
      const p = r.p, rx = maxR * (.5 * p + .5 * p * p), ry = rx * tilt, cy = sy + ry * .1;
      const a = r.e * Math.pow(1 - p, 1.5), k = Math.min(1, p * 3.2);
      if (a < .01 || rx < 1) continue;
      const lg = c.createLinearGradient(0, cy - ry, 0, cy + ry);
      lg.addColorStop(0, mix(k, a * .22)); lg.addColorStop(.5, mix(k, a * .6)); lg.addColorStop(1, mix(k, Math.min(1, a * 1.05)));
      c.strokeStyle = lg; c.lineWidth = (.7 + r.e * 1.5) * (1 + p * 1.7);
      c.beginPath(); c.ellipse(cx, cy, rx, ry, 0, 0, TAU); c.stroke();
    }
    c.restore();
  }
}
const lake = new Lake($("#first"), ".orb");
$("#firstRec").addEventListener("pointerenter", () => (lake.excite = 1));
$("#firstRec").addEventListener("pointerleave", () => (lake.excite = 0));
let lakeRaf = 0, lakeLast = 0, lakeDrawn = 0;
function lakeSync() {
  const on = document.body.dataset.view === "home" && !$("#first").hidden && !pageHidden();
  if (!on) return lakeStop();
  if (RM.matches) { lakeStop(); requestAnimationFrame(() => lake.resize()); return; }
  if (!lakeRaf) { lakeLast = performance.now(); lakeRaf = requestAnimationFrame(lakeFrame); }
}
function lakeStop() { cancelAnimationFrame(lakeRaf); lakeRaf = 0; }
function lakeFrame(now) {
  lakeRaf = requestAnimationFrame(lakeFrame);
  if (now - lakeDrawn < 33) return;   // ≤30 fps is plenty for slow water
  const dt = Math.min(.1, (now - lakeLast) / 1000); lakeLast = now; lakeDrawn = now;
  lake.step(dt);
}
RM.addEventListener?.("change", () => { lakeStop(); lakeSync(); });

// ---------------------------------------------------------------- global
for (const id of ["#noteTl", "#recTl"]) new ResizeObserver(() => (id === "#noteTl" ? drawNoteTl() : drawRecTl())).observe($(id));
document.addEventListener("visibilitychange", () => { stageSync(); lakeSync(); });
// desktop app: the tray hides the window without the page always seeing document.hidden, so it tells us directly
function pageHidden() { return document.hidden || window.meariHidden === true; }
window.meariSetHidden = (h) => { window.meariHidden = !!h; stageSync(); lakeSync(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("menu-open")) return setMenu(false);
  if (typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/" && document.body.dataset.view !== "rec") { e.preventDefault(); if (innerWidth <= 760) setMenu(true); $("#search").focus(); return; }
  if (document.body.dataset.view === "note" && noteMode === "study" && data?.study?.cards.length && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault(); ci += e.key === "ArrowLeft" ? -1 : 1; renderDeck();
  }
});
window.addEventListener("beforeunload", (e) => { if (rec) { e.preventDefault(); e.returnValue = ""; } });

syncControls(); applyMode(); setDoc("summary");
// browsers keep audio suspended until the page gets a click/key when it was opened by a shortcut
function gestureStart(ctx) {
  const o = document.createElement("div");
  o.className = "gesture";
  o.innerHTML = `<div><b>${t("아무 키나 누르거나 클릭하면 녹음이 시작돼요")}</b><small>${t("바로가기로 열린 창은 브라우저가 소리를 잠시 막아 둬요")}</small></div>`;
  const go = () => { ctx.resume(); o.remove(); removeEventListener("keydown", go, true); };
  o.onclick = go; addEventListener("keydown", go, true);
  document.body.append(o);
}
// desktop hotkey (Ctrl+Alt+M) opens ?rec=1: start a new note and record right away
async function quickRecord() {
  history.replaceState(null, "", location.pathname);
  await loadList().catch(() => {});
  const live = items.find((m) => m.status === "recording" && Date.now() / 1000 - m.updated < 40);
  if (live) { await openNote(live.id); return toast(t("다른 창에서 이미 녹음 중이에요"), true); }
  if (!engineOn) api("/engine/start", { method: "POST" }).catch(() => {});
  if (await newNote()) await startRec();
}
// UI language: the button names the other language; switching reloads (blocked while recording)
$("#langBtn").textContent = LANG === "en" ? "한국어" : "English";
$("#langBtn").title = LANG === "en" ? "한국어로 보기" : "View in English";
$("#langBtn").onclick = () => rec ? toast(t("녹음 중에는 언어를 바꿀 수 없어요."), true) : setLang(LANG === "en" ? "ko" : "en");
// summary engine (Windows-native runtime): one of Hermes' local models, or a subscription CLI (Claude Code / Codex)
let llmCur = "";
const isCloud = (v) => /^(claude|codex):/.test(v || "");
async function loadLlm() {
  let r;
  try { r = await api("/llm"); } catch { return; }
  if (!r.native || !r.options.length) return;
  llmCur = r.current;
  const opt = (o) => `<option value="${esc(o.id)}"${o.id === r.current ? " selected" : ""}>${esc(o.label)}${o.kind === "local" ? ` · ${o.gb}GB` : ""}</option>`;
  const group = (kind, name) => { const os = r.options.filter((o) => o.kind === kind); return os.length ? `<optgroup label="${esc(name)}">${os.map(opt).join("")}</optgroup>` : ""; };
  $("#llmSel").innerHTML = group("local", t("로컬 — 이 PC 안에서")) + group("cloud", t("구독 — 클라우드"));
  $("#llmRow").hidden = false;
  $("#llmCloud").hidden = !isCloud(llmCur);
}
$("#llmSel").onchange = async (e) => {
  const v = e.target.value, label = (e.target.selectedOptions[0]?.textContent || v).split(" · ")[0];  // drop the size
  if (isCloud(v) && !await confirmDlg(t("클라우드 엔진으로 바꿀까요?"),
    t("요약·퀴즈·질문 답변을 만들 때 원고가 {s} 쪽으로 보내져요. 녹음 파일은 보내지 않아요. 구독 사용량이 조금씩 쓰여요.", { s: label }), t("바꾸기"))) {
    e.target.value = llmCur;
    return;
  }
  try { await api("/llm", json("POST", { id: v })); llmCur = v; toast(t("요약 엔진: {s}", { s: label })); }
  catch (err) { e.target.value = llmCur; fail(err); }
  $("#llmCloud").hidden = !isCloud(llmCur);
};
loadLlm();
// desktop app (Tauri) tray/hotkey while this window is already open: never interrupt a running recording
window.meariQuickRecord = () => rec ? toast(t("이미 녹음 중이에요")) : quickRecord().catch(fail);
checkEngine(); engineTimer = setInterval(checkEngine, 5000);
if (new URLSearchParams(location.search).get("rec") === "1") quickRecord().catch(fail); else loadList().catch(fail);
