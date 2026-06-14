import http from "node:http";
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

const spot = new SpotLib({
  spDc: process.env.SP_DC,
  wvdPath: process.env.WVD_PATH || "./device.wvd",
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  cachePath: noMusicCache ? join(__dir, "cache", "presence") : undefined,
  maxCacheSize: Infinity,
});

const PORT = process.env.NODE_PORT || 7331;

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

// ── helpers ──────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (req.method === "GET" && parts[0] === "health") {
      return json(res, { ok: true });
    }

    if (req.method === "GET" && parts[0] === "track" && parts[1]) {
      const track = await spot.getTrack(parts[1]);
      return json(res, track);
    }

    if (req.method === "POST" && parts[0] === "download") {
      const body = await readBody(req);
      const { input } = JSON.parse(body);
      if (!input) return json(res, { error: "missing input" }, 400);
      const steps = [];
      const mp3Path = await spot.download(input, {
        onProgress: (step) => steps.push(step),
      });
      return json(res, { path: mp3Path, steps });
    }

    // GET /lyrics/:id
    if (req.method === "GET" && parts[0] === "lyrics" && parts[1]) {
      const lyrics = await spot.getLyrics(parts[1]);
      return json(res, lyrics);
    }

    // GET /canvas/:id — fetch Spotify Canvas looping video(s) for a track
    if (req.method === "GET" && parts[0] === "canvas" && parts[1]) {
      const token = await getCanvasToken();
      const body = new ProtoWriter()
        .writeNested(1, (w) => w.writeString(1, `spotify:track:${parts[1]}`))
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
        throw new Error("canvas token expired");
      }
      if (!r.ok) throw new Error(`canvas ${r.status}`);
      const canvases = parseCanvasResponse(Buffer.from(await r.arrayBuffer()));
      return json(res, { canvases });
    }

    // GET /check/:id — checks audio key availability without downloading
    if (req.method === "GET" && parts[0] === "check" && parts[1]) {
      const cachedPath = spot.getCachedPath(parts[1]);
      if (cachedPath) return json(res, { downloadable: true, cached: true });
      const downloadable = await canDownloadViaShanon(parts[1]);
      return json(res, { downloadable, cached: false });
    }

    json(res, { error: "not found" }, 404);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`spotlib node server on :${PORT}`);
});

process.on("SIGTERM", () => { spot.destroy(); checkSession?.destroy(); process.exit(0); });
process.on("SIGINT",  () => { spot.destroy(); checkSession?.destroy(); process.exit(0); });

process.on("uncaughtException", (err) => {
  console.error("[spotlib-node] uncaughtException:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[spotlib-node] unhandledRejection:", reason);
});
