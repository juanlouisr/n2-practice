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
  kanji_reading: "漢字読み", orthography: "表記", context: "文脈規定", paraphrase: "言い換え類義", usage: "用法",
  grammar_select: "文の文法1", ordering: "並べ替え", passage_grammar: "文章の文法",
  short: "短文", medium: "中文", integrated: "統合理解", long: "長文", info: "情報検索",
  task: "課題理解", point: "ポイント理解", summary: "概要理解", response: "即時応答",
};

let units = [];      // bank items plus live-generated ones
let patterns = [];   // grammar pattern names, for live generation
let store = loadStore();
let run = null;      // the drill in progress
let tick = null;

// ---------- storage ----------

function loadStore() {
  const empty = { q: {}, sessions: [], settings: {} };
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
function record(key, correct) {
  const r = store.q[key] || { n: 0, ok: 0 };
  r.n++; if (correct) r.ok++;
  r.lastOk = correct; r.last = Date.now();
  store.q[key] = r;
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

function renderHome() {
  stopTimer(); setActions(null); player.pause();
  run = null;
  const days = daysLeft();
  const s = settings();
  app.innerHTML = `
    <div class="stack">
      <section class="stack" style="gap:6px">
        <span class="eyebrow">JLPT N2 · ${esc(s.examDate)}</span>
        <div class="countdown"><b>${days > 0 ? days : 0}</b><span>${days > 0 ? "days until the exam" : "exam day has passed"}</span></div>
      </section>
      <section class="sections">${Object.keys(SECTIONS).map(sectionCard).join("")}</section>
      <nav class="links">
        <button class="btn secondary" type="button" data-go="stats">Progress</button>
        <button class="btn secondary" type="button" data-go="settings">Settings</button>
      </nav>
      ${s.key ? "" : `<p class="note">Add a Gemini API key in Settings to generate fresh questions beyond the built-in set.</p>`}
    </div>`;
  app.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => (b.dataset.go === "stats" ? renderStats() : renderSettings())));
  for (const section of Object.keys(SECTIONS)) wireCard(section);
}

