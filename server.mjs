// server.mjs — Backend Image Harvester (Codespaces-ready, ESM) 
import express from "express"; import cors from "cors";
import fetch from "node-fetch";             // v2
import robotsParser from "robots-parser";
import { chromium } from "playwright";      // Chromium Playwright (cloud)
import Archiver from "archiver";
import cors from "cors";
app.use(cors({
  origin:"*",
  methods:["GET","POST","OPTIONS"],
  allowedHeaders:["content-type"]
}));

// -------------------- App base -------------------- 
const app = express(); app.use(cors()); app.use(express.json({ limit: "1mb" }));

// -------------------- Utils ----------------------- 
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ""); }
  catch (e) { return u; }
};
const normUrl = (u) => {
  try { return new URL(u).toString(); }
  catch (e) { return u; }
};
function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    const drop = new Set([
      "w", "h", "width", "height", "q", "quality", "fit", "format", "fm", "auto", "dpr",
      "ixid", "ixlib", "crop", "cs", "usm", "ix", "s",
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"
    ]);
    const keys = Array.from(u.searchParams.keys());
    keys.forEach((k) => {
      if (drop.has(k.toLowerCase())) u.searchParams.delete(k);
    });
    return u.toString();
  } catch (e) {
    return raw;
  }
}
const uniqBy = (arr, keyFn) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// -------------------- Robots ---------------------- 
async function getRobotsAllows(url) {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await fetch(robotsUrl, { timeout: 8000 });
    if (!res.ok) return { allowed: () => true, source: "missing" };
    const txt = await res.text();
    const parser = robotsParser(robotsUrl, txt);
    return {
      allowed: (path) => parser.isAllowed(`${u.origin}${path}`, "ImageHarvesterBot"),
      source: "ok",
    };
  } catch (e) {
    return { allowed: () => true, source: "error" };
  }
}

// -------------------- Steps / logs ---------------- 
function makeSteps() {
  return [
    { key: "normalize", name: "Normaliser l'URL", status: "pending" },
    { key: "robots",    name: "Vérifier robots.txt", status: "pending" },
    { key: "open",      name: "Charger la page", status: "pending" },
    { key: "scroll",    name: "Défilement pour lazy-load", status: "pending" },
    { key: "extract",   name: "Extraction DOM + Réseau", status: "pending" },
    { key: "dedupe",    name: "Déduplication & métadonnées", status: "pending" },
    { key: "done",      name: "Terminé", status: "pending" },
  ];
}
function setRun(steps, k) { const s = steps.find((x) => x.key === k); if (s) s.status = "running"; } function setOk(steps, k)  { const s = steps.find((x) => x.key === k); if (s) s.status = "success"; } function setErr(steps, k, m) { const s = steps.find((x) => x.key === k); if (s) { s.status = "error"; s.error = String(m); } }

// -------------------- Jobs + SSE ------------------
/**
 * job: {
 *   jobId, createdAt, urls, options,
 *   resultsBySite: { [site]: { log:[], media:[], ok:null|boolean, error?:string } },
 *   streams: Set(res), done:boolean
 * }
 */
const jobs = new Map();

function newJob(urls, options) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    jobId,
    createdAt: Date.now(),
    urls,
    options,
    resultsBySite: {},
    streams: new Set(),
    done: false,
  };
  jobs.set(jobId, job);
  return job;
}
function pushEvent(job, event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.streams) res.write(line); }

// create job
app.post("/api/jobs", (req, res) => {
  const body = req.body || {};
  const urls = Array.isArray(body.urls) ? body.urls : [];
  const options = body.options || {};
  if (urls.length === 0) return res.status(400).json({ error: "Provide urls: string[]" });

  const job = newJob(urls, options);
  // snapshot initial (pour le front)
  for (const u of job.urls) {
    const site = hostOf(u);
    job.resultsBySite[site] = { log: makeSteps(), media: [], ok: null };
  }
  return res.json({ jobId: job.jobId }); });

