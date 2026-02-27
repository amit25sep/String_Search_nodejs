/**
 * FileSearch Server v2.0 (Async Rewrite)
 * - Full async walkDirGen()
 * - for await scanning loop
 * - Instant Stop support
 * - Full archive support (zip/jar/war/ear, tar, tar.gz, tar.bz2, tar.xz, gz)
 * - 7z/rar via external 7-Zip
 * - Live SSE streaming
 * - Smart file opener
 * - Index cache
 * - Log system
 * - Result caching
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const os = require("os");
const { exec, execSync } = require("child_process");
const zlib = require("zlib");

const PORT = 3847;

/* ------------------------ Auto Install ------------------------ */
function ensurePackages() {
    const required = ["adm-zip", "tar"];
    const missing = required.filter((pkg) => {
        try {
            require.resolve(path.join(__dirname, "node_modules", pkg));
            return false;
        } catch {
            return true;
        }
    });

    if (missing.length > 0) {
        console.log(`\n📦 Installing: ${missing.join(", ")} ...\n`);
        try {
            execSync(`npm install ${missing.join(" ")} --prefix "${__dirname}"`, {
                stdio: "inherit",
            });
            console.log("✔ Done!\n");
        } catch (e) {
            console.error(
                "❌ npm install failed. Run manually:\n npm install adm-zip tar\n"
            );
            process.exit(1);
        }
    }
}
ensurePackages();

/* ------------------ Dynamic Imports ------------------ */
function getAdmZip() {
    return require(path.join(__dirname, "node_modules", "adm-zip"));
}
function getTar() {
    return require(path.join(__dirname, "node_modules", "tar"));
}

/* ----------------------- Result Cache ----------------------- */
const resultCache = new Map();
let cacheIdCounter = 0;
function storeResults(data) {
    const id = ++cacheIdCounter;
    resultCache.set(id, data);
    if (resultCache.size > 20) {
        resultCache.delete(resultCache.keys().next().value);
    }
    return id;
}

/* ------------------------------ Logs ------------------------------ */
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "scan.txt");
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {}

function writeLog(lines) {
    try {
        fs.writeFileSync(LOG_FILE, lines.join("\n") + "\n");
    } catch {}
}

function appendLog(line) {
    try {
        fs.appendFileSync(LOG_FILE, line + "\n");
    } catch {}
}

/* ------------------------- Active Scan ------------------------- */
let activeScan = null;

/* -------------------- Directory Index Cache -------------------- */
const dirIndexCache = new Map();
const INDEX_TTL_MS = 5 * 60 * 1000;

function getFileCount(searchPath, exts) {
    const key = searchPath + "\n" + exts.join(",");
    const cached = dirIndexCache.get(key);

    if (cached && Date.now() - cached.indexedAt < INDEX_TTL_MS) {
        return { count: cached.count, fromCache: true };
    }

    const count = countFiles(searchPath, exts);
    dirIndexCache.set(key, { count, indexedAt: Date.now() });
    return { count, fromCache: false };
}

/* -------------------------- Archive Types -------------------------- */
const ARCHIVE_EXTS = new Set([
    ".zip",
    ".jar",
    ".war",
    ".ear",
    ".gz",
    ".tgz",
    ".tar",
    ".7z",
    ".rar",
    ".tar.gz",
    ".tar.bz2",
    ".tar.xz",
]);

function isArchive(f) {
    const base = path.basename(f).toLowerCase();
    const ext = path.extname(f).toLowerCase();
    return (
        ARCHIVE_EXTS.has(ext) ||
        base.endsWith(".tar.gz") ||
        base.endsWith(".tar.bz2") ||
        base.endsWith(".tar.xz")
    );
}

function getArchiveType(filePath) {
    const b = filePath.toLowerCase();
    if (b.endsWith(".tar.gz") || b.endsWith(".tgz")) return "tar.gz";
    if (b.endsWith(".tar.bz2")) return "tar.bz2";
    if (b.endsWith(".tar.xz")) return "tar.xz";
    if (b.endsWith(".tar")) return "tar";
    if (b.endsWith(".gz")) return "gz";
    if (b.endsWith(".zip") || b.endsWith(".jar") || b.endsWith(".war") || b.endsWith(".ear"))
        return "zip";
    if (b.endsWith(".7z")) return "7z";
    if (b.endsWith(".rar")) return "rar";
    return "unknown";
}

