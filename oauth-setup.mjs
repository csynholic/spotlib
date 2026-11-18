import http from "node:http";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dir, ".env") });

const id = process.env.SPOTIFY_CLIENT_ID;
const secret = process.env.SPOTIFY_CLIENT_SECRET;
if (!id || !secret) throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing in .env");

const REDIRECT = "http://127.0.0.1:8898/callback";
const state = randomBytes(16).toString("hex");
const url = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
  client_id: id,
  response_type: "code",
  redirect_uri: REDIRECT,
  scope: "user-read-currently-playing user-read-playback-state",
  state,
});

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1:8898");
  if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
  if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) {
    res.writeHead(400).end("bad state or missing code");
    return;
  }
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: REDIRECT }),
  });
  const d = await r.json();
  if (!r.ok || !d.refresh_token) {
    res.writeHead(500).end("token exchange failed: " + JSON.stringify(d));
    console.error("failed:", d);
  } else {
    fs.writeFileSync(join(__dir, "spotify_oauth.json"), JSON.stringify({ refresh_token: d.refresh_token }), { mode: 0o600 });
    res.writeHead(200).end("Done. You can close this tab.");
    console.log("saved spotify_oauth.json");
  }
  srv.close();
});
srv.listen(8898, "127.0.0.1", () => console.log("Open this URL and approve:\n\n" + url + "\n"));
