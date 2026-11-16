import http from "node:http";
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { SpotLib } from "./dist/index.js";
import { SpotifySession } from "./dist/session.js";
import { SpotifyApi, base62ToHex } from "./dist/api.js";
import { ProtoWriter, readAll } from "./dist/proto.js";
import { generateSpotifyTOTP, fetchSpotifyTotpSecret, computeTotp } from "./dist/totp.js";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dir, ".env") });

const noMusicCache = ["1", "true", "yes"].includes((process.env.NO_MUSIC_CACHE ?? "").toLowerCase());
const noEvict = ["1", "true", "yes"].includes((process.env.NO_EVICT ?? "").toLowerCase());

const spot = new SpotLib({
  spDc: process.env.SP_DC,
  wvdPath: process.env.WVD_PATH || "./device.wvd",
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  cachePath: noMusicCache ? join(__dir, "cache", "presence") : undefined,
  maxCacheSize: Infinity,
  noEvict,
});

const PORT = Number(process.env.PORT || 8888);
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.API_KEY || "";
if (!API_KEY) throw new Error("API_KEY not set in .env");
const TRUSTED = new Set((process.env.TRUSTED_PROXIES || "127.0.0.1,::1,::ffff:127.0.0.1").split(",").map((x) => x.trim()));
const CACHE_TTL = 90 * 24 * 3600;
const PRESENCE_DIR = join(__dir, "cache", "presence");
const MUSIC_DIR = join(__dir, "cache", "music");
fs.mkdirSync(PRESENCE_DIR, { recursive: true });

// ── check session (separate from download session, used only for audio key probes) ──

const CRED_PATH = join(__dir, "spotify_credentials.json");
const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {} };

const checkApi = new SpotifyApi({
  spDc: process.env.SP_DC,
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  credentialsPath: CRED_PATH,
  fetchFn: globalThis.fetch,
  logger: SILENT_LOG,
});

let checkSession = null;
let checkConnecting = null;

async function getCheckSession() {
  if (checkSession?.isConnected()) return checkSession;
  if (!checkConnecting) {
    checkConnecting = (async () => {
      const session = new SpotifySession({
        api: checkApi,
        fetchFn: globalThis.fetch,
        logger: SILENT_LOG,
        credentialsPath: CRED_PATH,
      });
      await session.connect();
      checkSession = session;
      checkConnecting = null;
      return session;
    })().catch((err) => {
      checkSession = null;
      checkConnecting = null;
      throw err;
    });
  }
  return checkConnecting;
}

// preferred formats (OGG first, then MP3) — all via Shannon path
const PREFERRED_FORMATS = [2, 1, 0, 4, 3, 5, 6, 7]; // OGG 320/160/96, MP3 320/256/160/96/160enc

