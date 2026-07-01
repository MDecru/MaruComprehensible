# MaruComprehension

A Chrome extension that shows your [MaruMori](https://marumori.io) comprehension percentage on Japanese videos, with colored word highlighting and on-hover definitions.

> **Disclaimer:** MaruComprehension is an independent, unofficial study aid. It is not affiliated with or endorsed by MaruMori.io. It simply reads your own vocab data from MaruMori's public API to help you measure comprehension.

Works on:
- **YouTube** — comprehension % badge, colored subtitle overlay with timestamp sync
- **Comprehensible Japanese** (cijapanese.com) — transcript coloring, hover definitions, word sidebar
- **Nihongo-Jikan** (nihongo-jikan.com) — transcript coloring, hover definitions, word sidebar
- **Local player** — drop any video + `.vtt`/`.srt` subtitle file for offline scoring

## Features

- **Comprehension %** — three scores (unique words, frequency words, kanji) shown as rings in the popup and directly on the player
- **Colored subtitles** — known words highlighted, unknown words distinct; blue/orange colorblind mode available
- **Hover definitions** — click any word for reading, JLPT level, and Jisho dictionary definitions
- **Word sidebar** — full unknown word list grouped by JLPT level, filterable and sortable
- **Local video player** — drop a video + subtitle file onto the built-in player to score content from any source
- **Settings** — font size (4 levels), font weight, background opacity, color mode

## Installation

### Chrome Web Store *(coming soon)*

Search for **MaruComprehension** in the Chrome Web Store.

### Load unpacked (developer mode)

1. Download the latest `MaruComprehension.zip` from the [releases folder](releases/)
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
2. Go to the **Settings** tab and paste your [MaruMori API token](https://marumori.io/account)
3. Click **Connect & fetch vocab** — your known words are downloaded and cached locally
4. Navigate to a Japanese video — comprehension scores appear automatically

## Usage

### YouTube

- A `[%|字幕|⚙|≡|⛶]` bar appears top-left of the player once the video loads
- Click **%** (the score) to re-score the current video
- Click **字幕** to toggle the colored subtitle overlay
- Click **⚙** (visible when subtitles are on) to open subtitle settings:
  - Font size: 1–4
  - Font weight: Normal / Medium / Bold
  - Background opacity: slider
  - Color mode: Blue/Red (standard) or Blue/Orange (colorblind-friendly)
- Click **≡** to open the word sidebar

### CIJ / Nihongo-Jikan

- Open any video page — a comprehension badge appears on the player automatically
- Click the popup icon to see detailed scores (unique words, frequency words, kanji)
- Click **Enable hover** to activate word highlighting on the transcript
- Click **Load word sidebar** to open the full unknown word list

### Local player

- Click **Local video player** in the popup, or open `player.html` directly
- Drop a video file and a `.vtt` or `.srt` subtitle file onto the player (or use the file picker)
- Comprehension is scored automatically when the subtitle loads
- All the same hover, sidebar, and settings features are available

## Privacy

MaruComprehension stores your API token and vocab list locally on your device. No data is sent to any server other than MaruMori (for vocab sync) and Jisho (for word lookups). See the full [Privacy Policy](https://mdecru.github.io/MaruComprehension/privacy.html).