/* ---------------------------- Search Helpers ---------------------------- */

function buildPattern(query, isRegex, caseSensitive, exactMatch) {
    if (isRegex) return new RegExp(query, caseSensitive ? "" : "i");

    if (exactMatch) {
        const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![\\w])${esc}(?![\\w])`, caseSensitive ? "g" : "gi");
    }

    return query;
}

function matchesLine(line, pattern, caseSensitive) {
    if (pattern instanceof RegExp) {
        pattern.lastIndex = 0;
        return pattern.test(line);
    }
    const h = caseSensitive ? line : line.toLowerCase();
    const n = caseSensitive ? pattern : pattern.toLowerCase();
    return h.includes(n);
}

function searchContent(content, pattern, caseSensitive) {
    const lines = content.split("\n");
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
        if (matchesLine(lines[i], pattern, caseSensitive)) {
            matches.push({ line: i + 1, content: lines[i].trim() });
        }
    }
    return matches;
}

function isBinaryBuffer(buf) {
    const check = buf.slice(0, 512);
    for (let i = 0; i < check.length; i++) if (check[i] === 0) return true;
    return false;
}

/* --------------------- File & Archive Searchers --------------------- */
function searchFile(filePath, pattern, caseSensitive) {
    try {
        const buf = fs.readFileSync(filePath);
        if (isBinaryBuffer(buf)) return [];
        return searchContent(buf.toString("utf8"), pattern, caseSensitive);
    } catch {
        return [];
    }
}

function searchZip(filePath, pattern, caseSensitive) {
    const results = [];
    try {
        const AdmZip = getAdmZip();
        const zip = new AdmZip(filePath);

        for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            try {
                const buf = entry.getData();
                if (!buf || isBinaryBuffer(buf)) continue;
                const matches = searchContent(buf.toString("utf8"), pattern, caseSensitive);
                if (matches.length > 0)
                    results.push({ innerFile: entry.entryName, matches });
            } catch {}
        }
    } catch {}
    return results;
}

function searchGzip(filePath, pattern, caseSensitive) {
    try {
        const content = zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf8");
        const matches = searchContent(content, pattern, caseSensitive);
        return matches.length > 0
            ? [{ innerFile: path.basename(filePath, ".gz"), matches }]
            : [];
    } catch {
        return [];
    }
}

function searchTar(filePath, archiveType, pattern, caseSensitive) {
    const results = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsearch-"));

    try {
        const flags = { file: filePath, cwd: tmpDir, sync: true };
        if (archiveType === "tar.gz") flags.gzip = true;
        if (archiveType === "tar.bz2") flags.bzip2 = true;
        if (archiveType === "tar.xz") flags.xz = true;

        getTar().x(flags);

        // flatten
        const files = walkDirFlat(tmpDir);
        for (const ef of files) {
            try {
                const buf = fs.readFileSync(ef);
                if (isBinaryBuffer(buf)) continue;
                const matches = searchContent(buf.toString("utf8"), pattern, caseSensitive);
                if (matches.length > 0)
                    results.push({
                        innerFile: path.relative(tmpDir, ef),
                        matches,
                    });
            } catch {}
        }
    } catch {} finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    }

    return results;
}

function search7zOrRar(filePath, pattern, caseSensitive) {
    const sevenZip = findSevenZip();
    if (!sevenZip) return [];

    const results = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsearch-"));

    try {
        execSync(`"${sevenZip}" x "${filePath}" -o"${tmpDir}" -y -bd`, {
            stdio: "ignore",
        });

        for (const ef of walkDirFlat(tmpDir)) {
            try {
                const buf = fs.readFileSync(ef);
                if (isBinaryBuffer(buf)) continue;
                const matches = searchContent(buf.toString("utf8"), pattern, caseSensitive);
                if (matches.length > 0)
                    results.push({
                        innerFile: path.relative(tmpDir, ef),
                        matches,
                    });
            } catch {}
        }
    } catch {} finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    }

    return results;
}

function findSevenZip() {
    for (const c of [
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
        "7z",
        "7za",
    ]) {
        try {
            execSync(`"${c}" i`, { stdio: "ignore" });
            return c;
        } catch {}
    }
    return null;
}

function searchAnyFile(filePath, pattern, caseSensitive) {
    if (!isArchive(filePath)) {
        const m = searchFile(filePath, pattern, caseSensitive);
        return m.length > 0
            ? [{ file: filePath, matches: m, isArchive: false }]
            : [];
    }

    const type = getArchiveType(filePath);
    let inner = [];

    if (["zip", "jar", "war", "ear"].includes(type))
        inner = searchZip(filePath, pattern, caseSensitive);
    else if (type === "gz") inner = searchGzip(filePath, pattern, caseSensitive);
    else if (["tar", "tar.gz", "tar.bz2", "tar.xz"].includes(type))
        inner = searchTar(filePath, type, pattern, caseSensitive);
    else if (["7z", "rar"].includes(type))
        inner = search7zOrRar(filePath, pattern, caseSensitive);

    return inner
        .filter((r) => r.matches.length > 0)
        .map((ir) => ({
            file: filePath + " → " + ir.innerFile,
            archiveFile: filePath,
            innerFile: ir.innerFile,
            matches: ir.matches,
            isArchive: true,
        }));
}

/* ---------------------- Directory Walkers ---------------------- */
// Used for archive extraction scans
function walkDirFlat(dir, results = []) {
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walkDirFlat(full, results);
            else if (e.isFile()) results.push(full);
        }
    } catch {}
    return results;
}

// Used for indexing
function countFiles(dir, exts) {
    let count = 0;
    try {
        const stack = [dir];
        while (stack.length > 0) {
            const current = stack.pop();
            let entries;
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const e of entries) {
                if (e.isDirectory()) stack.push(path.join(current, e.name));
                else if (e.isFile()) {
                    if (!exts || exts.length === 0) count++;
                    else {
                        const ext = path.extname(e.name).toLowerCase();
                        const base = e.name.toLowerCase();
                        if (
                            exts.includes(ext) ||
                            (base.endsWith(".tar.gz") && exts.includes(".tar.gz")) ||
                            (base.endsWith(".tar.bz2") && exts.includes(".tar.bz2"))
                        )
                            count++;
                    }
                }
            }
        }
    } catch {}
    return count;
}

/* ---------------------- ASYNC walkDirGen (Main Fix) ---------------------- */

async function* walkDirGen(dir, exts) {
    const stack = [dir];

    while (stack.length > 0) {
        const current = stack.pop();

        // Yield control so Stop works instantly
        await new Promise((res) => setImmediate(res));

        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const e of entries) {
            const full = path.join(current, e.name);
            if (e.isDirectory()) {
                stack.push(full);
            } else if (e.isFile()) {
                if (!exts || exts.length === 0) {
                    yield full;
                } else {
                    const ext = path.extname(e.name).toLowerCase();
                    const base = e.name.toLowerCase();
                    if (
                        exts.includes(ext) ||
                        (base.endsWith(".tar.gz") && exts.includes(".tar.gz")) ||
                        (base.endsWith(".tar.bz2") && exts.includes(".tar.bz2"))
                    ) {
                        yield full;
                    }
                }
            }
        }
    }
}

/* ------------------------------ File Opener ------------------------------ */
const EXCEL_EXTS = new Set([".csv", ".xlsx", ".xls", ".xlsm", ".xlsb", ".ods"]);
const WORD_EXTS = new Set([".doc", ".docx", ".rtf", ".odt"]);
const PDF_EXTS = new Set([".pdf"]);
const CODE_EXTS = new Set([
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".py",
    ".java",
    ".cpp",
    ".c",
    ".cs",
    ".php",
    ".rb",
    ".go",
    ".rs",
    ".sh",
    ".bat",
    ".ps1",
    ".html",
    ".css",
    ".scss",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
    ".toml",
    ".md",
    ".sql",
    ".txt",
    ".log",
    ".ini",
    ".cfg",
    ".conf",
    ".env",
    ".gitignore",
]);

function openFileAtLine(filePath, line) {
    const ext = path.extname(filePath).toLowerCase();
    const p = os.platform();

    if (p === "win32") {
        if (EXCEL_EXTS.has(ext) || WORD_EXTS.has(ext) || PDF_EXTS.has(ext)) {
            exec(`cmd /c start "" "${filePath}"`);
        } else if (CODE_EXTS.has(ext)) {
            exec(`code --goto "${filePath}:${line}"`, (err) => {
                if (err) {
                    exec(
                        `"C:\\Program Files\\Notepad++\\notepad++.exe" -n${line} "${filePath}"`,
                        (err2) => {
                            if (err2) {
                                exec(
                                    `"C:\\Program Files (x86)\\Notepad++\\notepad++.exe" -n${line} "${filePath}"`,
                                    (err3) => {
                                        if (err3) exec(`notepad "${filePath}"`);
                                    }
                                );
                            }
                        }
                    );
                }
            });
        } else {
            exec(`cmd /c start "" "${filePath}"`);
        }
    } else if (p === "darwin") {
        if (EXCEL_EXTS.has(ext) || WORD_EXTS.has(ext) || PDF_EXTS.has(ext)) {
            exec(`open "${filePath}"`);
        } else {
            exec(`code --goto "${filePath}:${line}"`, (err) => {
                if (err) exec(`open "${filePath}"`);
            });
        }
    } else {
        exec(`code --goto "${filePath}:${line}"`, (err) => {
            if (err) exec(`xdg-open "${filePath}"`);
        });
    }
}

function revealInExplorer(filePath) {
    const real = filePath.includes(" → ") ? filePath.split(" → ")[0] : filePath;
    const p = os.platform();

    if (p === "win32") exec(`explorer /select,"${real}"`);
    else if (p === "darwin") exec(`open -R "${real}"`);
    else exec(`xdg-open "${path.dirname(real)}"`);
}

/* ------------------------------ HTTP Server ------------------------------ */
const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        return res.end();
    }

    const parsed = (() => {
        const u = new URL(req.url, `http://localhost:${PORT}`);
        // Mimic the url.parse(x, true) shape used throughout
        const query = {};
        u.searchParams.forEach((v, k) => { query[k] = v; });
        return { pathname: u.pathname, query };
    })();

    /* -------------- Serve HTML Pages -------------- */
    if (parsed.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"));
    }

    if (parsed.pathname === "/results" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(fs.readFileSync(path.join(__dirname, "results.html"), "utf8"));
    }

    /* ----------------------- SEARCH (SSE) ----------------------- */
    if (parsed.pathname === "/search" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
            let params;
            try {
                params = JSON.parse(body);
            } catch {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: "Invalid JSON" }));
            }

            const {
                searchPath,
                query,
                isRegex,
                caseSensitive,
                extensions,
                exactMatch,
            } = params;

            if (!searchPath || !query) {
                res.writeHead(400);
                return res.end(
                    JSON.stringify({ error: "searchPath and query are required" })
                );
            }

            if (!fs.existsSync(searchPath)) {
                res.writeHead(400);
                return res.end(
                    JSON.stringify({ error: `Path does not exist: ${searchPath}` })
                );
            }

            const exts = extensions
                ? extensions
                      .split(",")
                      .map((e) => e.trim())
                      .filter(Boolean)
                      .map((e) => (e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase()))
                : [];

            let pattern;
            try {
                pattern = buildPattern(query, isRegex, caseSensitive, exactMatch);
            } catch {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: "Invalid regex" }));
            }

            if (activeScan) activeScan.stopped = true;

            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });

            const scan = { stopped: false, res };
            activeScan = scan;

            function send(evt, data) {
                try {
                    if (!scan.stopped)
                        res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
                } catch {}
            }

            const results = [];
            let totalMatches = 0;
            let filesScanned = 0;

            const t0 = Date.now();
            const startTime = new Date().toISOString();
            const cs = caseSensitive && !isRegex && !exactMatch;

            writeLog([
                "================================================",
                " FileSearch Scan Log",
                " Started : " + startTime,
                " Path : " + searchPath,
                " Pattern : " +
                    (isRegex ? "[regex] " : exactMatch ? "[exact] " : "") +
                    query,
                "================================================",
                "",
            ]);

            // Create cache entry immediately — resultId available before scan completes
            const resultId = storeResults({ results, filesScanned: 0, totalFiles: 0, totalMatches: 0, elapsed: '0', stopped: false });

            send("start", { total: null, fromCache: false, resultId });

            try {
                for await (const filePath of walkDirGen(searchPath, exts)) {
                    if (scan.stopped) {
                        appendLog("");
                        appendLog(">>> SCAN STOPPED BY USER after " + filesScanned + " files");
                        appendLog(
                            ">>> Results so far: " +
                                results.length +
                                " files, " +
                                totalMatches +
                                " matches"
                        );
                        break;
                    }

                    filesScanned++;
                    appendLog("[" + filesScanned + "] " + filePath);

                    if (filesScanned % 25 === 0) {
                        const elapsed = (Date.now() - t0) / 1000;
                        const rate = filesScanned > 1 ? filesScanned / elapsed : 0;
                        send("progress", {
                            current: filesScanned,
                            rate: Math.round(rate),
                            currentFile: filePath,
                            matches: results.length,
                        });
                    }

                    const fileResults = searchAnyFile(filePath, pattern, cs);

                    for (const r of fileResults) {
                        totalMatches += r.matches.length;
                        results.push(r);
                        send("match", r);
                    }
                }
            } catch (e) {
                console.error("Scan error:", e);
            }

            const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
            const stopped = scan.stopped;

            appendLog("");
            appendLog("================================================");
            appendLog(" " + (stopped ? "STOPPED" : "COMPLETED") + " in " + elapsed + "s");
            appendLog(" Files scanned : " + filesScanned);
            appendLog(" Files matched : " + results.length);
            appendLog(" Total matches : " + totalMatches);
            appendLog("================================================");

            if (activeScan === scan) activeScan = null;

            const payload = {
                results,
                filesScanned,
                totalFiles: filesScanned,
                totalMatches,
                elapsed,
                stopped,
            };

            // Update the existing cache entry with final data
            resultCache.set(resultId, payload);

            send("done", {
                filesScanned,
                totalFiles: filesScanned,
                totalMatches,
                elapsed,
                stopped,
                resultId,
                matchedFiles: results.length,
            });

            res.end();
        });

        return;
    }

    /* ------------------------- RESULT DATA ------------------------- */
    if (parsed.pathname === "/results-data" && req.method === "GET") {
        const id = parseInt(parsed.query.id);
        if (!id || !resultCache.has(id)) {
            res.writeHead(404);
            return res.end(
                JSON.stringify({ error: "Result not found. Please search again." })
            );
        }

        const fileIdx =
            parsed.query.file !== undefined ? parseInt(parsed.query.file) : null;
        const cached = resultCache.get(id);

        if (fileIdx !== null && !isNaN(fileIdx)) {
            const single = cached.results[fileIdx];
            if (!single) {
                res.writeHead(404);
                return res.end(JSON.stringify({ error: "File not found." }));
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(
                JSON.stringify({ ...cached, results: [single], singleFile: true })
            );
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(cached));
    }

    /* -------------------------- BROWSE -------------------------- */
    if (parsed.pathname === "/browse" && req.method === "GET") {
        const dir = parsed.query.path || "C:\\";
        if (!fs.existsSync(dir)) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: "Path not found" }));
        }

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const dirs = entries
                .filter((e) => e.isDirectory())
                .map((e) => ({ name: e.name, path: path.join(dir, e.name) }));

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ dirs, current: dir }));
        } catch {
            res.writeHead(403);
            return res.end(JSON.stringify({ error: "Permission denied" }));
        }
    }

    /* ------------------------- OPEN FILE ------------------------- */
    if (parsed.pathname === "/open" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            try {
                const { filePath, line } = JSON.parse(body);
                const real =
                    filePath && filePath.includes(" → ")
                        ? filePath.split(" → ")[0]
                        : filePath;
                openFileAtLine(real, line || 1);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    /* ----------------------- REVEAL FILE ----------------------- */
    if (parsed.pathname === "/reveal" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            try {
                const { filePath } = JSON.parse(body);
                revealInExplorer(filePath);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    /* ------------------------- STOP SCAN ------------------------- */
    if (parsed.pathname === "/stop" && req.method === "POST") {
        if (activeScan) {
            activeScan.stopped = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, message: "Scan stopped" }));
        } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, message: "No active scan" }));
        }
    }

    /* ----------------------- CLEAR INDEX CACHE ----------------------- */
    if (parsed.pathname === "/clear-index" && req.method === "POST") {
        dirIndexCache.clear();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, message: "Index cache cleared" }));
    }

    /* ----------------------------- 404 ----------------------------- */
    res.writeHead(404);
    res.end("Not found");
});

/* ---------------------------- SERVER START ---------------------------- */
server.listen(PORT, () => {
    console.log(`\n🔍 FileSearch v2.0 (Async) running at http://localhost:${PORT}`);
    console.log("\n📦 Supported formats:");
    console.log("  Text: .txt .log .js .py .json .xml .csv .html .md etc.");
    console.log("  Archives: .zip .jar .war .ear .tar .tar.gz .tgz .tar.bz2 .gz");
    console.log("  With 7-Zip: .7z .rar\n");
});