// stream SSE
app.get("/api/stream/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  job.streams.add(res);
  res.write(`data: ${JSON.stringify({ type: "snapshot", payload: job })}\n\n`);
  req.on("close", () => { job.streams.delete(res); }); });

// run job
app.post("/api/run/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown job" });

  const given = (req.body && req.body.options) ? req.body.options : (job.options || {});
  const opt = {
    respectRobots: given.respectRobots !== false,
    forceRobots: !!given.forceRobots,
    timeoutMs: Math.min(45000, Math.max(8000, typeof given.timeoutMs === "number" ? given.timeoutMs : 25000)),
    maxScrolls: Math.min(30, Math.max(5, typeof given.maxScrolls === "number" ? given.maxScrolls : 12)),
    mode: given.mode === "overdrive" ? "overdrive" : "compliance",
  };

  pushEvent(job, { type: "start", payload: { options: opt } });

  // Chromium Playwright (cloud-friendly)
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, "webdriver", { get: () => false }); } catch (e) {}
  });

  try {
    for (const url of job.urls) {
      const site = hostOf(url);
      const record = job.resultsBySite[site] || { log: makeSteps(), media: [], ok: null };
      job.resultsBySite[site] = record;

      const page = await context.newPage();
      const notify = () => pushEvent(job, { type: "progress", payload: { site, log: record.log } });
      const addMedia = (chunk) => { record.media.push(...chunk); pushEvent(job, { type: "media", payload: { site, chunk } }); };

      try {
        await extractFromUrlAdvanced(page, url, opt, record.log, { notify, addMedia });
        record.ok = true;
        pushEvent(job, { type: "siteDone", payload: { site, ok: true, total: record.media.length } });
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        record.ok = false; record.error = msg;
        const running = record.log.find((s) => s.status === "running");
        if (running) { running.status = "error"; running.error = msg; }
        notify();
        pushEvent(job, { type: "siteDone", payload: { site, ok: false, error: msg } });
      } finally {
        try { await page.close(); } catch (e) {}
        if (opt.respectRobots && !opt.forceRobots) await sleep(opt.mode === "overdrive" ? 200 : 400);
      }
    }
  } finally {
    try { await context.close(); } catch (e) {}
    try { await browser.close(); } catch (e) {}
    job.done = true;
    pushEvent(job, { type: "done", payload: {} });
  }

  res.json({ ok: true });
});

