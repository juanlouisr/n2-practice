"use strict";

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const barRight = $("#bar-right");
const player = $("#player");
const STORE_KEY = "n2p.v1";
const LIVE_KEY = "n2p.live";

const SECTIONS = {
  vocab: { jp: "語彙", en: "Vocabulary", sizes: [10, 20, 30], pace: 30 },
  grammar: { jp: "文法", en: "Grammar", sizes: [10, 20, 30], pace: 40 },
  reading: { jp: "読解", en: "Reading", sizes: [2, 4, 6], unit: "passages", pace: 120 },
  listening: { jp: "聴解", en: "Listening", sizes: [5, 10, 15], pace: 0 },
};
const TYPES = {
  kanji_reading: "漢字読み", orthography: "表記", word_formation: "語形成", context: "文脈規定", paraphrase: "言い換え類義", usage: "用法",
  grammar_select: "文の文法1", ordering: "並べ替え", passage_grammar: "文章の文法",
  short: "短文", medium: "中文", integrated: "統合理解", long: "長文", info: "情報検索",
  task: "課題理解", point: "ポイント理解", summary: "概要理解", response: "即時応答", integrated_pair: "統合理解 (質問1・2)",
};

// The real N2 paper: questions per type, in the order they appear. Mock and custom tests are
// cut from this, so a smaller test keeps the same mix.
const PAPER = {
  lang: [["vocab", "kanji_reading", 5], ["vocab", "orthography", 5], ["vocab", "word_formation", 3], ["vocab", "context", 7],
    ["vocab", "paraphrase", 5], ["vocab", "usage", 5], ["grammar", "grammar_select", 12], ["grammar", "ordering", 5], ["grammar", "passage_grammar", 5]],
  reading: [["reading", "short", 5], ["reading", "medium", 9], ["reading", "integrated", 2], ["reading", "long", 3], ["reading", "info", 2]],
  listening: [["listening", "task", 5], ["listening", "point", 6], ["listening", "summary", 5], ["listening", "response", 12],
    ["listening", "integrated", 2], ["listening", "integrated_pair", 2]],
};
const PART_NAMES = { lang: "言語知識", reading: "読解", listening: "聴解" };
// The real paper gives 105 minutes to 52 language-knowledge and 21 reading questions; a common
// split is about 35 minutes for the first and 70 for the second. Listening runs on the audio.
const PART_SECS = { lang: 40, reading: 200, listening: 0 };
const MOCKS = {
  lang: { jp: "言語知識・読解", parts: { lang: 52, reading: 21 } },
  listen: { jp: "聴解", parts: { listening: 32 } },
};

let units = [];      // bank items plus live-generated ones
let patterns = [];   // grammar pattern names, for live generation
let store = loadStore();
let run = null;      // the drill in progress
let tick = null;

// ---------- storage ----------

function loadStore() {
  const empty = { q: {}, sessions: [], settings: {}, log: [] };
  try {
    return Object.assign(empty, JSON.parse(localStorage.getItem(STORE_KEY) || "{}"));
  } catch {
    return empty;
  }
}
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* private mode: progress lasts this visit */ }
}
function settings() {
  return Object.assign({
    mode: "practice", speed: 1, examDate: "2026-12-06", key: "",
    textModel: "gemini-3.8-flash", ttsModel: "gemini-3.8-flash-tts",
    custom: { lang: 20, reading: 8, listening: 10, minutes: 30, exam: true, minutesSet: false }, theme: "system",
  }, store.settings);
}
function loadLive() {
  try { return JSON.parse(localStorage.getItem(LIVE_KEY) || "[]"); } catch { return []; }
}
function saveLive(items) {
  // Live listening audio is a blob URL that dies with the page, so only text items are kept.
  const keep = items.filter((u) => u.section !== "listening").slice(-200);
  try { localStorage.setItem(LIVE_KEY, JSON.stringify(keep)); } catch { /* storage full or blocked */ }
}

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const ALLOWED = new Set(["U", "B", "STRONG", "EM", "BR", "RUBY", "RT", "RP", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "UL", "OL", "LI", "P", "SPAN"]);
// Live-generated text comes from a model, so only a few formatting tags survive.
function safeHTML(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        if (!ALLOWED.has(child.tagName)) { child.replaceWith(...child.childNodes); clean(node); return; }
        for (const a of [...child.attributes]) if (!["colspan", "rowspan"].includes(a.name)) child.removeAttribute(a.name);
        clean(child);
      } else if (child.nodeType !== 3) child.remove();
    }
  };
  const root = doc.body.firstChild;
  clean(root);
  return root.innerHTML;
}
function passageHTML(text) {
  return String(text).split(/\n{2,}/).map((chunk) => {
    const t = chunk.trim();
    if (/^<(table|ul|ol)/i.test(t)) return `<div class="table-wrap">${safeHTML(t)}</div>`;
    return `<p>${safeHTML(t).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}
function qkeys(u) {
  return u.questions ? u.questions.map((_, k) => `${u.id}#${k + 1}`) : [u.id];
}
function questionsOf(u) {
  return u.questions ? u.questions : [u];
}
function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
function daysLeft() {
  const d = new Date(settings().examDate + "T09:00:00+09:00");
  return Math.ceil((d - Date.now()) / 86400000);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function setActions(html) {
  let bar = $(".actions");
  if (!html) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.className = "actions"; document.body.append(bar); }
  bar.innerHTML = `<div class="inner">${html}</div>`;
  return bar;
}
function stopTimer() { clearInterval(tick); tick = null; barRight.innerHTML = ""; }

// ---------- stats ----------

function sectionStats(section) {
  const us = units.filter((u) => u.section === section && !u.live);
  let total = 0, seen = 0, ok = 0, wrong = 0;
  for (const u of us) for (const k of qkeys(u)) {
    total++;
    const r = store.q[k];
    if (r) { seen++; if (r.lastOk) ok++; else wrong++; }
  }
  return { total, seen, ok, wrong, acc: seen ? Math.round((ok / seen) * 100) : null, units: us.length };
}
/**
 * Every answer: the per-question summary in `store.q`, plus one entry in `store.log`
 * ({t: time, k: key, c: 1 right / 0 wrong, s: seconds or null, x: 1 in an exam}) for trends.
 */
const LOG_CAP = 8000;
function record(key, correct, secs = null, exam = false) {
  const r = store.q[key] || { n: 0, ok: 0 };
  r.n++; if (correct) r.ok++;
  r.lastOk = correct; r.last = Date.now();
  store.q[key] = r;
  store.log.push({ t: r.last, k: key, c: correct ? 1 : 0, s: secs === null ? null : Math.round(secs * 10) / 10, x: exam ? 1 : 0 });
  if (store.log.length > LOG_CAP) store.log.splice(0, store.log.length - LOG_CAP);
  saveStore();
}

// ---------- choosing questions ----------

function pickUnits(section, n, type, mistakes) {
  let pool = units.filter((u) => u.section === section && (!type || u.type === type));
  if (mistakes) pool = pool.filter((u) => qkeys(u).some((k) => store.q[k] && !store.q[k].lastOk));
  // Unseen first, then ones you got wrong, then the longest since you last saw them.
  const rank = (u) => {
    const rs = qkeys(u).map((k) => store.q[k]);
    if (rs.some((r) => !r)) return Math.random();
    if (rs.some((r) => !r.lastOk)) return 1 + Math.random();
    return 2 + Math.min(...rs.map((r) => r.last)) / 1e13;
  };
  return pool.map((u) => [rank(u), u]).sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
}

// ---------- home ----------

const homeState = { size: {}, type: {} };

// ---------- theme ----------

const themeBtn = $("#theme-btn");
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const PAPER_COLOR = { light: "#f4f5f1", dark: "#131614" };  // --paper, for the browser's own toolbar
const themeIsDark = () => (settings().theme === "system" ? darkQuery.matches : settings().theme === "dark");
function applyTheme() {
  const t = settings().theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = themeIsDark();
  themeBtn.textContent = dark ? "☀" : "☾";
  themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.content = t === "system" ? PAPER_COLOR[m.media.includes("dark") ? "dark" : "light"] : PAPER_COLOR[t];
  });
}
function setTheme(t) {
  store.settings.theme = t;
  saveStore();
  applyTheme();
  const sel = $("#set-theme");
  if (sel) sel.value = t;
}
themeBtn.addEventListener("click", () => setTheme(themeIsDark() ? "light" : "dark"));
darkQuery.addEventListener("change", applyTheme);
applyTheme();

// ---------- back navigation ----------

const backBtn = $("#back-btn");
let screen = "home";
function setScreen(name) {
  screen = name;
  backBtn.hidden = name === "home";
  themeBtn.hidden = name === "run" || name === "sheet";  // the timer needs the room on a phone
  backBtn.setAttribute("aria-label", name === "run" && run.i > 0 ? "Previous question" : "Back to home");
  // One history entry above the start page, so the phone's back gesture stays inside the app.
  if (name !== "home" && !history.state?.n2p) history.pushState({ n2p: true }, "");
}
function goBack() {
  if (screen === "run" && run.i > 0) { run.i--; renderUnit(); }
  else if (screen === "sheet") renderUnit();
  else if (screen === "run" && run.reviewing) renderResults();
  else if (!leaveOk()) setScreen(screen);  // stay; re-adds the history entry a back gesture used up
  else renderHome();
}
backBtn.addEventListener("click", goBack);
addEventListener("popstate", () => { if (screen !== "home") goBack(); });

