// server.mjs — Node 18+/20, ESM
import express from "express";
import cors from "cors";
import fetch from "node-fetch";           // v2
import robotsParser from "robots-parser";
import { chromium } from "playwright";    // Chrome installé (channel: "chrome")
import Archiver from "archiver";
import pLimit from "p-limit";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Utils ----------
const sleep = (ms)=> new Promise(r=> setTimeout(r, ms));
const normalizeUrl = (u)=> { try { return new URL(u).toString(); } catch { return u; } };
const domain = (u)=> { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return u; } };

function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    const drop = new Set(["w","h","width","height","q","quality","fit","format","fm","auto","ixid","ixlib","crop","cs","dpr","usm","ix","s","utm_source","utm_medium","utm_campaign","utm_term","utm_content"]);
    [...u.searchParams.keys()].forEach(k=> { if (drop.has(k.toLowerCase())) u.searchParams.delete(k); });
    return u.toString();
  } catch { return raw; }
}
const uniqBy = (arr, keyFn)=> { const seen=new Set(); return arr.filter(x=>{ const k=keyFn(x); if(seen.has(k)) return false; seen.add(k); return true; }); };

// ---------- Robots ----------
async function getRobotsAllows(url) {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await fetch(robotsUrl, { timeout: 8000 });
    if (!res.ok) return { allowed: () => true, source: "missing" };
    const txt = await res.text();
    const parser = robotsParser(robotsUrl, txt);
    return { allowed: (path) => parser.isAllowed(`${u.origin}${path}`, "ImageHarvesterBot"), source: "ok" };
  } catch {
    return { allowed: () => true, source: "error" };
  }
}

// ---------- Steps ----------
function makeSteps() {
  return [
    { key:"normalize", name:"Normaliser l'URL", status:"pending" },
    { key:"robots",    name:"Vérifier robots.txt", status:"pending" },
    { key:"open",      name:"Charger la page", status:"pending" },
    { key:"scroll",    name:"Défilement pour lazy-load", status:"pending" },
    { key:"extract",   name:"Extraction DOM + Réseau (images/vidéos)", status:"pending" },
    { key:"dedupe",    name:"Déduplication & métadonnées", status:"pending" },
    { key:"done",      name:"Terminé", status:"pending" }
  ];
}
function setRun(steps, key){ const s=steps.find(x=>x.key===key); if(s) s.status="running"; }
function setOk(steps, key){ const s=steps.find(x=>x.key===key); if(s) s.status="success"; }
function setErr(steps, key, msg){ const s=steps.find(x=>x.key===key); if(s){ s.status="error"; s.error=String(msg); } }

// ---------- SSE Jobs ----------
const jobs = new Map(); // jobId -> { urls, options, resultsBySite, streams:Set(res), done }
function newJob(urls, options) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const job = {
    jobId, createdAt: Date.now(), urls, options,
    resultsBySite: {}, // site -> { log:[], media:[], ok:boolean|null, error?:string }
    streams: new Set(), done: false
  };
  jobs.set(jobId, job);
  return job;
}
function pushEvent(job, event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.streams) { res.write(line); }
}

// Create job
app.post("/api/jobs", (req, res) => {
  const { urls, options } = req.body || {};
  if (!Array.isArray(urls) || urls.length===0) return res.status(400).json({ error:"Provide urls: string[]" });
  const job = newJob(urls, options||{});
  res.json({ jobId: job.jobId });
});

// Stream progress (SSE)
app.get("/api/stream/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  job.streams.add(res);
  // snapshot initial
  res.write(`data: ${JSON.stringify({ type:"snapshot", payload: job })}\n\n`);

  req.on("close", () => { job.streams.delete(res); });
});

// Run job
app.post("/api/run/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error:"Unknown job" });

  const options = req.body?.options || job.options || {};
  const opt = {
    respectRobots: options?.respectRobots !== false,
    forceRobots: !!options?.forceRobots,
    timeoutMs: Math.min(45000, Math.max(8000, options?.timeoutMs ?? 25000)),
    maxScrolls: Math.min(30, Math.max(5, options?.maxScrolls ?? 10)),
    mode: options?.mode === "overdrive" ? "overdrive" : "compliance"
  };

  // init per site
  for (const u of job.urls) {
    const site = domain(u);
    job.resultsBySite[site] = { log: makeSteps(), media: [], ok: null };
  }
  pushEvent(job, { type:"start", payload:{ options: opt } });

  // Launch Chrome installé
  const browser = await chromium.launch({ headless:true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    locale: "fr-FR", timezoneId: "Europe/Paris"
  });
  // anti-bot minimal
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    for (const u of job.urls) {
      const site = domain(u);
      const record = job.resultsBySite[site];
      const page = await context.newPage();
      const notify = () => pushEvent(job, { type:"progress", payload:{ site, log: record.log } });
      const addMedia = (chunk) => {
        record.media.push(...chunk);
        pushEvent(job, { type:"media", payload:{ site, chunk } });
      };

      try {
        await extractFromUrlAdvanced(page, u, opt, record.log, { notify, addMedia });
        record.ok = true;
        pushEvent(job, { type:"siteDone", payload:{ site, ok:true, total: record.media.length } });
      } catch (e) {
        const msg = e?.message || String(e);
        record.ok = false; record.error = msg;
        const running = record.log.find(s=> s.status==="running");
        if (running) { running.status="error"; running.error=msg; }
        notify();
        pushEvent(job, { type:"siteDone", payload:{ site, ok:false, error: msg } });
      } finally {
        await page.close().catch(()=>{});
        if (opt.respectRobots && !opt.forceRobots) await sleep(opt.mode==="overdrive"? 200 : 400);
      }
    }
  } finally {
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
    job.done = true;
    pushEvent(job, { type:"done", payload:{ } });
  }

  res.json({ ok:true });
});