async function getTrackProto(trackId) {
  // Reuse the same extended-metadata fetch as before
  const token = await checkApi.getAccessToken();
  const requestBody = new ProtoWriter()
    .writeNested(2, (w) => {
      w.writeString(1, `spotify:track:${trackId}`);
      w.writeNested(2, (q) => { q.writeVarint(1, 10); });
    })
    .build();

  const res = await fetch(
    "https://gae2-spclient.spotify.com/extended-metadata/v0/extended-metadata",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-protobuf",
        Accept: "application/x-protobuf",
      },
      body: requestBody,
    }
  );
  if (!res.ok) throw new Error(`metadata ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const resp = readAll(buf);
  const ext = resp.get(2)?.[0];
  const extData = readAll(ext).get(3)?.[0];
  const anyData = readAll(extData).get(3)?.[0];
  const trackProto = readAll(anyData).get(2)?.[0];
  return trackProto; // raw Buffer
}

function pickFile(fileEntries) {
  for (const pref of PREFERRED_FORMATS) {
    for (const e of fileEntries) {
      if (!(e instanceof Buffer)) continue;
      const ef = readAll(e);
      const fileId = ef.get(1)?.[0];
      const fmt = ef.get(2)?.[0];
      if (fileId instanceof Buffer && fmt === pref) return fileId;
    }
  }
  return null;
}

async function canDownloadViaShanon(trackId) {
  try {
    const trackProto = await getTrackProto(trackId);
    if (!(trackProto instanceof Buffer)) return false;

    const fields = readAll(trackProto);

    // get track GID (needed for audio key request)
    const rawGid = fields.get(1)?.[0];
    let trackGid = rawGid instanceof Buffer ? rawGid : Buffer.from(base62ToHex(trackId), "hex");

    // find a file with a Shannon-compatible format
    let fileId = pickFile(fields.get(12) ?? []);

    if (!fileId) {
      for (const alt of fields.get(13) ?? []) {
        if (!(alt instanceof Buffer)) continue;
        const altFields = readAll(alt);
        fileId = pickFile(altFields.get(12) ?? []);
        if (fileId) {
          const altGid = altFields.get(1)?.[0];
          if (altGid instanceof Buffer) trackGid = altGid;
          break;
        }
      }
    }

    if (!fileId) return false; // no OGG/MP3 files at all

    // actually attempt the audio key — this is what fails for Widevine tracks
    const session = await getCheckSession();
    await session.requestAudioKey(trackGid, fileId);
    return true; // key granted → Shannon works
  } catch (err) {
    // reset session on socket errors so next call reconnects
    if (err.code === "ECONNRESET" || err.message?.includes("ECONNRESET") || err.message?.includes("timed out")) {
      checkSession = null;
      checkConnecting = null;
    }
    return false; // key denied (Widevine) or network error
  }
}

// ── Canvas ────────────────────────────────────────────────────────────────────

const CANVAS_UA = "Spotify/9.0.34.593 iOS/18.4 (iPhone15,3)";
let canvasTokenCache = null; // { token, expiresAt }

async function getCanvasToken() {
  if (canvasTokenCache && Date.now() < canvasTokenCache.expiresAt - 60_000) {
    return canvasTokenCache.token;
  }

  const spDc = process.env.SP_DC;
  const { secret, ver } = await fetchSpotifyTotpSecret();

  let serverMs = Date.now();
  try {
    const r = await fetch("https://open.spotify.com/api/server-time", {
      headers: { "User-Agent": CANVAS_UA, "Cookie": `sp_dc=${spDc}` },
    });
    if (r.ok) serverMs = (await r.json()).serverTime * 1000;
  } catch {}

  // Mirror Canvas API auth service (OTPAuth.TOTP.generate({ timestamp: t_ms })):
  //   totp       → counter = nowMs // 30_000  (standard 30s TOTP)
  //   totpServer → counter = (serverMs // 30) // 30_000  (~900s period)
  const totp = computeTotp(secret, Math.floor(Date.now() / 30_000));
  const totpServer = computeTotp(secret, Math.floor(Math.floor(serverMs / 30) / 30_000));

  const params = new URLSearchParams({
    reason: "init",
    productType: "mobile-web-player",
    totp,
    totpVer: ver,
    totpServer,
  });

  const r = await fetch(`https://open.spotify.com/api/token?${params}`, {
    headers: {
      "User-Agent": CANVAS_UA,
      "Origin": "https://open.spotify.com/",
      "Referer": "https://open.spotify.com/",
      "Cookie": `sp_dc=${spDc}`,
    },
  });
  if (!r.ok) throw new Error(`canvas token ${r.status}`);

  const data = await r.json();
  canvasTokenCache = {
    token: data.accessToken,
    expiresAt: data.accessTokenExpirationTimestampMs || Date.now() + 3_600_000,
  };
  return canvasTokenCache.token;
}