function sectionCard(section) {
  const meta = SECTIONS[section];
  const st = sectionStats(section);
  const size = homeState.size[section] || meta.sizes[0];
  const types = [...new Set(units.filter((u) => u.section === section).map((u) => u.type))];
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

function startRun(section, list) {
  if (!list.length) return;
  run = { section, units: list, i: 0, results: [], start: Date.now() };
  stopTimer();
  tick = setInterval(updateTimer, 1000);
  renderUnit();
}

function updateTimer() {
  if (!run) return;
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
  run.done = false;
  run.answered = 0;
  updateTimer();
  player.pause();
  window.scrollTo(0, 0);
  setActions(null);
  const head = `<div class="q-head"><span>${SECTIONS[u.section].jp} · ${TYPES[u.type] || u.type}${u.live ? " · fresh" : ""}</span><span>${esc(u.id)}</span></div>`;
  if (u.section === "listening") return renderListening(u, head);
  if (u.questions) return renderGroup(u, head);
  app.innerHTML = `<div class="stack">${head}<p class="prompt">${esc(u.prompt || "")}</p>
    <p class="stem ${u.type === "usage" ? "word" : ""}">${safeHTML(u.stem)}</p>
    <div data-q></div></div>`;
  mountQuestion($("[data-q]"), u, u.id, () => finishUnit());
}

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
  buttons.forEach((b, k) => b.addEventListener("click", () => {
    const correct = k === q.answer;
    record(key, correct);
    run.results.push({ key, unit: run.units[run.i], q, correct, picked: k });
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
    v.innerHTML = `<strong>${correct ? "正解" : `不正解 · answer ${q.answer + 1}`}</strong>${extra}<p>${esc(q.explanation)}</p>`;
    el.append(v);
    onDone();
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
  const exam = s.mode === "exam";
  const printed = u.choice_mode === "printed";
  app.innerHTML = `<div class="stack">${head}
    <div class="player">
      <button class="play" type="button" data-play>▶ Play</button>
      <div class="progress"><i data-bar></i></div>
      <div class="row" style="justify-content:space-between">
        <span class="note">${exam ? "Exam mode: plays once." : "Practice mode: replay as often as you like."}</span>
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
  mountQuestion($("[data-q]"), u, u.id, () => { finishUnit(); showTranscript(u); }, { spoken: !printed });
}

function showTranscript(u) {
  const seg = (kind, i) => (u.segments || []).find((x) => x.kind === kind && (i === undefined || x.i === i));
  const row = (who, jp, en, sg) => `<li><button class="line" type="button" ${sg ? `data-start="${sg.start}" data-end="${sg.end}"` : "disabled"}>
      <span class="who">${esc(who)}</span><span><span class="jp">${esc(jp)}</span>${en ? `<span class="en">${esc(en)}</span>` : ""}</span></button></li>`;
  let html = "";
  if (u.setup) html += row("ナレ", u.setup, "", seg("setup"));
  u.lines.forEach((l, i) => { html += row(l.speaker, l.text, l.en, seg("line", i)); });
  if (u.question) html += row("ナレ", u.question, "", seg("question"));
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
  const bar = setActions(`<button class="btn" type="button" data-next>${last ? "See results" : "Next"}</button>`);
  bar.querySelector("[data-next]").addEventListener("click", () => {
    if (last) return renderResults();
    run.i++;
    renderUnit();
  });
}

function renderResults() {
  stopTimer(); setActions(null); player.pause();
  const secs = (Date.now() - run.start) / 1000;
  const ok = run.results.filter((r) => r.correct).length;
  const n = run.results.length;
  store.sessions.push({ t: Date.now(), section: run.section, n, ok, secs: Math.round(secs) });
  store.sessions = store.sessions.slice(-300);
  saveStore();
  const byType = {};
  for (const r of run.results) {
    const t = TYPES[r.unit.type] || r.unit.type;
    byType[t] = byType[t] || [0, 0];
    byType[t][1]++; if (r.correct) byType[t][0]++;
  }
  const wrong = run.results.filter((r) => !r.correct);
  const section = run.section;
  app.innerHTML = `<div class="stack">
    <span class="eyebrow">${SECTIONS[section].jp} · ${SECTIONS[section].en}</span>
    <div class="row" style="align-items:baseline;gap:14px"><span class="score">${ok}/${n}</span><span class="muted">${Math.round((ok / n) * 100)}% · ${fmt(secs)}</span></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Type</th><th class="num">Correct</th></tr></thead><tbody>
      ${Object.entries(byType).map(([t, [a, b]]) => `<tr><td>${t}</td><td class="num">${a}/${b}</td></tr>`).join("")}
    </tbody></table></div>
    ${wrong.length ? `<h2>To review</h2><ul class="stack" style="list-style:none;padding:0;margin:0">${wrong.map((r) => `
      <li class="panel" style="gap:6px"><span class="note">${esc(r.key)} · ${TYPES[r.unit.type] || ""}</span>
      <span style="font-family:var(--font-text)">${safeHTML(r.q.stem || r.q.q || r.unit.question || r.unit.lines?.[0]?.text || "")}</span>
      <span>Answer: <b>${r.q.answer + 1}. ${safeHTML(r.q.choices[r.q.answer])}</b> · yours: ${r.picked + 1}</span>
      <span class="note">${esc(r.q.explanation)}</span></li>`).join("")}</ul>` : `<p>All correct.</p>`}
  </div>`;
  const bar = setActions(`<button class="btn secondary" type="button" data-home>Home</button><button class="btn" type="button" data-again>Next set</button>`);
  bar.querySelector("[data-home]").addEventListener("click", renderHome);
  bar.querySelector("[data-again]").addEventListener("click", () => startRun(section, pickUnits(section, homeState.size[section] || SECTIONS[section].sizes[0], homeState.type[section], false)));
}

// ---------- progress ----------

function renderStats() {
  stopTimer(); setActions(null);
  const typeRows = {};
  for (const u of units) for (const k of qkeys(u)) {
    const r = store.q[k];
    if (!r) continue;
    const t = `${SECTIONS[u.section].jp} · ${TYPES[u.type] || u.type}`;
    typeRows[t] = typeRows[t] || [0, 0];
    typeRows[t][1]++; if (r.lastOk) typeRows[t][0]++;
  }
  const pill = (a) => (a === null ? "" : `<span class="pill ${a >= 70 ? "ok" : a >= 50 ? "mid" : "bad"}">${a}%</span>`);
  const recent = store.sessions.slice(-12).reverse();
  app.innerHTML = `<div class="stack">
    <h1>Progress</h1>
    <div class="table-wrap"><table class="data"><thead><tr><th>Section</th><th class="num">Seen</th><th class="num">Correct</th><th class="num">To retry</th></tr></thead><tbody>
      ${Object.keys(SECTIONS).map((s) => { const st = sectionStats(s); return `<tr><td>${SECTIONS[s].jp} ${SECTIONS[s].en}</td><td class="num">${st.seen}/${st.total}</td><td class="num">${pill(st.acc)}</td><td class="num">${st.wrong}</td></tr>`; }).join("")}
    </tbody></table></div>
    <h2>By question type</h2>
    ${Object.keys(typeRows).length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Type</th><th class="num">Correct (last try)</th></tr></thead><tbody>
      ${Object.entries(typeRows).sort().map(([t, [a, b]]) => `<tr><td>${t}</td><td class="num">${a}/${b} ${pill(Math.round((a / b) * 100))}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="muted">Finish a set to see results by question type.</p>`}
    <h2>Recent sets</h2>
    ${recent.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Section</th><th class="num">Score</th><th class="num">Time</th></tr></thead><tbody>
      ${recent.map((r) => `<tr><td>${new Date(r.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td><td>${SECTIONS[r.section]?.jp || r.section}</td><td class="num">${r.ok}/${r.n}</td><td class="num">${fmt(r.secs)}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="muted">No sets yet.</p>`}
    <div class="panel">
      <h3>Backup</h3>
      <p class="note">Progress is saved in this browser only. Export it to keep a copy or move it to another device.</p>
      <div class="row"><button class="btn secondary" type="button" data-export>Export progress</button>
      <label class="btn secondary" style="display:inline-flex;align-items:center">Import progress<input type="file" accept="application/json" data-import hidden></label></div>
      <p class="toast" data-msg></p>
    </div>
  </div>`;
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
  const s = settings();
  app.innerHTML = `<div class="stack">
    <h1>Settings</h1>
    <div class="panel">
      <div class="field"><label for="set-mode">Listening mode</label>
        <select id="set-mode"><option value="practice" ${s.mode === "practice" ? "selected" : ""}>Practice: replay, change speed</option>
        <option value="exam" ${s.mode === "exam" ? "selected" : ""}>Exam: play once at normal speed</option></select></div>
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

$("#home-btn").addEventListener("click", () => {
  if (run && !run.finished && run.results.length) {
    // Leaving mid-set keeps the answers already given; they're recorded as you go.
    run = null;
  }
  renderHome();
});

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
