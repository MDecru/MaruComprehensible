# MaruComprehension

A Chrome extension that shows your [MaruMori](https://marumori.io) comprehension percentage on Japanese videos, with colored word highlighting, on-hover definitions, immersion timer, and SRS-level word badges.

> **Disclaimer:** MaruComprehension is an independent, unofficial study aid. It is not affiliated with or endorsed by MaruMori.io.

Works on:
- **YouTube** — comprehension badge, colored subtitle overlay with timestamp sync
- **Comprehensible Japanese** (cijapanese.com) — transcript coloring, hover definitions, word sidebar
- **Nihongo-Jikan** (nihongo-jikan.com) — transcript coloring, hover definitions, word sidebar
- **Local player** — drop any video + `.vtt`/`.srt` subtitle file for offline scoring
- **Local NAS** — mdnas.local / synology CIJ replicas

## Features

- **Comprehension scoring** — three rings (unique words, frequency words, kanji) in the popup and on the video player
- **Colored subtitles** — known (blue), apprentice (green), and unknown (red) words; colorblind mode available
- **Apprentice highlighting** — SRS level 1–4 words highlighted green so you can spot what you're learning
- **MaruMori level badges** — SRS level shown in hover tooltips and the word sidebar
- **Hover definitions** — hover any word for reading, JLPT level, and Jisho dictionary definitions
- **Word sidebar** — unknown words grouped by JLPT level; MaruMori level badges on each word
- **Immersion timer** — automatically tracks watch time on YouTube, CIJ, Nihongo-Jikan, and the local player
- **Immersion Stats page** — daily totals, streak grid, per-source breakdown, stacked bar chart
- **Focus timer** — countdown stopwatch for SRS review sessions; auto-adds time to immersion log
- **Watch history** — every scored video saved with comprehension %, unknown word frequency tracking
- **Watched badges** — ✓ comprehension chips on YouTube thumbnails and CIJ/NJK video listings
- **Furigana** — optional ruby text above kanji in subtitles
- **Backup & restore** — export/import all data (API key, vocab, history, settings) as one file
- **Right-click search** — select any word on any page and search it on MaruMori's dictionary
- **Inter font** — clean modern typeface bundled for Windows

## Installation

### Load unpacked (developer mode)

1. Download `MaruComprehension-v1.5.zip` from the [latest release](https://github.com/MDecru/MaruComprehensible/releases)
2. Unzip it anywhere on your computer
3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** (toggle top-right)
5. Click **Load unpacked** and select the unzipped folder
6. Pin the extension from the Chrome toolbar

### From source

1. Clone this repo
2. Go to `chrome://extensions`, enable Developer mode
3. Click **Load unpacked** and select this folder

## Setup

1. Click the MaruComprehension icon in the Chrome toolbar
2. Go to the **Settings** tab and paste your [MaruMori API token](https://marumori.io/settings)
3. Click **Connect & fetch vocab** — your known words and SRS levels are downloaded and cached
4. Navigate to a Japanese video — comprehension scores appear automatically

## Usage

### YouTube

- A control bar appears on the player with score %, 字幕 toggle, ⚙ settings, ≡ sidebar, and immersion indicator
- Click **字幕** to toggle the colored subtitle overlay
- Click **⚙** to open subtitle settings (Style / Layout / Playback tabs):
  - Font size, font weight, color mode (blue/red or blue/orange)
  - Box or outline style with adjustable thickness (1–8 px)
  - Background opacity, vertical position, max width
  - Furigana toggle + opacity, pause on hover, auto-pause, unknown-only mode
  - Apprentice highlighting toggle
- Click **≡** to open the word sidebar
- Green dot = immersion tracking active; click to toggle

### CIJ / Nihongo-Jikan / Local NAS

- Comprehension badge and control bar appear on the player
- Hover on the transcript for word coloring — enable from the popup's Main tab
- Open the word sidebar from the control bar or popup

### Local player

- Click **Local video player** in the popup
- Drop a video + `.vtt`/`.srt` subtitle file, or use the file picker
- Same hover, sidebar, and settings features as YouTube

### Timer & Stats

- **Timer tab** in the popup: start a focus timer, see today's immersion time and streak
- **Immersion Stats page**: daily totals, progress chart (stacked bars or cumulative line), streak grid, per-source breakdown

## Privacy

All data stored locally on your device. Network requests only to MaruMori (vocab sync) and Jisho (word lookups). See the full [Privacy Policy](https://mdecru.github.io/MaruComprehensible/privacy.html).