// -------------------- Extraction ------------------- 
async function extractFromUrlAdvanced(page, startUrl, opts, log, helpers) {
  const notify = helpers.notify;
  const addMedia = helpers.addMedia;

  const run = (k) => { setRun(log, k); notify(); };
  const ok  = (k) => { setOk(log, k);  notify(); };
  const err = (k, m) => { setErr(log, k, m); notify(); };

  // 1) normalize
  run("normalize");
  const start = normUrl(startUrl);
  ok("normalize");

  // 2) robots
  run("robots");
  const startU = new URL(start);
  if (opts.respectRobots && !opts.forceRobots) {
    const rob = await getRobotsAllows(start);
    if (!rob.allowed(startU.pathname || "/")) {
      err("robots", "Disallow sur " + (startU.pathname || "/"));
      throw new Error("robots.txt disallow: " + (startU.pathname || "/"));
    }
  }
  ok("robots");

  // 3) open + cookies
  run("open");
  await page.goto(start, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });

  const cookieSelectors = [
    'button[aria-label*="Accepter"]',
    'button:has-text("Accepter")',
    'button:has-text("J\'accepte")',
    "#onetrust-accept-btn-handler",
  ];
  for (const sel of cookieSelectors) {
    try { await page.locator(sel).first().click({ timeout: 1200 }); } catch (e) {}
  }

  // hook réseau (images/vidéos)
  const seen = new Set();
  page.on("response", async (resp) => {
    try {
      const url = resp.url();
      if (!/^https?:/i.test(url)) return;
      const headers = resp.headers();
      const ct = headers["content-type"] || "";
      const rt = resp.request().resourceType();
      let kind = null;
      if (rt === "image" || ct.indexOf("image/") === 0) kind = "image";
      else if (rt === "media" || ct.indexOf("video/") === 0) kind = "video";
      if (!kind) return;
      if (seen.has(url)) return;
      seen.add(url);
      addMedia([metaWrap({ kind, url, contentType: ct, pageUrl: page.url() })]);
    } catch (e) {}
  });
  ok("open");

  // 4) scroll
  run("scroll");
  let lastH = 0;
  let stable = 0;
  const maxScrolls = Math.max(5, (typeof opts.maxScrolls === "number" ? opts.maxScrolls : 12));
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.92));
    await sleep(opts.mode === "overdrive" ? 220 : 420);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (Math.abs(h - lastH) < 30) stable++; else stable = 0;
    lastH = h;
    if (stable >= 3) break;
  }
  ok("scroll");

  // 5) extract DOM (passes)
  run("extract");

  // img/src + data-* + srcset
  const chunk1 = await page.evaluate(() => {
    const out = [];
    const abs = (u) => { try { return new URL(u, location.href).toString(); } catch (e) { return u; } };
    document.querySelectorAll("img").forEach((img) => {
      const s = img.getAttribute("src");
      if (s) out.push({ kind: "image", url: abs(s), width: img.naturalWidth || undefined, height: img.naturalHeight || undefined, alt: img.alt || undefined, pageUrl: location.href });
      ["data-src", "data-lazy", "data-original", "data-zoom-image"].forEach((k) => {
        const v = img.getAttribute(k);
        if (v) out.push({ kind: "image", url: abs(v), pageUrl: location.href });
      });
      if (img.srcset) img.srcset.split(",").map((t) => t.trim().split(" ")[0]).forEach((u) => { if (u) out.push({ kind: "image", url: abs(u), pageUrl: location.href }); });
    });
    document.querySelectorAll("picture source[srcset],source[srcset]").forEach((s) => {
      s.srcset.split(",").map((t) => t.trim().split(" ")[0]).forEach((u) => { if (u) out.push({ kind: "image", url: abs(u), pageUrl: location.href }); });
    });
    return out;
  });
  addMedia(chunk1.map(metaWrap));

  // CSS background + pseudo
  const chunk2 = await page.evaluate(() => {
    const out = [];
    const abs = (u) => { try { return new URL(u, location.href).toString(); } catch (e) { return u; } };
    const urls = (bg) => Array.from(bg.matchAll(/url\((\"|')?(.*?)\1\)/g)).map((m) => m[2]);
    document.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      [cs.backgroundImage, cs.webkitMaskImage].forEach((bg) => {
        if (bg) urls(bg).forEach((u) => out.push({ kind: "image", url: abs(u), pageUrl: location.href }));
      });
      [":before", ":after"].forEach((p) => {
        const ps = getComputedStyle(el, p);
        if (ps && ps.backgroundImage) urls(ps.backgroundImage).forEach((u) => out.push({ kind: "image", url: abs(u), pageUrl: location.href }));
      });
    });
    return out;
  });
  addMedia(chunk2.map(metaWrap));

  // <noscript>
  const chunk3 = await page.evaluate(() => {
    const out = [];
    const abs = (u) => { try { return new URL(u, location.href).toString(); } catch (e) { return u; } };
    document.querySelectorAll("noscript").forEach((ns) => {
      const d = document.implementation.createHTMLDocument("");
      d.body.innerHTML = ns.innerHTML;
      d.querySelectorAll("img[src]").forEach((img) => out.push({ kind: "image", url: abs(img.getAttribute("src")), pageUrl: location.href }));
    });
    return out;
  });
  addMedia(chunk3.map(metaWrap));

  // og:image / rel=image_src
  const chunk4 = await page.evaluate(() => {
    const out = [];
    const abs = (u) => { try { return new URL(u, location.href).toString(); } catch (e) { return u; } };
    document.querySelectorAll('meta[property="og:image"][content], link[rel~="image_src"][href]').forEach((el) => {
      const v = el.getAttribute("content") || el.getAttribute("href");
      if (v) out.push({ kind: "image", url: abs(v), pageUrl: location.href });
    });
    return out;
  });
  addMedia(chunk4.map(metaWrap));

  // videos
  const chunk5 = await page.evaluate(() => {
    const out = [];
    const abs = (u) => { try { return new URL(u, location.href).toString(); } catch (e) { return u; } };
    document.querySelectorAll("video").forEach((v) => {
      const s = v.getAttribute("src");
      if (s) out.push({ kind: "video", url: abs(s), width: v.videoWidth || undefined, height: v.videoHeight || undefined, pageUrl: location.href });
      v.querySelectorAll("source[src]").forEach((s2) => out.push({ kind: "video", url: abs(s2.getAttribute("src")), pageUrl: location.href }));
    });
    return out;
  });
  addMedia(chunk5.map(metaWrap));

  // iframes same-origin (best effort)
  try {
    const frames = page.frames().filter((f) => {
      try { return new URL(f.url()).origin === new URL(page.url()).origin; }
      catch (e) { return false; }
    });
    for (const f of frames) {
      const chunk = await f.evaluate(() => {
        const out = [];
        const abs = (u) => { try { return new URL(u, location.href).toString(); } catch (e) { return u; } };
        document.querySelectorAll("img[src]").forEach((img) => out.push({ kind: "image", url: abs(img.getAttribute("src")), pageUrl: location.href }));
        document.querySelectorAll("video, video source[src]").forEach((v) => {
          const s = v.getAttribute("src");
          if (s) out.push({ kind: "video", url: abs(s), pageUrl: location.href });
        });
        return out;
      });
      addMedia(chunk.map(metaWrap));
    }
  } catch (e) {}

  setRun(log, "dedupe"); setOk(log, "dedupe");
  setRun(log, "done");   setOk(log, "done");
}

function metaWrap(m) {
  const canon = canonicalUrl(m.url);
  return {
    ...m,
    canonical: canon,
    isDuplicate: m.url !== canon,
    fileName: m.url.split("/").pop() || undefined,
  };
}

// -------------------- Health ---------------------- 
app.get("/health", (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() }); });