function parseCanvasResponse(buf) {
  const outer = readAll(buf);
  return (outer.get(1) ?? []).map((cb) => {
    const cf = readAll(cb);
    const artistBuf = cf.get(6)?.[0];
    const af = artistBuf ? readAll(artistBuf) : new Map();
    const str = (f, n) => f.get(n)?.[0]?.toString?.() ?? "";
    return {
      id: str(cf, 1),
      canvas_url: str(cf, 2),
      track_uri: str(cf, 5),
      artist: {
        artist_uri: str(af, 1),
        artist_name: str(af, 2),
        artist_img_url: str(af, 3),
      },
      other_id: str(cf, 9),
      canvas_uri: str(cf, 11),
    };
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9]{22}$/;
const MAX_BODY = 4096;

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function normId(raw) {
  let id = String(raw ?? "");
  for (const prefix of ["open.spotify.com/track/", "spotify:track:"]) {
    if (id.includes(prefix)) {
      id = id.split(prefix).pop().split("?")[0];
      break;
    }
  }
  id = id.trim();
  if (!ID_RE.test(id)) throw new HttpError(400, "invalid track id");
  return id;
}

function clientIp(req) {
  const peer = req.socket.remoteAddress || "";
  if (TRUSTED.has(peer)) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",").pop().trim();
  }
  return peer;
}

const isLocal = (ip) => ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(ip);

function requireKey(req, ip) {
  if (isLocal(ip)) return;
  const given = Buffer.from(String(req.headers["x-api-key"] ?? ""));
  const want = Buffer.from(API_KEY);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new HttpError(401, "invalid or missing API key");
  }
}

const buckets = new Map();

