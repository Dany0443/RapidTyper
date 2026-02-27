### Still Work in progress
---

# TypeRace & SpellingBee

A real-time competitive typing platform built for a school festival. Students race to type a given text as fast and accurately as possible, or compete in a spelling bee dictation round — all live, all in the browser, no installs needed on the player side.

Built from scratch for the occasion. Now open source.

---

## What it does

**Fast Typer** — Players join a lobby, the host starts a race, and everyone types the same text simultaneously. Live WPM, accuracy, and progress are visible to the host in real time. At the end, a podium and full leaderboard are shown. Supports multiple rounds in a series.

**Spelling Bee** — The host reads a text aloud. Players type what they hear and submit. The server scores each submission word-by-word against the original and returns accuracy, a diff of correct/wrong words, and a percentile ranking among all spellers.

**Host Panel** — A password-protected admin interface to manage both game modes: edit the competition text, set the race duration, monitor connected players, kick participants, start/stop rounds, and view live results.

---

## Stack

- **Frontend** — Vanilla HTML/CSS/JS, Tailwind, Roboto Mono
- **Backend** — Node.js, WebSockets (`ws`), SQLite
- **No framework. No build step.**

---

*Made for IP Liceul Teoretic "Stefan Holban" annual school festival.*
