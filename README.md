# N2 Drill Room

JLPT N2 practice in the browser: vocabulary, grammar, reading and listening drills with
explanations for every choice, built for phone and desktop.

**Open it:** https://juanlouisr.github.io/n2-practice/

## What's inside

| Section | Question types | Built-in |
|---|---|---|
| 語彙 Vocabulary | 漢字読み, 表記, 文脈規定, 言い換え類義, 用法 | 125 |
| 文法 Grammar | 文の文法1 (one per N2 pattern), 並べ替え, 文章の文法 | 243 |
| 読解 Reading | 短文, 中文, 統合理解, 長文, 情報検索 | 49 questions in 25 passages |
| 聴解 Listening | 課題理解, ポイント理解, 概要理解, 即時応答, 統合理解 | 68 |

All questions are original, written for this app and checked by a second, blind solve.
Listening audio is Gemini text-to-speech with a different random cast for every item.

- **Listening practice mode** lets you replay and slow down; **exam mode** plays once.
  After you answer, the transcript appears with English, and tapping a line replays it.
- **Progress** (scores, questions to retry) is kept in your browser. Use Export / Import
  on the Progress page to back it up or move it to another device.
- **Fresh questions:** add your own Gemini API key in Settings to generate new sets on
  demand. The key stays in your browser and is sent only to Google.

## Files

- `index.html`, `style.css`, `app.js`: the app (no build step).
- `data/bank.json`: the question bank. `audio/`: listening audio.
- Generation scripts and drafts live outside this repository.