function renderHome() {
  stopTimer(); setActions(null); player.pause();
  run = null;
  setScreen("home");
  if (history.state?.n2p) history.back();  // drop the entry setScreen pushed; its popstate is a no-op here
  const days = daysLeft();
  const s = settings();
  app.innerHTML = `
    <div class="stack">
      <section class="stack" style="gap:6px">
        <span class="eyebrow">JLPT N2 · ${esc(s.examDate)}</span>
        <div class="countdown"><b>${days > 0 ? days : 0}</b><span>${days > 0 ? "days until the exam" : "exam day has passed"}</span></div>
      </section>
      <section class="sections">${Object.keys(SECTIONS).map(sectionCard).join("")}</section>
      <article class="section-card">
        <header><span class="jp">模擬試験</span><span class="eyebrow">Mock test</span></header>
        <p class="note">Laid out like the real N2 paper. Change answers as often as you like and hand it in at the end; listening plays each item once.</p>
        <div class="row">
          <button class="btn" type="button" data-mock="lang">言語知識・読解 · ${Math.round(suggestedSecs(MOCKS.lang.parts) / 60)} min</button>
          <button class="btn" type="button" data-mock="listen">聴解 · ${MOCKS.listen.parts.listening} questions</button>
        </div>
      </article>
      ${customCard()}
      <nav class="links">
        <button class="btn secondary" type="button" data-go="stats">Progress</button>
        <button class="btn secondary" type="button" data-go="settings">Settings</button>
      </nav>
      ${s.key ? "" : `<p class="note">Add a Gemini API key in Settings to generate fresh questions beyond the built-in set.</p>`}
    </div>`;
  app.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => (b.dataset.go === "stats" ? renderStats() : renderSettings())));
  for (const section of Object.keys(SECTIONS)) wireCard(section);
  app.querySelectorAll("[data-mock]").forEach((b) => b.addEventListener("click", () => startMock(b.dataset.mock)));
  wireCustom();
}