function rateLimit(ip, name, max) {
  if (isLocal(ip)) return;
  const key = `${name}:${ip}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.reset) {
    b = { count: 0, reset: now + 60_000 };
    buckets.set(key, b);
  }
  if (++b.count > max) throw new HttpError(429, `Rate limit exceeded: ${max} per 1 minute`);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}, 60_000).unref();

const presencePath = (id) => join(PRESENCE_DIR, `${id}.mp3`);
const metaPath = (id) => join(PRESENCE_DIR, `${id}.meta`);

function readExpiresAt(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf8")).expires_at;
  } catch {
    try {
      return fs.statSync(presencePath(id)).mtimeMs / 1000 + CACHE_TTL;
    } catch {
      return null;
    }
  }
}

function cacheGet(id) {
  const p = presencePath(id);
  if (!fs.existsSync(p)) return null;
  const exp = readExpiresAt(id);
  if (exp === null || Date.now() / 1000 > exp) {
    if (!noEvict) {
      fs.rmSync(p, { force: true });
      fs.rmSync(metaPath(id), { force: true });
    }
    return null;
  }
  return p;
}

async function cachePut(id, src, ttl) {
  const dst = presencePath(id);
  let expires = Date.now() / 1000 + ttl;
  const existing = readExpiresAt(id);
  if (existing !== null) expires = Math.max(existing, expires);
  if (src !== dst) await fs.promises.copyFile(src, dst);
  const now = new Date();
  await fs.promises.utimes(dst, now, now);
  await fs.promises.writeFile(metaPath(id), JSON.stringify({ expires_at: expires }));
  return expires;
}

function purgeExpired() {
  if (noEvict) return;
  const now = Date.now() / 1000;
  for (const f of fs.readdirSync(PRESENCE_DIR)) {
    const id = f.slice(0, -4);
    if (f.endsWith(".mp3")) {
      const exp = readExpiresAt(id);
      if (exp === null || now > exp) {
        fs.rmSync(join(PRESENCE_DIR, f), { force: true });
        fs.rmSync(metaPath(id), { force: true });
        for (const ext of [".mp3", ".ogg", ".m4a"]) fs.rmSync(join(MUSIC_DIR, `${id}${ext}`), { force: true });
        console.log(`[spotlib] evicted ${id}`);
      }
    } else if (f.endsWith(".meta") && !fs.existsSync(presencePath(id))) {
      fs.rmSync(join(PRESENCE_DIR, f), { force: true });
    }
  }
}

purgeExpired();
setInterval(() => { try { purgeExpired(); } catch {} }, 3_600_000).unref();

const inflight = new Map();

function downloadOnce(id) {
  let p = inflight.get(id);
  if (!p) {
    p = (async () => {
      const steps = [];
      const path = await spot.download(id, { onProgress: (s) => steps.push(s) });
      if (!path || !fs.existsSync(path)) throw new HttpError(500, "download succeeded but file missing");
      return { path, steps };
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

function parseTtl(v) {
  if (v === undefined || v === null || v === "") return CACHE_TTL;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 10 * 365 * 24 * 3600) throw new HttpError(400, "invalid ttl");
  return Math.floor(n);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendMp3(req, res, file, id) {
  const stat = fs.statSync(file);
  const headers = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `attachment; filename="${id}.mp3"`,
    "Last-Modified": stat.mtime.toUTCString(),
  };
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), end);
    } else {
      start = Math.max(0, stat.size - Number(m[2]));
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["Content-Length"] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
}

async function handleDownload(req, res, ip, id, ttl, mode) {
  let steps;
  let cached = true;
  let p = cacheGet(id);
  if (!p) {
    cached = false;
    const data = await downloadOnce(id);
    steps = data.steps;
    p = data.path;
  }
  const expires = await cachePut(id, p, ttl);
  if (mode === "file") return sendMp3(req, res, presencePath(id), id);
  const out = { ok: true, id, cached, cached_until: expires };
  if (!cached) out.steps = steps;
  return json(res, out);
}

const server = http.createServer(async (req, res) => {
  try {
    const ip = clientIp(req);
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const [route, arg] = parts;
    const get = req.method === "GET" || req.method === "HEAD";

    if (get && route === "health" && !arg) return json(res, { status: "ok" });

    if (get && route === "track" && arg && parts.length === 2) {
      rateLimit(ip, "track", 60);
      const p = cacheGet(normId(arg));
      if (!p) throw new HttpError(404, "not cached");
      return sendMp3(req, res, p, arg);
    }

    if (req.method === "POST" && route === "download" && parts.length === 1) {
      requireKey(req, ip);
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "invalid json");
      }
      if (typeof body?.input !== "string") throw new HttpError(400, "missing input");
      return handleDownload(req, res, ip, normId(body.input), parseTtl(body.ttl), "json");
    }

    if (get && route === "download" && arg && parts.length === 2) {
      requireKey(req, ip);
      return handleDownload(req, res, ip, normId(arg), parseTtl(url.searchParams.get("ttl")), "file");
    }

    if (get && route === "lyrics" && arg && parts.length === 2) {
      requireKey(req, ip);
      const lyrics = await spot.getLyrics(normId(arg));
      if (lyrics == null) throw new HttpError(404, "no lyrics available");
      return json(res, lyrics);
    }

    if (get && route === "check" && arg && parts.length === 2) {
      rateLimit(ip, "check", 30);
      const id = normId(arg);
      if (cacheGet(id)) return json(res, { cached: true, downloadable: true });
      const downloadable = await canDownloadViaShanon(id);
      return json(res, { cached: false, downloadable });
    }

    if (get && route === "canvas" && arg && parts.length === 2) {
      requireKey(req, ip);
      rateLimit(ip, "canvas", 300);
      const id = normId(arg);
      const token = await getCanvasToken();
      const body = new ProtoWriter()
        .writeNested(1, (w) => w.writeString(1, `spotify:track:${id}`))
        .build();
      const r = await fetch("https://spclient.wg.spotify.com/canvaz-cache/v0/canvases", {
        method: "POST",
        headers: {
          Accept: "application/protobuf",
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept-Language": "en",
          "User-Agent": CANVAS_UA,
          Authorization: `Bearer ${token}`,
        },
        body,
      });
      if (r.status === 401) {
        canvasTokenCache = null;
        throw new HttpError(502, "canvas token expired");
      }
      if (!r.ok) throw new HttpError(502, `canvas ${r.status}`);
      const canvases = parseCanvasResponse(Buffer.from(await r.arrayBuffer()));
      return json(res, { canvases });
    }

    throw new HttpError(404, "Not Found");
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return json(res, { detail: err.message }, err.status);
    console.error("[spotlib] error:", err.message);
    json(res, { detail: "internal error" }, 500);
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 300_000;

server.listen(PORT, HOST, () => {
  console.log(`spotlib listening on ${HOST}:${PORT}`);
});

const shutdown = () => { spot.destroy(); checkSession?.destroy(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("uncaughtException", (err) => {
  console.error("[spotlib] uncaughtException:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[spotlib] unhandledRejection:", reason);
});