// -------------------- ZIP sélection --------------- 
app.post("/api/zip", async (req, res) => {
  const urls = Array.isArray(req.body && req.body.urls) ? req.body.urls : [];
  if (urls.length === 0) return res.status(400).json({ error: "Provide urls: string[]" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=media-${Date.now()}.zip`);

  const archive = Archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  let i = 0;
  for (const u of uniqBy(urls, (x) => x)) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const ct = r.headers.get("content-type") || "";
      const ext =
        ct.indexOf("png") >= 0 ? "png" :
        ct.indexOf("webp") >= 0 ? "webp" :
        ct.indexOf("gif") >= 0 ? "gif" :
        ct.indexOf("mp4") >= 0 ? "mp4" :
        ct.indexOf("webm") >= 0 ? "webm" :
        (ct.indexOf("jpg") >= 0 || ct.indexOf("jpeg") >= 0) ? "jpg" : "bin";
      const name = `media_${String(i++).padStart(4, "0")}.${ext}`;
      archive.append(r.body, { name });
    } catch (e) {}
  }
  archive.finalize();
});

// -------------------- Téléchargement unitaire ----- 
app.get("/api/file", async (req, res) => {
  const url = req.query && req.query.url;
  if (!url) return res.status(400).send("Missing url");
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send("Upstream error");
    const ct = r.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    const filename = (new URL(url)).pathname.split("/").pop() || "file";
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    r.body.pipe(res);
  } catch (e) {
    res.status(500).send("Download error");
  }
});

// -------------------- Start ----------------------- 
const PORT = process.env.PORT || 3001; app.listen(PORT, () => {
  console.log(`API ok sur http://localhost:${PORT} (GET /health)`); });

app.get("/version",(req,res) => {
  res.json({
    app: "image-harvester-backend",
    version: "0.2.0-cors-enabled",
    now: new Date().toISOString()
  });
});