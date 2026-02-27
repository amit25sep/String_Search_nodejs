# 🔍 FileSearch

> A fast, local web-based file search portal — inspired by Agent Ransack, built with Node.js.

Search for text or regex patterns across **millions of files** on your machine, with live streaming results, archive support, and smart file opening. No installation wizard, no cloud, no tracking — runs entirely on your own machine.

---

## ✨ Features

| Feature | Details |
|---|---|
| ⚡ **Live streaming results** | Files appear in real-time as they're found — no waiting for the scan to finish |
| 🔍 **Search modes** | Plain text, Regex, Exact match (find `123` without matching `123456`), Case-sensitive |
| 🗜️ **Archive search** | Search inside `.zip`, `.jar`, `.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.gz` — and `.7z`/`.rar` with 7-Zip installed |
| 📊 **Sort results** | Sort by Found Order, Match Count, File Name, Extension, or Directory — click again to reverse |
| 📋 **Show List** | Opens a dedicated full-page viewer for any file's matches in a new tab |
| 🧠 **Memory safe** | Uses a generator-based walker — handles 500,000+ files without running out of memory |
| 📂 **Smart file open** | Opens `.csv`/`.xlsx` in Excel, `.docx` in Word, code files in VS Code → Notepad++ → Notepad |
| 📁 **Reveal in Explorer** | Jump straight to the file's location in Windows Explorer |
| ⏹ **Stop anytime** | Cancel a running scan and keep all results found so far |
| 📄 **Scan log** | Every scan writes a live log to `C:\Ransack\logs\scan.txt` |
| ⚡ **Index cache** | Directory structure is cached for 5 minutes — repeat searches start instantly |

---

## 📋 Requirements

- [Node.js](https://nodejs.org/) v18 or newer
- Windows (primary target — also works on macOS/Linux with minor path differences)
- 7-Zip *(optional)* — required only for `.7z` and `.rar` archive search

---

## 🚀 Quick Start

1. **Download or clone** this repository into `C:\Ransack\`

2. **Double-click `start.bat`**

   That's it. The batch file will:
   - Detect Node.js automatically
   - Install npm dependencies on first run (`adm-zip`, `tar`)
   - Kill any stale server on port 3847
   - Start the server and open your browser

3. **Browse to** `http://localhost:3847`

> Keep the black terminal window open — closing it stops the server.

### Manual start (optional)

```bash
cd C:\Ransack
npm install
node server.js
```

---

## 🖥️ Usage

### Basic search
1. Enter a **folder path** (or click 📁 to browse)
2. Type your **search query**
3. Optionally filter by **file extensions** e.g. `.txt, .csv, .log`
4. Click **⚡ Search Files**

Results stream in live as files are scanned.

### Search modes

| Toggle | Behaviour |
|---|---|
| **Exact Match** | `123` only matches `123` — not `1234`, `abc123`, `123abc` |
| **Regex** | Full regex support e.g. `error.*timeout`, `^\d{4}-\d{2}-\d{2}` |
| **Case Sensitive** | Disables case-folding for plain text and exact searches |

> Exact Match and Regex are mutually exclusive.

### Sorting results

Once results appear, use the sort bar to reorder:

- 🕐 **Found Order** — default, order of discovery
- 🔥 **Matches** — highest match count first
- 🔤 **File Name** — alphabetical by filename
- 📎 **Extension** — groups `.csv`, `.js`, `.txt` etc. together
- 📁 **Directory** — alphabetical by folder path

Click the same sort button again to **reverse** the direction (▲/▼).

### Show List

Click **📋 Show List** on any file row to open a full-page match viewer in a new tab, showing every matching line with syntax highlighting, line numbers, and open/reveal actions. Works while the scan is still running, after it completes, or after stopping early.

### Stopping a scan

Click **⏹ Stop Scanning** at any time. Results found so far are preserved and fully usable — sort, Show List, and Reveal all still work.

---

## 📁 File Structure

```
C:\Ransack\
├── server.js          # Node.js backend — search engine, SSE, archive support
├── index.html         # Main search UI
├── results.html       # Full-page match viewer (opened via Show List)
├── start.bat          # Windows launcher
├── package.json
├── node_modules\      # Auto-installed on first run
└── logs\
    └── scan.txt       # Live scan log — updated during every search
```

---

## 📦 Supported Formats

### Plain text (searched directly)
`.txt` `.log` `.csv` `.json` `.xml` `.html` `.js` `.ts` `.py` `.java` `.cs` `.cpp` `.c` `.go` `.rb` `.php` `.sh` `.bat` `.md` `.yaml` `.yml` `.toml` `.sql` `.ini` `.cfg` `.conf` `.env` and more — any file without null bytes is treated as text.

### Archives (contents searched)

| Format | Requirement |
|---|---|
| `.zip` `.jar` `.war` `.ear` | Built-in |
| `.tar` `.tar.gz` `.tgz` `.tar.bz2` `.tar.xz` `.gz` | Built-in |
| `.7z` `.rar` | Requires [7-Zip](https://www.7-zip.org/) installed |

---

## ⚙️ Configuration

All config is at the top of `server.js`:

```js
const PORT = 3847;                    // change if port is in use
const INDEX_TTL_MS = 5 * 60 * 1000;  // index cache lifetime (ms)
```

---

## 🛠️ Smart File Opening

When you click **Open** on a match, the file opens in the most appropriate app:

| File type | Opens in |
|---|---|
| `.csv`, `.xlsx`, `.xls`, `.ods` | Excel / LibreOffice Calc |
| `.doc`, `.docx`, `.rtf` | Word / LibreOffice Writer |
| `.pdf` | Default PDF viewer |
| Code & text files | VS Code (with line nav) → Notepad++ → Notepad |
| Everything else | Windows default association |

---

## 🪵 Scan Log

Every search writes a log to `C:\Ransack\logs\scan.txt`:

```
================================================
 FileSearch Scan Log
 Started : 2026-02-27T10:32:14.000Z
 Path    : C:\Projects
 Pattern : [exact] 123
================================================

[1] C:\Projects\app\config.js
[2] C:\Projects\app\server.js
...

>>> SCAN STOPPED BY USER after 312 files

================================================
 STOPPED in 1.84s
 Files scanned : 312
 Files matched : 5
 Total matches : 18
================================================
```

Each new search **overwrites** the previous log.

---

## 🔧 Troubleshooting

**"Failed to fetch" / server not responding**
- Make sure the black terminal window is still open
- Check if another app is using port 3847 — change `PORT` in `server.js` if needed
- Re-run `start.bat`

**Out of memory on very large drives**
- Use the **file extensions filter** to narrow the search scope
- Use a more specific subfolder path instead of scanning an entire drive

**`.7z` / `.rar` files not being searched**
- Install [7-Zip](https://www.7-zip.org/) — it must be at `C:\Program Files\7-Zip\7z.exe`

**Files not opening in the right app**
- Set Windows default app associations: right-click a `.csv` → Open With → Choose default

---

## 🏗️ Tech Stack

- **Backend**: Node.js (built-in `http`, `fs`, `path`, `zlib`) + `adm-zip`, `tar`
- **Frontend**: Vanilla HTML/CSS/JS — zero frameworks, zero dependencies
- **Transport**: Server-Sent Events (SSE) for live streaming results
- **Fonts**: JetBrains Mono + Syne (Google Fonts)

---

## 📄 License

MIT — free to use, modify, and distribute.