// ---------- Extraction avancée ----------
async function extractFromUrlAdvanced(page, startUrl, opts, log, { notify, addMedia }) {
  const run = (k)=>{ setRun(log,k); notify(); };
  const ok  = (k)=>{ setOk(log,k);  notify(); };
  const err = (k,m)=>{ setErr(log,k,m); notify(); };

  // normalize
  run("normalize");
  const start = normalizeUrl(startUrl);
  ok("normalize");

  // robots
  run("robots");
  const u = new URL(start);
  if (opts.respectRobots && !opts.forceRobots) {
    const rob = await getRobotsAllows(start);
    if (!rob.allowed(u.pathname || "/")) { err("robots", `Disallow sur ${u.pathname}`); throw new Error(`robots.txt disallow: ${u.pathname}`); }
  }
  ok("robots");

  // open
  run("open");
  await page.goto(start, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
  // cookies consent (best effort) — **corrigé avec backticks**
  const cookieSelectors = [
    `button[aria-label*="Accepter"]`,
    `button:has-text("Accepter")`,
    `button:has-text("J'accepte")`,
    `button#onetrust-accept-btn-handler`
  ];
  for (const sel of cookieSelectors) { try { await page.locator(sel).first().click({ timeout: 1500 }); } catch {} }

  // capture réseau (image/vidéo)
  const seen = new Set();
  page.on("response", async (resp) => {
    try {
      const url = resp.url(); if (!/^https?:/i.test(url)) return;
      const ct = resp.headers()["content-type"] || "";
      const cl = parseInt(resp.headers()["content-length"]||"0",10) || undefined;
      const rt = resp.request().resourceType();
      let kind = null;
      if (rt==="image" || ct.startsWith("image/")) kind="image";
      else if (rt==="media" || ct.startsWith("video/")) kind="video";
      if (!kind) return;
      if (seen.has(url)) return; seen.add(url);
      addMedia([dedupeWrap({ kind, url, contentType: ct, size: cl, pageUrl: page.url() })]);
    } catch {}
  });
  ok("open");

  // scroll intelligent
  run("scroll");
  let lastH=0, stable=0;
  for (let i=0;i<Math.max(5, opts.maxScrolls||10); i++){
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.92));
    await sleep(opts.mode==="overdrive"? 220 : 420);
    const h = await page.evaluate(()=> document.body.scrollHeight);
    if (Math.abs(h-lastH)<30) stable++; else stable=0;
    lastH=h; if (stable>=3) break;
  }
  ok("scroll");

  // extract DOM en plusieurs passes + chunks

  // 1) img/src + data-* + srcset + picture/source
  run("extract");
  const chunk1 = await page.evaluate(() => {
    const out=[]; const abs=(u)=>{ try{return new URL(u, location.href).toString();}catch{return u;} };
    document.querySelectorAll("img").forEach(img=>{
      if (img.getAttribute("src")) out.push({kind:"image", url:abs(img.getAttribute("src")), width:img.naturalWidth||undefined, height:img.naturalHeight||undefined, alt:img.alt||undefined, pageUrl:location.href});
      ["data-src","data-lazy","data-original","data-zoom-image"].forEach(k=>{
        const v=img.getAttribute(k); if (v) out.push({kind:"image", url:abs(v), pageUrl:location.href});
      });
      if (img.srcset) img.srcset.split(",").map(s=>s.trim().split(" ")[0]).forEach(u=> u && out.push({kind:"image", url:abs(u), pageUrl:location.href}));
    });
    document.querySelectorAll("picture source[srcset],source[srcset]").forEach(s=>{
      s.srcset.split(",").map(t=>t.trim().split(" ")[0]).forEach(u=> u && out.push({kind:"image", url:abs(u), pageUrl:location.href}));
    });
    return out;
  });
  addMedia(chunk1.map(dedupeWrap));

  // 2) CSS background + pseudo-elements — **regex corrigée (un seul antislash)**
  const chunk2 = await page.evaluate(() => {
    const out=[]; const abs=(u)=>{ try{return new URL(u, location.href).toString();}catch{return u;} };
    const urlFromStyle = (bg)=> [...bg.matchAll(/url\((\"|')?(.*?)\1\)/g)].map(m=>m[2]);
    document.querySelectorAll("*").forEach(el=>{
      const cs = getComputedStyle(el);
      [cs.backgroundImage, cs.webkitMaskImage].forEach(bg=>{
        if (!bg) return;
        urlFromStyle(bg).forEach(u=> out.push({kind:"image", url:abs(u), pageUrl:location.href}));
      });
      [":before",":after"].forEach(p=>{
        const ps = getComputedStyle(el, p);
        if (ps && ps.backgroundImage) urlFromStyle(ps.backgroundImage).forEach(u=> out.push({kind:"image", url:abs(u), pageUrl:location.href}));
      });
    });
    return out;
  });
  addMedia(chunk2.map(dedupeWrap));

  // 3) noscript fallback
  const chunk3 = await page.evaluate(() => {
    const out=[]; const abs=(u)=>{ try{return new URL(u, location.href).toString();}catch{return u;} };
    document.querySelectorAll("noscript").forEach(ns=>{
      const html = ns.innerHTML;
      const d = document.implementation.createHTMLDocument(""); d.body.innerHTML=html;
      d.querySelectorAll("img").forEach(img=> {
        const s = img.getAttribute("src"); if (s) out.push({kind:"image", url:abs(s), pageUrl:location.href});
      });
    });
    return out;
  });
  addMedia(chunk3.map(dedupeWrap));

  // 4) meta og:image, link rel=image_src
  const chunk4 = await page.evaluate(() => {
    const out=[]; const abs=(u)=>{ try{return new URL(u, location.href).toString();}catch{return u;} };
    document.querySelectorAll('meta[property="og:image"][content],link[rel~="image_src"][href]').forEach(el=>{
      const url = el.getAttribute("content") || el.getAttribute("href");
      if (url) out.push({kind:"image", url:abs(url), pageUrl:location.href});
    });
    return out;
  });
  addMedia(chunk4.map(dedupeWrap));

  // 5) vidéos
  const chunk5 = await page.evaluate(() => {
    const out=[]; const abs=(u)=>{ try{return new URL(u, location.href).toString();}catch{return u;} };
    document.querySelectorAll("video").forEach(v=>{
      if (v.getAttribute("src")) out.push({kind:"video", url:abs(v.getAttribute("src")), width:v.videoWidth||undefined, height:v.videoHeight||undefined, pageUrl:location.href});
      v.querySelectorAll("source[src]").forEach(s=> out.push({kind:"video", url:abs(s.getAttribute("src")), pageUrl:location.href}));
    });
    return out;
  });
  addMedia(chunk5.map(dedupeWrap));

  // 6) iframes same-origin
  try {
    const frames = page.frames().filter(f => {
      try { return new URL(f.url()).origin === new URL(page.url()).origin; } catch { return false; }
    });
    for (const f of frames) {
      const chunk = await f.evaluate(() => {
        const out=[]; const abs=(u)=>{ try{return new URL(u, location.href).toString();}catch{return u;} };
        document.querySelectorAll("img").forEach(img=> { if (img.src) out.push({kind:"image", url:abs(img.src), pageUrl:location.href}); });
        document.querySelectorAll("video, video source[src]").forEach(v=>{
          const u = v.getAttribute("src"); if (u) out.push({kind:"video", url:abs(u), pageUrl:location.href});
        });
        return out;
      });
      addMedia(chunk.map(dedupeWrap));
    }
  } catch {}

  ok("extract");

  // 7) dédup finale (les chunks sont déjà “canonisés”)
  run("dedupe");
  ok("dedupe");
  run("done"); ok("done");
}

function dedupeWrap(m) {
  const canon = canonicalUrl(m.url);
  return { ...m, canonical: canon, isDuplicate: m.url!==canon, fileName: m.url.split('/').pop() || undefined };
}

// ---------- Health ----------
app.get("/health", (_req,res)=> res.json({ ok:true, now:new Date().toISOString() }));

// ---------- ZIP multiples ----------
app.post("/api/zip", async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length===0) return res.status(400).json({ error:"Provide urls: string[]" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=media-${Date.now()}.zip`);

  const archive = Archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err)=> res.status(500).end(String(err)));
  archive.pipe(res);

  let i=0;
  for (const u of uniqBy(urls, x=>x)) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const ct = r.headers.get("content-type") || "";
      const ext =
        ct.includes("png") ? "png" :
        ct.includes("webp") ? "webp" :
        ct.includes("gif") ? "gif" :
        ct.includes("mp4") ? "mp4" :
        ct.includes("webm") ? "webm" :
        ct.includes("jpg") || ct.includes("jpeg") ? "jpg" : "bin";
      const name = `media_${String(i++).padStart(4,"0")}.${ext}`;
      archive.append(r.body, { name });
    } catch {}
  }
  archive.finalize();
});

// ---------- Téléchargement unitaire ----------
app.get("/api/file", async (req, res) => {
  const url = req.query.url;
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

// ---------- Start ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, ()=> console.log(`API ok sur http://localhost:${PORT} (GET /health)`));
