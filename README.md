# N2 Drill Room

JLPT N2 practice in the browser: vocabulary, grammar, reading and listening drills with
explanations for every choice, built for phone and desktop.

**Open it:** https://juanlouisr.github.io/n2-practice/

## What's inside

| Section | Question types | Built-in |
|---|---|---|
| 語彙 Vocabulary | 漢字読み, 表記, 語形成, 文脈規定, 言い換え類義, 用法 | 435 |
| 文法 Grammar | 文の文法1 (two per N2 pattern), 並べ替え, 文章の文法 | 532 |
| 読解 Reading | 短文, 中文, 統合理解, 長文, 情報検索 | 147 questions in 75 passages |
| 聴解 Listening | 課題理解, ポイント理解, 概要理解, 即時応答, 統合理解 (incl. 質問1・2) | 228 questions in 216 items |

All questions are original, written for this app and checked by a second, blind solve.
Listening audio is Gemini text-to-speech with a different random cast for every item.

- **Practice** shows the answer and explanations after each question. In listening you can
  replay and slow down; after you answer, the transcript appears with English, and tapping
  a line replays it.
- **Exam** (on each section) and **Mock test** (laid out like the real paper) work like the
  real test: change your answers until you submit, results only at the end, a time limit,
  and listening plays each item once. Review answers afterwards to see the explanations.
- **Custom test:** choose how many 言語知識, 読解 and 聴解 questions you want; they're mixed
  in the real paper's proportions and order, as an exam or as practice.
- **Progress:** an estimated score per part against the pass marks, the question types
  costing you the most points, daily activity and streak, weekly accuracy, every type's
  accuracy, trend and speed against exam pace (with a Practice button), grammar patterns
  you keep missing, exam vs practice accuracy, and coverage. It's all kept in your
  browser; use Export / Import on the Progress page to back it up or move it.
- **Text size and font:** Aa in the top bar (also in Settings, and during a test) makes
  questions and passages bigger or smaller, 85% to 175%, and switches the Japanese font
  between 明朝 (like the exam paper), ゴシック, UDゴシック and a handwritten style.
- **Fresh questions:** add your own Gemini API key in Settings to generate new sets on
  demand. The key stays in your browser and is sent only to Google.

## Files

- `index.html`, `style.css`, `app.js`: the app (no build step).
- `data/bank.json`: the question bank. `audio/`: listening audio.
- Generation scripts and drafts live outside this repository.