/** Questions available for each part of a test, so the inputs can't ask for more. */
function partSizes() {
  const n = {};
  for (const [part, blueprint] of Object.entries(PAPER)) {
    n[part] = blueprint.reduce((s, [section, type]) => s + units.filter((u) => u.section === section && u.type === type && !u.live)
      .reduce((t, u) => t + qkeys(u).length, 0), 0);
  }
  return n;
}
function customCard() {
  const c = settings().custom;
  const max = partSizes();
  const input = (part, en) => `<div class="count-row">
      <label for="cu-${part}"><span class="jp-label">${PART_NAMES[part]}</span> <span class="note">${en}</span></label>
      <input id="cu-${part}" type="number" inputmode="numeric" min="0" max="${max[part]}" step="1" value="${c[part]}" data-part="${part}">
    </div>`;
  return `<article class="section-card" data-custom>
      <header><span class="jp">カスタム</span><span class="eyebrow">Custom test</span></header>
      <p class="note">Pick how many questions of each part. They're mixed like the real paper, in the same order.</p>
      <div class="counts">
        ${input("lang", "vocabulary & grammar")}
        ${input("reading", "reading")}
        ${input("listening", "listening")}
      </div>
      <div class="row" role="group" aria-label="Mode">
        <button class="chip" type="button" data-cmode="exam" aria-pressed="${c.exam}">Exam</button>
        <button class="chip" type="button" data-cmode="practice" aria-pressed="${!c.exam}">Practice</button>
      </div>
      <div class="count-row" data-minutes-row ${c.exam ? "" : "hidden"}>
        <label for="cu-minutes">Time limit <span class="note">minutes · 0 for none</span></label>
        <input id="cu-minutes" type="number" inputmode="numeric" min="0" step="1" value="${c.minutes}">
      </div>
      <p class="note" data-custom-note></p>
      <button class="btn" type="button" data-custom-start>Start custom test</button>
    </article>`;
}
function wireCustom() {
  const card = app.querySelector("[data-custom]");
  const max = partSizes();
  const c = { ...settings().custom };
  const save = () => { store.settings.custom = { ...c }; saveStore(); };
  const note = card.querySelector("[data-custom-note]");
  const start = card.querySelector("[data-custom-start]");
  const minutes = card.querySelector("#cu-minutes");
  const refresh = () => {
    // Until you type your own limit, it follows the real exam's pace for the questions chosen.
    if (!c.minutesSet) { c.minutes = Math.round(suggestedSecs(c) / 60); minutes.value = c.minutes; }
    const n = c.lang + c.reading + c.listening;
    start.disabled = !n;
    note.textContent = !n ? "Choose at least one question."
      : `${n} questions${c.exam ? (c.minutes ? ` · ${c.minutes} min` : " · no time limit") : " · answers shown as you go"}${c.listening && c.exam ? " · listening plays once" : ""}.`;
    save();
  };
  card.querySelectorAll("[data-part]").forEach((el) => el.addEventListener("input", () => {
    const part = el.dataset.part;
    c[part] = Math.max(0, Math.min(max[part], Math.floor(Number(el.value) || 0)));
    refresh();
  }));
  card.querySelectorAll("[data-part]").forEach((el) => el.addEventListener("change", () => { el.value = c[el.dataset.part]; }));
  minutes.addEventListener("input", () => {
    c.minutes = Math.max(0, Math.floor(Number(minutes.value) || 0));
    c.minutesSet = minutes.value !== "";
    refresh();
  });
  card.querySelectorAll("[data-cmode]").forEach((b) => b.addEventListener("click", () => {
    c.exam = b.dataset.cmode === "exam";
    card.querySelectorAll("[data-cmode]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    card.querySelector("[data-minutes-row]").hidden = !c.exam;
    refresh();
  }));
  start.addEventListener("click", startCustom);
  refresh();
}

function sectionCard(section) {
  const meta = SECTIONS[section];
  const st = sectionStats(section);
  const size = homeState.size[section] || meta.sizes[0];
  const order = Object.values(PAPER).flat().filter((b) => b[0] === section).map((b) => b[1]);
  const types = [...new Set(units.filter((u) => u.section === section).map((u) => u.type))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const pct = st.total ? (st.seen / st.total) * 100 : 0;
  return `
    <article class="section-card" data-section="${section}">
      <header><span class="jp">${meta.jp}</span><span class="eyebrow">${meta.en}</span></header>
      <div class="meter" title="Questions seen"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="stats-line">
        <span>Seen <b>${st.seen}</b>/${st.total}</span>
        <span>Correct <b>${st.acc === null ? "–" : st.acc + "%"}</b></span>
        <span>To retry <b>${st.wrong}</b></span>
      </div>
      <div class="row" role="group" aria-label="Set size">
        ${meta.sizes.map((n) => `<button class="chip" type="button" data-size="${n}" aria-pressed="${n === size}">${n}${meta.unit ? " " + meta.unit : ""}</button>`).join("")}
      </div>
      <div class="field">
        <label for="type-${section}" class="sr-only" style="position:absolute;left:-9999px">Question type</label>
        <select id="type-${section}">
          <option value="">All types</option>
          ${types.map((t) => `<option value="${t}" ${homeState.type[section] === t ? "selected" : ""}>${TYPES[t] || t}</option>`).join("")}
        </select>
      </div>
      <div class="row">
        <button class="btn" type="button" data-start>Start</button>
        <button class="btn secondary" type="button" data-exam title="Change answers until you submit; results at the end">Exam</button>
        <button class="btn secondary" type="button" data-mistakes ${st.wrong ? "" : "disabled"}>Retry mistakes</button>
        ${settings().key ? `<button class="btn secondary" type="button" data-live>Fresh set</button>` : ""}
      </div>
      <p class="toast" data-toast hidden></p>
    </article>`;
}

function wireCard(section) {
  const card = app.querySelector(`[data-section="${section}"]`);
  const meta = SECTIONS[section];
  card.querySelectorAll("[data-size]").forEach((b) => b.addEventListener("click", () => {
    homeState.size[section] = Number(b.dataset.size);
    card.querySelectorAll("[data-size]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));
  const sel = card.querySelector("select");
  sel.addEventListener("change", () => { homeState.type[section] = sel.value; });
  const size = () => homeState.size[section] || meta.sizes[0];
  card.querySelector("[data-start]").addEventListener("click", () => startRun(section, pickUnits(section, size(), sel.value, false)));
  const exam = () => startExam(section, pickUnits(section, size(), sel.value, false), exam);
  card.querySelector("[data-exam]").addEventListener("click", exam);
  card.querySelector("[data-mistakes]").addEventListener("click", () => startRun(section, pickUnits(section, size(), sel.value, true)));
  card.querySelector("[data-live]")?.addEventListener("click", async (e) => {
    const toast = card.querySelector("[data-toast]");
    e.currentTarget.disabled = true;
    toast.hidden = false;
    try {
      const fresh = await generateLive(section, sel.value, size(), (msg) => { toast.textContent = msg; });
      units.push(...fresh);
      saveLive(units.filter((u) => u.live));
      startRun(section, fresh);
    } catch (err) {
      toast.textContent = `Couldn't generate: ${err.message}`;
      e.currentTarget.disabled = false;
    }
  });
}

// ---------- drill ----------

/**
 * A set of questions. Practice marks each answer as you go; an exam (`exam: true`) lets you
 * change answers, hides results until you submit, plays listening once, and has a time limit
 * (`limit`, seconds; 0 = none). `again` starts another set like this one.
 */
function startRun(section, list, { exam = false, limit = 0, again } = {}) {
  if (!list.length) return;
  run = { section, units: list, i: 0, results: [], start: Date.now(), exam, limit, answers: {}, played: {},
          again: again || (() => startRun(section, pickUnits(section, homeState.size[section] || SECTIONS[section].sizes[0], homeState.type[section], false))) };
  stopTimer();
  tick = setInterval(updateTimer, 1000);
  renderUnit();
}
const examLive = () => Boolean(run?.exam && !run.submitted);
function startExam(section, list, again) {
  startRun(section, list, { exam: true, limit: list.reduce((s, u) => s + paceFor(u), 0), again });
}
/**
 * Questions for a test of `counts` ({lang, reading, listening} → number of questions), split over
 * the types in the real paper's proportions and order. A passage is taken only if all its
 * questions fit; what a type can't fill passes to the next type, then round again from the top.
 */
function compose(counts) {
  const list = [];
  for (const [part, blueprint] of Object.entries(PAPER)) {
    const n = counts[part] || 0;
    if (!n) continue;
    const total = blueprint.reduce((s, b) => s + b[2], 0);
    // Largest remainder, so the per-type targets add up to n exactly.
    const raw = blueprint.map((b) => (b[2] * n) / total);
    const want = raw.map(Math.floor);
    raw.map((r, k) => [r - want[k], k]).sort((a, b) => b[0] - a[0]).slice(0, n - want.reduce((s, x) => s + x, 0))
      .forEach(([, k]) => want[k]++);
    const picked = blueprint.map(() => []);
    const pools = blueprint.map(([section, type]) => pickUnits(section, Infinity, type, false));
    let carry = 0;
    for (let pass = 0; pass < 2; pass++) {
      blueprint.forEach((_, k) => {
        let room = (pass ? 0 : want[k]) + carry;
        for (const u of pools[k]) {
          const size = qkeys(u).length;
          if (size > room || picked[k].includes(u)) continue;
          picked[k].push(u);
          room -= size;
          if (!room) break;
        }
        carry = room;
      });
    }
    list.push(...picked.flat());
  }
  return list;
}
const suggestedSecs = (counts) => Object.keys(PAPER).reduce((s, p) => s + (counts[p] || 0) * PART_SECS[p], 0);
function startMock(key) {
  const parts = MOCKS[key].parts;
  startRun(`mock-${key}`, compose(parts), { exam: true, limit: suggestedSecs(parts), again: () => startMock(key) });
}
function startCustom() {
  const c = settings().custom;
  const go = () => startRun("custom", compose(c), { exam: c.exam, limit: c.exam ? c.minutes * 60 : 0, again: go });
  go();
}

function updateTimer() {
  if (!run) return;
  if (run.reviewing) { barRight.innerHTML = `<span>Review ${run.i + 1}/${run.units.length}</span>`; return; }
  if (examLive()) {
    const spent = (Date.now() - run.start) / 1000;
    const left = run.limit - spent;
    if (run.limit && left <= 0) return submitExam(true);
    const total = run.units.reduce((s, u) => s + qkeys(u).length, 0);
    barRight.innerHTML = `<span title="Answered">${Object.keys(run.answers).length}/${total} done</span>` + (run.limit
      ? `<span class="timer ${left < 300 ? "over" : ""}" title="Time left">${fmt(left)} left</span>`
      : `<span class="timer" title="Time so far">${fmt(spent)}</span>`);
    return;
  }
  const unitT = (Date.now() - run.unitStart) / 1000;
  const pace = paceFor(run.units[run.i]);
  const over = pace && unitT > pace && !run.done;
  barRight.innerHTML = `<span>${run.i + 1}/${run.units.length}</span><span class="timer ${over ? "over" : ""}" title="Time on this question${pace ? `; exam pace ${fmt(pace)}` : ""}">${fmt(unitT)}${pace ? ` / ${fmt(pace)}` : ""}</span>`;
}
function paceFor(u) {
  if (!u) return 0;
  if (u.section === "listening") return 0;
  if (u.type === "long" || u.type === "integrated") return 150 * u.questions.length;
  if (u.questions) return (u.section === "reading" ? 100 : 45) * u.questions.length;
  return SECTIONS[u.section].pace;
}

function renderUnit() {
  const u = run.units[run.i];
  run.unitStart = Date.now();
  run.lastAnswerAt = null;
  run.done = false;
  run.answered = 0;
  setScreen("run");
  updateTimer();
  player.pause();
  window.scrollTo(0, 0);
  setActions(null);
  const head = `<div class="q-head"><span>${SECTIONS[u.section].jp} · ${TYPES[u.type] || u.type}${u.live ? " · fresh" : ""}</span><span>${esc(u.id)}</span></div>`;
  if (u.section === "listening") renderListening(u, head);
  else if (u.questions) renderGroup(u, head);
  else {
    app.innerHTML = `<div class="stack">${head}<p class="prompt">${esc(u.prompt || "")}</p>
      <p class="stem ${u.type === "usage" ? "word" : ""}">${safeHTML(u.stem)}</p>
      <div data-q></div></div>`;
    mountQuestion($("[data-q]"), u, u.id, () => finishUnit());
  }
  if (examLive()) examActions();
}

// ---------- exam ----------

function examActions() {
  const last = run.i === run.units.length - 1;
  const bar = setActions(`<button class="btn secondary" type="button" data-sheet>Answer sheet</button><button class="btn" type="button" data-next>${last ? "Finish" : "Next"}</button>`);
  bar.querySelector("[data-sheet]").addEventListener("click", renderSheet);
  bar.querySelector("[data-next]").addEventListener("click", () => {
    if (last) return renderSheet();
    run.i++;
    renderUnit();
  });
}

function renderSheet() {
  player.pause();
  setScreen("sheet");
  window.scrollTo(0, 0);
  let n = 0;
  const cells = run.units.map((u, ui) => qkeys(u).map((k) => {
    const a = run.answers[k];
    return `<button class="cell ${a === undefined ? "" : "done"}" type="button" data-unit="${ui}"><span>${++n}</span><b>${a === undefined ? "–" : a + 1}</b></button>`;
  }).join("")).join("");
  const open = n - Object.keys(run.answers).length;
  app.innerHTML = `<div class="stack">
    <h1>Answer sheet</h1>
    <p class="muted">${n - open} of ${n} answered. Tap a number to go back to that question.</p>
    <div class="sheet">${cells}</div>
    <p class="note" data-confirm hidden></p>
  </div>`;
  app.querySelectorAll("[data-unit]").forEach((b) => b.addEventListener("click", () => { run.i = Number(b.dataset.unit); renderUnit(); }));
  const bar = setActions(`<button class="btn secondary" type="button" data-resume>Back to questions</button><button class="btn" type="button" data-submit>Submit</button>`);
  bar.querySelector("[data-resume]").addEventListener("click", renderUnit);
  let warned = false;
  bar.querySelector("[data-submit]").addEventListener("click", () => {
    if (open && !warned) {
      warned = true;
      const note = $("[data-confirm]");
      note.hidden = false;
      note.textContent = `${open} question${open > 1 ? "s are" : " is"} unanswered and will count as wrong. Press Submit again to hand it in.`;
      return;
    }
    submitExam(false);
  });
}

function submitExam(timeUp) {
  run.submitted = true;
  run.timeUp = timeUp;
  for (const u of run.units) qkeys(u).forEach((key, k) => {
    const q = questionsOf(u)[k];
    const picked = run.answers[key] ?? -1;
    record(key, picked === q.answer, null, true);
    run.results.push({ key, unit: u, q, correct: picked === q.answer, picked });
  });
  renderResults();
}

/** Leaving an exam before submitting throws the answers away, so ask first. */
function leaveOk() {
  return !examLive() || !Object.keys(run.answers).length || confirm("Leave this exam? Your answers won't be saved.");
}
addEventListener("beforeunload", (e) => { if (examLive() && Object.keys(run.answers).length) e.preventDefault(); });

/** Choices as mark-sheet rows. `spoken` hides the text until answered (listening). */
function mountQuestion(el, q, key, onDone, { spoken = false } = {}) {
  const ul = document.createElement("ul");
  ul.className = "choices" + (spoken ? " compact" : "");
  q.choices.forEach((c, k) => {
    const li = document.createElement("li");
    li.innerHTML = `<button class="choice" type="button"><span class="bubble">${k + 1}</span>${spoken ? "" : `<span>${safeHTML(c)}</span>`}</button>`;
    ul.append(li);
  });
  el.append(ul);
  const buttons = [...ul.querySelectorAll(".choice")];
  const reveal = (k) => {
    const correct = k === q.answer;
    if (spoken) { ul.classList.remove("compact"); buttons.forEach((x, j) => x.insertAdjacentHTML("beforeend", `<span>${safeHTML(q.choices[j])}</span>`)); }
    buttons.forEach((x, j) => {
      x.disabled = true;
      if (j === k) x.classList.add("picked");
      if (j === q.answer) x.classList.add("right");
      else if (j === k) x.classList.add("wrong");
      if (q.why_wrong?.[j] && j !== q.answer) x.insertAdjacentHTML("beforeend", `<span class="why">${esc(q.why_wrong[j])}</span>`);
    });
    const v = document.createElement("div");
    v.className = `verdict ${correct ? "ok" : "bad"}`;
    let extra = "";
    if (q.type === "ordering" && q.order) {
      let n = 0;
      const full = q.stem.replace(/＿＿|★/g, () => `<u>${safeHTML(q.choices[q.order[n++]])}</u>`);
      extra = `<p>正しい文：${full}</p>`;
    }
    v.innerHTML = `<strong>${correct ? "正解" : `${k < 0 ? "未回答" : "不正解"} · answer ${q.answer + 1}`}</strong>${extra}<p>${esc(q.explanation)}</p>`;
    el.append(v);
    onDone();
  };
  if (examLive()) {
    // A mark sheet: tap to mark, tap another to change, tap the same one again to erase.
    const mark = () => buttons.forEach((x, j) => {
      x.classList.toggle("picked", run.answers[key] === j);
      x.setAttribute("aria-pressed", run.answers[key] === j);
    });
    buttons.forEach((b, k) => b.addEventListener("click", () => {
      if (run.answers[key] === k) delete run.answers[key];
      else run.answers[key] = k;
      mark();
      updateTimer();
    }));
    return mark();
  }
  // Coming back to a question already answered in this set shows that answer again.
  const prior = run.results.find((r) => r.key === key);
  if (prior) return reveal(prior.picked);
  buttons.forEach((b, k) => b.addEventListener("click", () => {
    // Time since the question (or the passage's previous question) appeared. Listening time is
    // set by the audio, so it isn't counted.
    const unit = run.units[run.i];
    const now = Date.now();
    const secs = unit.section === "listening" ? null : (now - (run.lastAnswerAt || run.unitStart)) / 1000;
    run.lastAnswerAt = now;
    record(key, k === q.answer, secs);
    run.results.push({ key, unit, q, correct: k === q.answer, picked: k });
    reveal(k);
  }));
}

function renderGroup(u, head) {
  const passages = u.passage_b
    ? `<div class="passage"><p class="label">A</p>${passageHTML(u.passage)}</div><div class="passage"><p class="label">B</p>${passageHTML(u.passage_b)}</div>`
    : `<div class="passage">${u.title ? `<p class="label">${esc(u.title)}</p>` : ""}${passageHTML(u.passage)}</div>`;
  app.innerHTML = `<div class="stack">${head}<p class="prompt">${esc(u.prompt || "")}</p>${passages}<div class="stack" data-qs></div></div>`;
  const box = $("[data-qs]");
  u.questions.forEach((q, k) => {
    const div = document.createElement("div");
    div.className = "subq";
    div.innerHTML = `<h3>問${k + 1}　${safeHTML(q.q)}</h3>`;
    box.append(div);
    mountQuestion(div, q, `${u.id}#${k + 1}`, () => { if (++run.answered === u.questions.length) finishUnit(); });
  });
}

// ---------- listening ----------

let stopAt = null;
function playRange(start, end) {
  player.currentTime = start;
  stopAt = end;
  player.play().catch(() => {});
}
function watchPlayback(onFrame) {
  const step = () => {
    if (stopAt !== null && player.currentTime >= stopAt) { player.pause(); stopAt = null; }
    onFrame?.();
    if (!player.paused) requestAnimationFrame(step);
  };
  player.onplay = () => requestAnimationFrame(step);
}

function renderListening(u, head) {
  const s = settings();
  const strict = examLive();
  const exam = strict || s.mode === "exam";
  const printed = u.choice_mode === "printed";
  app.innerHTML = `<div class="stack">${head}
    <div class="player">
      <button class="play" type="button" data-play>▶ Play</button>
      <div class="progress"><i data-bar></i></div>
      <div class="row" style="justify-content:space-between">
        <span class="note">${strict ? "Exam: plays once, by itself, with no pausing." : exam ? "Exam mode: plays once." : "Practice mode: replay as often as you like."}</span>
        ${exam ? "" : `<label class="note">Speed <select data-speed style="min-height:36px;border-radius:8px;border:1px solid var(--rule);background:var(--sheet);padding:4px 6px">
          ${[0.85, 1, 1.1].map((r) => `<option value="${r}" ${Number(s.speed) === r ? "selected" : ""}>${r}×</option>`).join("")}</select></label>`}
      </div>
    </div>
    ${printed ? `<p class="prompt">Choices (printed in the booklet):</p>` : `<p class="prompt">Choices are read aloud after the question. Pick a number.</p>`}
    <div data-q></div>
    <div data-transcript></div></div>`;
  player.src = u.audio;
  player.playbackRate = exam ? 1 : Number(s.speed);
  const playBtn = $("[data-play]");
  const bar = $("[data-bar]");
  let plays = 0;
  watchPlayback(() => { if (player.duration) bar.style.width = `${(player.currentTime / player.duration) * 100}%`; });
  if (strict) {
    stopAt = null;
    const done = () => { playBtn.disabled = true; playBtn.textContent = "Played"; bar.style.width = "100%"; };
    const once = () => player.play().then(() => {
      run.played[u.id] = true;
      playBtn.disabled = true;
      playBtn.textContent = "Playing…";
    }).catch(() => { playBtn.disabled = false; playBtn.textContent = "▶ Play (once)"; });
    player.onplaying = player.onpause = null;
    player.onended = done;
    playBtn.addEventListener("click", once);
    if (run.played[u.id]) done();
    else { playBtn.disabled = true; once(); }  // the tap on Next counts as the gesture browsers want
    mountListeningQuestions(u, printed, () => {});
    return;
  }
  playBtn.addEventListener("click", () => {
    if (!player.paused) { player.pause(); return; }
    if (player.ended || player.currentTime >= (player.duration || Infinity) - 0.05) player.currentTime = 0;
    stopAt = null;
    player.play().then(() => { plays++; }).catch(() => { playBtn.textContent = "Tap again to play"; });
  });
  player.onpause = player.onended = () => {
    playBtn.textContent = player.currentTime > 0 && !player.ended ? "▶ Resume" : "▶ Play again";
    if (exam && plays && player.ended) playBtn.disabled = true;
  };
  player.onplaying = () => { playBtn.textContent = "❚❚ Pause"; };
  $("[data-speed]")?.addEventListener("change", (e) => {
    player.playbackRate = Number(e.target.value);
    store.settings.speed = Number(e.target.value); saveStore();
  });
  mountListeningQuestions(u, printed, () => { finishUnit(); showTranscript(u); });
}

/** One question, or 質問1・2 with the same printed choices (their wording is only spoken). */
function mountListeningQuestions(u, printed, onAll) {
  const box = $("[data-q]");
  if (!u.questions) return mountQuestion(box, u, u.id, onAll, { spoken: !printed });
  let answered = 0;
  u.questions.forEach((q, k) => {
    const div = document.createElement("div");
    div.className = "subq";
    div.innerHTML = `<h3>質問${k + 1}</h3>`;
    box.append(div);
    mountQuestion(div, q, `${u.id}#${k + 1}`, () => { if (++answered === u.questions.length) onAll(); });
  });
}

function showTranscript(u) {
  const seg = (kind, i) => (u.segments || []).find((x) => x.kind === kind && (i === undefined || x.i === i));
  const row = (who, jp, en, sg) => `<li><button class="line" type="button" ${sg ? `data-start="${sg.start}" data-end="${sg.end}"` : "disabled"}>
      <span class="who">${esc(who)}</span><span><span class="jp">${esc(jp)}</span>${en ? `<span class="en">${esc(en)}</span>` : ""}</span></button></li>`;
  let html = "";
  if (u.setup) html += row("ナレ", u.setup, "", seg("setup"));
  u.lines.forEach((l, i) => { html += row(l.speaker, l.text, l.en, seg("line", i)); });
  if (u.question) html += row("ナレ", u.question, "", seg("question"));
  (u.questions || []).forEach((q, k) => { html += row("ナレ", q.q, "", seg("question", k)); });
  if (u.choice_mode === "spoken") u.choices.forEach((c, i) => { html += row(`${i + 1}`, c, "", seg("choice", i)); });
  const box = $("[data-transcript]");
  box.innerHTML = `<div class="panel"><h3>Transcript <span class="note">· tap a line to hear it again</span></h3><ul class="transcript">${html}</ul></div>`;
  $("[data-play]").disabled = false;
  box.querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", () => {
    box.querySelectorAll(".line.now").forEach((x) => x.classList.remove("now"));
    b.classList.add("now");
    playRange(Number(b.dataset.start), Number(b.dataset.end));
  }));
}

// ---------- flow ----------

function finishUnit() {
  run.done = true;
  const last = run.i === run.units.length - 1;
  const bar = setActions(`<button class="btn" type="button" data-next>${last ? (run.reviewing ? "Back to results" : "See results") : "Next"}</button>`);
  bar.querySelector("[data-next]").addEventListener("click", () => {
    if (last) return renderResults();
    run.i++;
    renderUnit();
  });
}

function renderResults() {
  stopTimer(); setActions(null); player.pause();
  setScreen("results");
  run.end ??= Date.now();
  const secs = (run.end - run.start) / 1000;
  const ok = run.results.filter((r) => r.correct).length;
  const n = run.results.length;
  if (!run.saved) {  // coming back from Review answers shows the same set, not a new one
    run.saved = true;
    store.sessions.push({ t: Date.now(), section: run.section, n, ok, secs: Math.round(secs), ...(run.exam ? { exam: true } : {}) });
    store.sessions = store.sessions.slice(-300);
    saveStore();
  }
  const byType = {};
  for (const r of run.results) {
    const t = TYPES[r.unit.type] || r.unit.type;
    byType[t] = byType[t] || [0, 0];
    byType[t][1]++; if (r.correct) byType[t][0]++;
  }
  const wrong = run.results.filter((r) => !r.correct);
  app.innerHTML = `<div class="stack">
    <span class="eyebrow">${sectionLabel(run.section)}${run.exam ? " · exam" : ""}</span>
    <div class="row" style="align-items:baseline;gap:14px"><span class="score">${ok}/${n}</span><span class="muted">${Math.round((ok / n) * 100)}% · ${fmt(secs)}</span></div>
    ${run.timeUp ? `<p class="verdict bad">Time ran out, so the sheet was handed in automatically.</p>` : ""}
    <div class="row"><button class="btn secondary" type="button" data-review>Review answers</button></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Type</th><th class="num">Correct</th></tr></thead><tbody>
      ${Object.entries(byType).map(([t, [a, b]]) => `<tr><td>${t}</td><td class="num">${a}/${b}</td></tr>`).join("")}
    </tbody></table></div>
    ${wrong.length ? `<h2>To review</h2><ul class="stack" style="list-style:none;padding:0;margin:0">${wrong.map((r) => `
      <li class="panel" style="gap:6px"><span class="note">${esc(r.key)} · ${TYPES[r.unit.type] || ""}</span>
      <span style="font-family:var(--font-text)">${safeHTML(r.q.stem || r.q.q || r.unit.question || r.unit.lines?.[0]?.text || "")}</span>
      <span>Answer: <b>${r.q.answer + 1}. ${safeHTML(r.q.choices[r.q.answer])}</b> · yours: ${r.picked < 0 ? "none" : r.picked + 1}</span>
      <span class="note">${esc(r.q.explanation)}</span></li>`).join("")}</ul>` : `<p>All correct.</p>`}
  </div>`;
  const bar = setActions(`<button class="btn secondary" type="button" data-home>Home</button><button class="btn" type="button" data-again>Next set</button>`);
  bar.querySelector("[data-home]").addEventListener("click", renderHome);
  bar.querySelector("[data-again]").addEventListener("click", run.again);
  $("[data-review]").addEventListener("click", () => { run.reviewing = true; run.i = 0; renderUnit(); });
}
function sectionLabel(section, short = false) {
  if (SECTIONS[section]) return short ? SECTIONS[section].jp : `${SECTIONS[section].jp} · ${SECTIONS[section].en}`;
  if (section === "custom") return short ? "カスタム" : "カスタム · Custom test";
  const m = MOCKS[section.replace("mock-", "")];
  return short ? `模試 ${m?.jp || ""}` : `模擬試験 · ${m?.jp || ""}`;
}

// ---------- progress ----------

const DAY = 86400000;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const PASS = { section: 19, total: 90 };  // JLPT N2: 19 of 60 in each section, 90 of 180 overall

/** Everything the Progress page shows, from store.q (per question), store.log (per answer) and store.sessions. */
function computeProgress() {
  const keyUnit = new Map();
  for (const u of units) if (!u.live) for (const k of qkeys(u)) keyUnit.set(k, u);
  const log = store.log.filter((e) => keyUnit.has(e.k));
  const rate = (es) => pct(es.filter((e) => e.c).length, es.length);

  const types = [];
  for (const [part, blueprint] of Object.entries(PAPER)) {
    const weight = blueprint.reduce((s, b) => s + b[2], 0);
    for (const [section, type, perPaper] of blueprint) {
      const us = units.filter((u) => !u.live && u.section === section && u.type === type);
      if (!us.length) continue;
      const keys = new Set(us.flatMap(qkeys));
      const seen = [...keys].filter((k) => store.q[k]);
      const lastOk = seen.filter((k) => store.q[k].lastOk).length;
      const entries = log.filter((e) => keys.has(e.k));
      const recent = entries.slice(-20), before = entries.slice(-40, -20);
      const timed = entries.filter((e) => e.s !== null && e.s < 600);  // ignore a question left open for ages
      const t = {
        part, section, type, perPaper, total: keys.size, seen: seen.length, wrongNow: seen.length - lastOk,
        acc: pct(lastOk, seen.length),
        recent: recent.length >= 5 ? rate(recent) : null,
        before: before.length >= 5 ? rate(before) : null,
        secs: timed.length >= 3 ? timed.reduce((s, e) => s + e.s, 0) / timed.length : null,
        pace: section === "listening" ? null : paceFor(us[0]) / qkeys(us[0]).length,
      };
      // The figure used for estimates: your last 20 answers, or failing that your last try on each question.
      t.score = t.recent ?? (t.seen >= 5 ? t.acc : null);
      // Points this type costs you in a real paper's 60-point section.
      t.lost = t.score === null ? null : (perPaper / weight) * 60 * (1 - t.score / 100);
      types.push(t);
    }
  }

  const estimate = {};
  for (const part of Object.keys(PAPER)) {
    const ts = types.filter((t) => t.part === part);
    const weight = ts.reduce((s, t) => s + t.perPaper, 0);
    const known = ts.filter((t) => t.score !== null);
    const kw = known.reduce((s, t) => s + t.perPaper, 0);
    // Only estimate a section once types worth at least half its questions have results.
    estimate[part] = kw / weight >= 0.5
      ? { score: Math.round((60 * known.reduce((s, t) => s + t.perPaper * t.score, 0)) / kw / 100), coverage: kw / weight }
      : null;
  }

  const today = startOfDay(Date.now());
  const days = Array.from({ length: 28 }, (_, i) => {
    const from = today - (27 - i) * DAY;
    const es = log.filter((e) => e.t >= from && e.t < from + DAY);
    return { t: from, n: es.length, acc: rate(es) };
  });
  const active = new Set(log.map((e) => startOfDay(e.t)));
  let streak = 0;
  for (let d = active.has(today) ? today : today - DAY; active.has(d); d -= DAY) streak++;

  const partOf = (k) => { const u = keyUnit.get(k); return u.section === "listening" ? "listening" : u.section === "reading" ? "reading" : "lang"; };
  const weeks = Object.fromEntries(Object.keys(PAPER).map((part) => [part, Array.from({ length: 8 }, (_, i) => {
    const to = today + DAY - (7 - i) * 7 * DAY;
    const es = log.filter((e) => e.t >= to - 7 * DAY && e.t < to && partOf(e.k) === part);
    return { to, n: es.length, acc: es.length >= 5 ? rate(es) : null };
  })]));

  const patternRows = {};
  for (const u of units) {
    if (u.live || u.section !== "grammar" || !u.pattern) continue;
    const r = store.q[u.id];
    if (!r) continue;
    const p = (patternRows[u.pattern] ||= { n: u.pattern, wrong: 0, stillWrong: 0, units: [] });
    p.wrong += r.n - r.ok;
    if (!r.lastOk) p.stillWrong++;
  }
  for (const u of units) if (!u.live && u.section === "grammar" && patternRows[u.pattern]) patternRows[u.pattern].units.push(u);
  const weakPatterns = Object.values(patternRows).filter((p) => p.wrong)
    .sort((a, b) => b.stillWrong - a.stillWrong || b.wrong - a.wrong).slice(0, 8);

  const week = log.filter((e) => e.t >= today - 6 * DAY);
  const weekSecs = store.sessions.filter((s) => s.t >= today - 6 * DAY).reduce((s, x) => s + x.secs, 0);
  return {
    types, estimate, days, streak, weeks, weakPatterns,
    answered: Object.values(store.q).reduce((s, r) => s + r.n, 0),
    weekAnswers: week.length, weekAcc: rate(week), weekSecs,
    examAcc: rate(log.filter((e) => e.x)), practiceAcc: rate(log.filter((e) => !e.x)),
    examN: log.filter((e) => e.x).length, practiceN: log.filter((e) => !e.x).length,
    logStart: log[0]?.t ?? null,
  };
}

/** Bars of answers per day; each bar's tooltip has the count and how many were right. */
function activityChart(days) {
  const max = Math.max(5, ...days.map((d) => d.n));
  const W = 28 * 10, H = 72;
  const bars = days.map((d, i) => {
    const h = d.n ? Math.max(3, (d.n / max) * (H - 4)) : 0;
    const label = `${shortDate(d.t)}: ${d.n} answered${d.acc === null ? "" : `, ${d.acc}% right`}`;
    return `<g><title>${esc(label)}</title><rect class="hit" x="${i * 10}" y="0" width="10" height="${H}"></rect>
      ${h ? `<path class="bar" d="M${i * 10 + 1},${H} v${-(h - 2)} q0,-2 2,-2 h4 q2,0 2,2 v${h - 2} z"></path>` : `<rect class="zero" x="${i * 10 + 1}" y="${H - 1}" width="8" height="1"></rect>`}</g>`;
  }).join("");
  return `<svg class="viz" viewBox="0 0 ${W} ${H + 16}" role="img" aria-label="Answers per day over the last four weeks">
      <line class="axis" x1="0" x2="${W}" y1="${H}" y2="${H}"></line>${bars}
      <text class="tick" x="0" y="${H + 13}">${esc(shortDate(days[0].t))}</text>
      <text class="tick" x="${W}" y="${H + 13}" text-anchor="end">today</text>
    </svg>`;
}

/** One section's weekly accuracy, 0-100%, with the 50% line the overall pass mark sits near. */
function trendChart(points) {
  // Drawn at roughly the size it shows on a phone (a third of the width), so marks keep their size.
  const W = 100, H = 64, x = (i) => 6 + i * ((W - 12) / 7), y = (v) => 6 + (H - 12) * (1 - v / 100);
  let path = "", pen = false;
  points.forEach((p, i) => {
    if (p.acc === null) { pen = false; return; }
    path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.acc).toFixed(1)}`;
    pen = true;
  });
  const dots = points.map((p, i) => (p.acc === null ? "" : `<g><title>${esc(`Week to ${shortDate(p.to - DAY)}: ${p.acc}% of ${p.n}`)}</title>
      <circle class="hit" cx="${x(i)}" cy="${y(p.acc)}" r="9"></circle><circle class="dot" cx="${x(i)}" cy="${y(p.acc)}" r="4"></circle></g>`)).join("");
  return `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly accuracy, last 8 weeks">
      <line class="ref" x1="0" x2="${W}" y1="${y(50)}" y2="${y(50)}"></line>
      <path class="line" d="${path}"></path>${dots}</svg>`;
}

function renderStats() {
  stopTimer(); setActions(null);
  setScreen("stats");
  const P = computeProgress();
  const parts = Object.keys(PAPER);
  const est = P.estimate;
  const total = parts.every((p) => est[p]) ? parts.reduce((s, p) => s + est[p].score, 0) : null;
  const passing = total !== null && total >= PASS.total && parts.every((p) => est[p].score >= PASS.section);
  const trend = (t) => (t.recent === null || t.before === null ? "" : t.recent - t.before >= 5 ? `<span class="up" title="Last 20 answers vs the 20 before">▲ ${t.recent - t.before}</span>`
    : t.before - t.recent >= 5 ? `<span class="down" title="Last 20 answers vs the 20 before">▼ ${t.before - t.recent}</span>` : "");
  const focus = P.types.filter((t) => t.lost !== null && t.lost >= 0.5).sort((a, b) => b.lost - a.lost).slice(0, 3);
  const untried = P.types.filter((t) => t.score === null).sort((a, b) => b.perPaper - a.perPaper).slice(0, 3);
  const unseen = Object.keys(SECTIONS).reduce((s, sec) => { const st = sectionStats(sec); return s + st.total - st.seen; }, 0);
  const days = Math.max(1, daysLeft());
  const recent = store.sessions.slice(-12).reverse();
  const typeName = (t) => `${TYPES[t.type] || t.type}`;
  const drill = (t) => `<button class="btn secondary small" type="button" data-drill="${t.section}/${t.type}">Practice</button>`;

  app.innerHTML = `<div class="stack">
    <h1>Progress</h1>
    <div class="tiles">
      <div class="tile"><span class="eyebrow">Answered</span><b>${P.answered}</b><span class="note">questions in all</span></div>
      <div class="tile"><span class="eyebrow">This week</span><b>${P.weekAcc === null ? "–" : P.weekAcc + "%"}</b><span class="note">right of ${P.weekAnswers}</span></div>
      <div class="tile"><span class="eyebrow">Streak</span><b>${P.streak}</b><span class="note">day${P.streak === 1 ? "" : "s"} in a row</span></div>
      <div class="tile"><span class="eyebrow">Study time</span><b>${Math.round(P.weekSecs / 60)}<small> min</small></b><span class="note">in sets this week</span></div>
    </div>

    <section class="panel">
      <h2>Estimated score</h2>
      ${parts.map((p) => `<div class="score-row">
        <span class="jp-label">${PART_NAMES[p]}</span>
        <div class="track" title="${est[p] ? `${est[p].score} of 60; pass needs ${PASS.section}` : "Not enough answers yet"}">
          ${est[p] ? `<i style="width:${(est[p].score / 60) * 100}%"></i>` : ""}<em style="left:${(PASS.section / 60) * 100}%"></em>
        </div>
        <span class="num">${est[p] ? `${est[p].score}<small>/60</small>` : `<small>need more</small>`}</span>
      </div>`).join("")}
      ${total === null ? `<p class="note">Answer more questions in each part for a full estimate. A part is estimated once types worth half its questions have at least 5 answers.</p>`
        : `<p class="status ${passing ? "ok" : "bad"}"><b>${passing ? "✓ On track to pass" : "! Below the pass mark"}</b> · ${total}/180 (pass: ${PASS.total}, and ${PASS.section} in each part)</p>`}
      <p class="note">Your accuracy on each question type, weighted by how many of that type the real paper has. Real JLPT scores are scaled, so read this as a rough guide. The line in each bar is the ${PASS.section}-point minimum.</p>
    </section>

    ${focus.length || untried.length ? `<section class="panel">
      <h2>Where the points are</h2>
      ${focus.map((t) => `<div class="focus-row"><span><b>${typeName(t)}</b> <span class="note">${PART_NAMES[t.part]} · ${t.score}% right</span><br>
        <span class="note">costs about ${t.lost.toFixed(1)} points per paper (${t.perPaper} question${t.perPaper > 1 ? "s" : ""} in the real test)</span></span>${drill(t)}</div>`).join("")}
      ${untried.length ? `<p class="note">Not tried enough yet: ${untried.map((t) => `${typeName(t)} (${PART_NAMES[t.part]}, ${t.perPaper} per paper)`).join(", ")}.</p>` : ""}
    </section>` : ""}

    <section class="panel">
      <h2>Last 4 weeks</h2>
      ${P.logStart ? activityChart(P.days) : `<p class="note">Answer a few questions and your daily activity shows up here.</p>`}
      <p class="note">Questions answered per day${P.logStart && P.logStart > Date.now() - 27 * DAY ? ` (tracked since ${shortDate(P.logStart)})` : ""}. Tap a bar for the day's numbers.</p>
    </section>

    <section class="panel">
      <h2>Weekly accuracy</h2>
      <div class="multiples">${parts.map((p) => `<figure><figcaption><span class="jp-label">${PART_NAMES[p]}</span>
        <span class="note">${(() => { const w = P.weeks[p].filter((x) => x.acc !== null); return w.length ? `${w.at(-1).acc}% latest` : "no full week yet"; })()}</span></figcaption>
        ${trendChart(P.weeks[p])}</figure>`).join("")}</div>
      <p class="note">Share right each week (weeks with at least 5 answers). The dashed line is 50%, about where the overall pass mark sits.</p>
    </section>

    <section class="panel">
      <h2>By question type</h2>
      ${parts.map((p) => `<h3>${PART_NAMES[p]}</h3><ul class="type-list">${P.types.filter((t) => t.part === p).map((t) => `<li>
        <div class="type-body">
          <div class="type-main"><b>${typeName(t)}</b>
            <span class="type-score">${t.score === null ? `<span class="note">–</span>` : `${t.score}%`} ${trend(t)}</span></div>
          <div class="meter" title="Seen ${t.seen} of ${t.total}"><i style="width:${(t.seen / t.total) * 100}%"></i></div>
          <div class="type-meta note"><span>seen ${t.seen}/${t.total}</span>${t.wrongNow ? `<span>${t.wrongNow} to retry</span>` : ""}
            ${t.secs !== null && t.pace ? `<span class="${t.secs > t.pace ? "slow" : ""}">${Math.round(t.secs)}s each (pace ${Math.round(t.pace)}s)</span>` : ""}</div>
        </div>${drill(t)}
      </li>`).join("")}</ul>`).join("")}
      <p class="note">The % is your last 20 answers of that type (or your last try on each question until you have 20). ▲▼ compare them with the 20 before. Time counts practice answers only.</p>
    </section>

    ${P.weakPatterns.length ? `<section class="panel">
      <h2>Grammar patterns to review</h2>
      <ul class="pattern-list">${P.weakPatterns.map((p) => { const pat = patterns.find((x) => x.n === p.n); return `<li><b>${esc(pat?.pattern || `#${p.n}`)}</b>
        ${pat?.reading && pat.reading.replace(/\s/g, "") !== pat.pattern.replace(/\s/g, "") ? `<span class="note">${esc(pat.reading)}</span>` : ""}<span class="note">missed ${p.wrong}×${p.stillWrong ? ` · still wrong on ${p.stillWrong}` : ""}</span></li>`; }).join("")}</ul>
      <button class="btn secondary" type="button" data-drill-patterns>Practice these patterns</button>
    </section>` : ""}

    <section class="panel">
      <h2>Exam vs practice</h2>
      <div class="tiles two">
        <div class="tile"><span class="eyebrow">Practice</span><b>${P.practiceAcc === null ? "–" : P.practiceAcc + "%"}</b><span class="note">of ${P.practiceN} answers</span></div>
        <div class="tile"><span class="eyebrow">Exam</span><b>${P.examAcc === null ? "–" : P.examAcc + "%"}</b><span class="note">of ${P.examN} answers</span></div>
      </div>
      <p class="note">${P.examN >= 20 && P.practiceN >= 20 && P.practiceAcc - P.examAcc >= 10 ? "You score noticeably lower under exam conditions. More timed sets and mock tests will close that gap." : "Exam answers come from exam mode, mock tests and custom tests run as exams."}</p>
    </section>

    <section class="panel">
      <h2>Coverage</h2>
      ${Object.keys(SECTIONS).map((sec) => { const st = sectionStats(sec); return `<div class="score-row">
        <span class="jp-label">${SECTIONS[sec].jp}</span>
        <div class="meter"><i style="width:${(st.seen / st.total) * 100}%"></i></div>
        <span class="num"><small>${st.seen}/${st.total}</small></span></div>`; }).join("")}
      <p class="note">${unseen ? `${unseen} questions you haven't seen yet. About ${Math.ceil(unseen / days)} new ones a day would cover the whole bank before the exam.` : "You've seen every question in the bank."}</p>
    </section>

    <section class="stack" style="gap:8px">
      <h2>Recent sets</h2>
      ${recent.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Set</th><th class="num">Score</th><th class="num">Time</th></tr></thead><tbody>
        ${recent.map((r) => `<tr><td>${shortDate(r.t)}</td><td>${esc(sectionLabel(r.section, true))}${r.exam ? " · exam" : ""}</td><td class="num">${r.ok}/${r.n} <span class="note">${pct(r.ok, r.n)}%</span></td><td class="num">${fmt(r.secs)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No sets yet.</p>`}
    </section>
    <div class="panel">
      <h3>Backup</h3>
      <p class="note">Progress is saved in this browser only. Export it to keep a copy or move it to another device.</p>
      <div class="row"><button class="btn secondary" type="button" data-export>Export progress</button>
      <label class="btn secondary" style="display:inline-flex;align-items:center">Import progress<input type="file" accept="application/json" data-import hidden></label></div>
      <p class="toast" data-msg></p>
    </div>
  </div>`;
  app.querySelectorAll("[data-drill]").forEach((b) => b.addEventListener("click", () => {
    const [section, type] = b.dataset.drill.split("/");
    startRun(section, pickUnits(section, SECTIONS[section].sizes[0], type, false));
  }));
  $("[data-drill-patterns]")?.addEventListener("click", () => {
    // Both items for each pattern, the ones you got wrong first.
    const list = P.weakPatterns.flatMap((p) => p.units).sort((a, b) => (store.q[a.id]?.lastOk ?? true) - (store.q[b.id]?.lastOk ?? true));
    startRun("grammar", list.slice(0, 16));
  });
  $("[data-export]").addEventListener("click", () => {
    const { key, ...safe } = store.settings; // never put the API key in a backup file
    const blob = new Blob([JSON.stringify({ ...store, settings: safe }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `n2-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("[data-import]").addEventListener("change", async (e) => {
    const msg = $("[data-msg]");
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!data.q || !data.sessions) throw new Error("not a progress file");
      // Merge: keep whichever record is newer for each question.
      for (const [k, r] of Object.entries(data.q)) if (!store.q[k] || (r.last || 0) > (store.q[k].last || 0)) store.q[k] = r;
      const seen = new Set(store.sessions.map((s) => s.t));
      store.sessions = [...store.sessions, ...data.sessions.filter((s) => !seen.has(s.t))].sort((a, b) => a.t - b.t);
      const logged = new Set(store.log.map((e) => `${e.t}|${e.k}`));
      store.log = [...store.log, ...(data.log || []).filter((e) => !logged.has(`${e.t}|${e.k}`))].sort((a, b) => a.t - b.t).slice(-LOG_CAP);
      saveStore();
      msg.textContent = "Progress imported.";
      setTimeout(renderStats, 600);
    } catch (err) {
      msg.textContent = `Couldn't import: ${err.message}. Choose a file made by Export progress.`;
    }
  });
}

// ---------- settings ----------

function renderSettings() {
  stopTimer(); setActions(null);
  setScreen("settings");
  const s = settings();
  app.innerHTML = `<div class="stack">
    <h1>Settings</h1>
    <div class="panel">
      <div class="field"><label for="set-mode">Listening in practice sets</label>
        <select id="set-mode"><option value="practice" ${s.mode === "practice" ? "selected" : ""}>Replay and change speed</option>
        <option value="exam" ${s.mode === "exam" ? "selected" : ""}>Play once at normal speed</option></select></div>
      <div class="field"><label for="set-theme">Theme</label>
        <select id="set-theme">${[["system", "Match this device"], ["light", "Light"], ["dark", "Dark"]]
          .map(([v, l]) => `<option value="${v}" ${s.theme === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="set-date">Exam date</label><input id="set-date" type="date" value="${esc(s.examDate)}"></div>
    </div>
    <div class="panel">
      <h3>Fresh questions with Gemini</h3>
      <p class="note">With your own key from aistudio.google.com/apikey, the app writes new vocabulary, grammar, reading and listening questions on demand. The key is stored only in this browser and sent only to Google.</p>
      <div class="field"><label for="set-key">Gemini API key</label><input id="set-key" type="password" autocomplete="off" spellcheck="false" value="${esc(s.key)}" placeholder="AIza…"></div>
      <div class="field"><label for="set-text">Text model</label><input id="set-text" value="${esc(s.textModel)}"></div>
      <div class="field"><label for="set-tts">Speech model</label><input id="set-tts" value="${esc(s.ttsModel)}"></div>
      <div class="row"><button class="btn secondary" type="button" data-test>Test key</button><span class="toast" data-test-msg></span></div>
    </div>
    <div class="panel">
      <h3>Reset</h3>
      <p class="note">Clears every answer and set in this browser. Export first if you want a copy.</p>
      <div class="row" data-reset-row><button class="btn secondary danger" type="button" data-reset>Reset progress</button></div>
    </div>
  </div>`;
  const bind = (id, k, f = (v) => v) => $(id).addEventListener("change", (e) => { store.settings[k] = f(e.target.value.trim()); saveStore(); });
  $("#set-theme").addEventListener("change", (e) => setTheme(e.target.value));
  bind("#set-mode", "mode"); bind("#set-date", "examDate"); bind("#set-key", "key"); bind("#set-text", "textModel"); bind("#set-tts", "ttsModel");
  $("[data-test]").addEventListener("click", async () => {
    const msg = $("[data-test-msg]");
    store.settings.key = $("#set-key").value.trim(); saveStore();
    msg.textContent = "Testing…";
    try {
      await gemini(settings().textModel, { contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }] });
      msg.textContent = "Key works.";
    } catch (err) { msg.textContent = err.message; }
  });
  $("[data-reset]").addEventListener("click", () => {
    const row = $("[data-reset-row]");
    row.innerHTML = `<span>Clear all progress?</span><button class="btn secondary danger" type="button" data-yes>Clear</button><button class="btn secondary" type="button" data-no>Keep</button>`;
    row.querySelector("[data-yes]").addEventListener("click", () => { store.q = {}; store.sessions = []; saveStore(); renderSettings(); });
    row.querySelector("[data-no]").addEventListener("click", renderSettings);
  });
}

// ---------- live generation (Gemini API, the user's own key) ----------

async function gemini(model, body) {
  const key = settings().key;
  if (!key) throw new Error("Add a Gemini API key in Settings first.");
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body),
    });
    if (r.status === 429 && attempt < 3) { await new Promise((res) => setTimeout(res, 20000 * (attempt + 1))); continue; }
    if (!r.ok) {
      let m = `${r.status}`;
      try { m += ` ${(await r.json()).error.message}`; } catch { /* body wasn't JSON */ }
      throw new Error(m.slice(0, 220));
    }
    const j = await r.json();
    const part = j.candidates?.[0]?.content?.parts?.[0];
    if (!part) throw new Error("The model returned nothing; try again.");
    return part;
  }
}

const Q_SCHEMA = {
  type: "OBJECT", required: ["choices", "answer", "explanation", "why_wrong"],
  properties: {
    type: { type: "STRING" }, prompt: { type: "STRING" }, stem: { type: "STRING" }, q: { type: "STRING" },
    choices: { type: "ARRAY", items: { type: "STRING" } }, answer: { type: "INTEGER" },
    order: { type: "ARRAY", items: { type: "INTEGER" } },
    explanation: { type: "STRING" }, why_wrong: { type: "ARRAY", items: { type: "STRING" } },
  },
};
const RULES = `Write original JLPT N2 questions in the real exam formats. Natural standard Japanese, N2 difficulty, exactly one defensible answer, plausible distractors, answers spread over positions. In stems mark the target with <u>…</u> and blanks with （　　）. explanation: 1-3 plain English sentences on why the answer is right. why_wrong: one short English sentence per choice ("Correct." for the right one). answer is a 0-based index.`;

async function generateLive(section, type, n, progress) {
  const pickPatterns = (k) => shuffle([...patterns]).slice(0, k).map((p) => p.pattern).join("、");
  let prompt, schema;
  if (section === "vocab" || section === "grammar") {
    const types = section === "vocab" ? "kanji_reading, orthography, context, paraphrase, usage" : "grammar_select";
    const t = type || (section === "vocab" ? "a mix of " + types : "grammar_select");
    prompt = `${RULES}\nWrite ${n} ${section} questions of type ${t}.` +
      (section === "grammar" ? ` Each tests one of these patterns (correct choice uses it, distractors are patterns learners confuse with it): ${pickPatterns(n)}.` : "") +
      ` kanji_reading: underlined kanji word, hiragana choices. orthography: underlined hiragana word, kanji choices. usage: stem is just the word, choices are 4 sentences using it. Set type on each item.`;
    schema = { type: "ARRAY", items: Q_SCHEMA };
  } else if (section === "reading") {
    prompt = `${RULES}\nWrite ${n} reading passages of type ${type || "short or medium"}: short ≈ 200 characters with 1 question, medium ≈ 500 characters with 3 questions. Questions test the writer's point and inference. Separate paragraphs with blank lines.`;
    schema = { type: "ARRAY", items: { type: "OBJECT", required: ["type", "passage", "questions"], properties: {
      type: { type: "STRING" }, passage: { type: "STRING" }, questions: { type: "ARRAY", items: Q_SCHEMA } } } };
  } else {
    return generateListening(type, progress);
  }
  progress("Writing questions…");
  const part = await gemini(settings().textModel, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema },
  });
  const items = JSON.parse(part.text);
  const stamp = Date.now().toString(36);
  const prompts = {
    kanji_reading: "＿＿＿の言葉の読み方として最もよいものを、1・2・3・4から一つえらびなさい。",
    orthography: "＿＿＿の言葉を漢字で書くとき、最もよいものを、1・2・3・4から一つえらびなさい。",
    context: "（　　）に入れるのに最もよいものを、1・2・3・4から一つえらびなさい。",
    paraphrase: "＿＿＿の言葉に意味が最も近いものを、1・2・3・4から一つえらびなさい。",
    usage: "次の言葉の使い方として最もよいものを、1・2・3・4から一つえらびなさい。",
    grammar_select: "次の文の（　　）に入れるのに最もよいものを、1・2・3・4から一つえらびなさい。",
  };
  const valid = (q) => Array.isArray(q.choices) && q.choices.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4;
  return items.map((it, k) => ({
    ...it, live: true, section, id: `fresh-${stamp}-${k + 1}`,
    type: it.type || (section === "reading" ? "short" : "grammar_select"),
    prompt: it.prompt || prompts[it.type] || "次の文章を読んで、後の問いに対する答えとして最もよいものを、1・2・3・4から一つえらびなさい。",
  })).filter((it) => (it.questions ? it.questions.length && it.questions.every(valid) : valid(it) && it.stem));
}

async function generateListening(type, progress) {
  const kind = type || shuffle(["task", "point", "summary", "response"])[0];
  progress("Writing the script…");
  const part = await gemini(settings().textModel, {
    contents: [{ role: "user", parts: [{ text: `${RULES}
Write one JLPT N2 listening item of type ${kind}. Natural spoken Japanese with a real N2 twist (a plan changes, the first idea is rejected, the stated reason isn't the real one).
task: 2 people, 150-250 chars, "what will X do first", printed choices. point: 2 people, 200-300 chars, "why…", printed choices, the setup states the question. summary: one speaker 200-300 chars, setup has no question, question after, spoken choices. response: exactly one line, 3 spoken reply choices, setup and question empty.
speakers maps each label used in lines (男, 女, 男1, 女2…) to "male" or "female". Every line has en (English).` }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: {
      type: "OBJECT", required: ["setup", "question", "speakers", "lines", "choices", "choice_mode", "answer", "explanation", "why_wrong"],
      properties: {
        setup: { type: "STRING" }, question: { type: "STRING" },
        speakers: { type: "OBJECT", properties: { "男": { type: "STRING" }, "女": { type: "STRING" }, "男1": { type: "STRING" }, "男2": { type: "STRING" }, "女1": { type: "STRING" }, "女2": { type: "STRING" } } },
        lines: { type: "ARRAY", items: { type: "OBJECT", required: ["speaker", "text", "en"], properties: { speaker: { type: "STRING" }, text: { type: "STRING" }, en: { type: "STRING" } } } },
        choices: { type: "ARRAY", items: { type: "STRING" } }, choice_mode: { type: "STRING", enum: ["printed", "spoken"] },
        answer: { type: "INTEGER" }, explanation: { type: "STRING" }, why_wrong: { type: "ARRAY", items: { type: "STRING" } },
      } } },
  });
  const it = JSON.parse(part.text);
  const MALE = ["Puck", "Charon", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Achird", "Zubenelgenubi", "Sadachbia", "Sadaltager"];
  const FEMALE = ["Zephyr", "Kore", "Leda", "Aoede", "Autonoe", "Despina", "Erinome", "Laomedeia", "Achernar", "Gacrux", "Vindemiatrix", "Sulafat"];
  const taken = new Set();
  const pickVoice = (g) => { const v = shuffle((g === "male" ? MALE : FEMALE).filter((x) => !taken.has(x)))[0]; taken.add(v); return v; };
  const voices = {};
  for (const l of it.lines) if (!voices[l.speaker]) voices[l.speaker] = pickVoice(it.speakers?.[l.speaker] === "male" ? "male" : "female");
  const narrator = shuffle([...MALE, ...FEMALE].filter((x) => !taken.has(x)))[0];

  const plan = [];
  if (it.setup) plan.push({ kind: "setup", text: it.setup, voice: narrator, gap: 0 });
  it.lines.forEach((l, i) => plan.push({ kind: "line", i, text: l.text, voice: voices[l.speaker], gap: i === 0 && it.setup ? 1.2 : 0.35, en: l.en }));
  if (it.question) plan.push({ kind: "question", text: it.question, voice: narrator, gap: 1.5 });
  if (it.choice_mode === "spoken") it.choices.forEach((c, i) => plan.push({ kind: "choice", i, text: `${i + 1}、${c}`, voice: narrator, gap: i ? 1 : 1.5 }));

  const RATE = 24000;
  const chunks = [];
  const segments = [];
  let t = 0;
  for (const [k, p] of plan.entries()) {
    progress(`Recording ${k + 1}/${plan.length}… (the free tier is slow; this can take a few minutes)`);
    const notes = p.kind === "line" ? `Meaning of this line: ${p.en}\nDelivery: natural spoken Japanese that fits the meaning.` : "Delivery: calm, clear exam narrator.";
    const audio = await gemini(settings().ttsModel, {
      contents: [{ role: "user", parts: [{ text: `### DIRECTOR'S NOTES\n${notes}\nLanguage: Japanese (native Tokyo pronunciation). Speak only the transcript.\n\n### TRANSCRIPT\n${p.text}` }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } } } },
    });
    const pcm = toPCM(audio.inlineData, RATE);
    chunks.push(new Int16Array(Math.round(RATE * p.gap)));
    t += p.gap;
    const dur = pcm.length / RATE;
    segments.push({ kind: p.kind, ...(p.i !== undefined ? { i: p.i } : {}), start: +t.toFixed(2), end: +(t + dur).toFixed(2) });
    chunks.push(pcm);
    t += dur;
  }
  chunks.push(new Int16Array(RATE / 2));
  const url = URL.createObjectURL(wavBlob(chunks, RATE));
  return [{ ...it, type: kind, live: true, section: "listening", id: `fresh-${Date.now().toString(36)}`, audio: url, segments }];
}

/** Gemini speech comes back as raw 16-bit PCM or as a WAV file; either way return 16-bit samples at `rate`. */
function toPCM(inline, rate) {
  const bin = atob(inline.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let start = 0, src = rate;
  if (/wav/i.test(inline.mimeType)) {
    const dv = new DataView(bytes.buffer);
    src = dv.getUint32(24, true);
    for (let p = 12; p < bytes.length - 8;) {
      const id = String.fromCharCode(...bytes.slice(p, p + 4));
      const size = dv.getUint32(p + 4, true);
      if (id === "data") { start = p + 8; break; }
      p += 8 + size;
    }
  } else {
    const m = /rate=(\d+)/.exec(inline.mimeType);
    if (m) src = Number(m[1]);
  }
  const samples = new Int16Array(bytes.buffer.slice(start, start + ((bytes.length - start) & ~1)));
  if (src === rate) return samples;
  const out = new Int16Array(Math.round((samples.length * rate) / src));
  for (let i = 0; i < out.length; i++) out[i] = samples[Math.min(samples.length - 1, Math.round((i * src) / rate))];
  return out;
}
function wavBlob(chunks, rate) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + len * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) { new Int16Array(buf, o, c.length).set(c); o += c.length * 2; }
  return new Blob([buf], { type: "audio/wav" });
}

// ---------- boot ----------

// Leaving a practice set keeps the answers already given; they're recorded as you go.
$("#home-btn").addEventListener("click", () => { if (leaveOk()) renderHome(); });

(async function boot() {
  try {
    const [bank, pats] = await Promise.all([
      fetch("data/bank.json").then((r) => { if (!r.ok) throw new Error(`bank ${r.status}`); return r.json(); }),
      fetch("data/patterns.json").then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    units = [...bank.items, ...loadLive()];
    patterns = pats;
    renderHome();
  } catch (err) {
    app.innerHTML = `<p>Couldn't load the questions (${esc(err.message)}). Check your connection and reload.</p>`;
  }
})();
