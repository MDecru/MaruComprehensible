# MaruComprehensible

A Chrome extension that shows your [MaruMori](https://marumori.io) comprehension percentage on Japanese videos, with colored word highlighting and on-hover definitions.

Works on:
- **YouTube** — comprehension % badge, colored subtitle overlay with timestamp sync
- **Comprehensible Japanese** (cijapanese.com) — transcript coloring and definitions
- **Nihongo-Jikan** (nihongo-jikan.com) — transcript coloring and definitions

## Features

- **Comprehension %** — scored against your MaruMori vocabulary, shown directly on the video player
- **Colored subtitles** (YouTube) — known words in blue, unknown in red (or blue/orange in colorblind mode)
- **Hover definitions** — click any word for reading, JLPT level, and Jisho definitions
- **Settings** — font size (4 levels), font weight, background opacity, color mode

## Installation

### From zip (recommended)

1. Download the latest `MaruComprehensible.zip` from the [releases folder](releases/)
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

1. Log in to [MaruMori](https://marumori.io)
2. Click the MaruComprehensible icon in the toolbar
3. Click **Sync vocab** to pull your known words
4. Navigate to a Japanese video — your comprehension % will appear automatically

## Usage

### YouTube

- The `[%|字幕|⚙]` bar appears top-left of the player once the video loads
- Click **字幕** to toggle colored subtitle overlay
- Click **⚙** (visible when subtitles are on) to open subtitle settings:
  - Font size: 1–4
  - Font weight: Normal / Medium / Bold
  - Background opacity: slider
  - Color mode: Blue/Red (standard) or Blue/Orange (colorblind-friendly)

### CIJ / Nihongo-Jikan

- Open a video page — the sidebar loads with colored transcript and comprehension stats
- Hover any word for its definition popup
