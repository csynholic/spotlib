import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { generateSpotifyTOTP } from "./totp.js";
import { ProtoWriter, readAll } from "./proto.js";
import type { Logger, SpotifyTrack, LyricsLine, TrackLyrics } from "./types.js";

const DESKTOP_CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";

export interface ApiDeps {
  spDc: string;
  spKey?: string;
  clientId?: string;
  clientSecret?: string;
  credentialsPath: string;
  fetchFn: typeof globalThis.fetch;
  logger: Logger;
}

export class SpotifyApi {
  private deps: ApiDeps;

  private cachedOAuthToken: { token: string; expiresAt: number } | null = null;
  private cachedLogin5Token: { token: string; expiresAt: number } | null = null;
  private cachedSpDcToken: { token: string; expiresAt: number } | null = null;
  private cachedWebClientId: string | null = null;
  private cachedClientToken: { token: string; expiresAt: number } | null = null;

  private pendingAccessToken: Promise<string> | null = null;
  private pendingLogin5Token: Promise<string | null> | null = null;
  private pendingClientToken: Promise<string> | null = null;

  constructor(deps: ApiDeps) {
    this.deps = deps;
  }

  private async fetchWithRetry(url: string, init?: RequestInit, maxRetries = 3): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await this.deps.fetchFn(url, init);
      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "");
        const waitMs = (isNaN(retryAfter) ? 2 ** attempt : retryAfter) * 1000;
        this.deps.logger.warn(`429 rate limited on ${new URL(url).pathname}, waiting ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return res;
    }
    throw new Error("unreachable");
  }

  private async getOAuthToken(): Promise<string> {
    if (this.cachedOAuthToken && Date.now() < this.cachedOAuthToken.expiresAt - 60_000) {
      return this.cachedOAuthToken.token;
    }

    const { clientId, clientSecret } = this.deps;
    if (!clientId || !clientSecret) {
      return this.getSpClientToken();
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await this.fetchWithRetry("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) throw new Error(`OAuth token failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };

    this.cachedOAuthToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return this.cachedOAuthToken.token;
  }

  async getLogin5Token(): Promise<string | null> {
    if (this.cachedLogin5Token && Date.now() < this.cachedLogin5Token.expiresAt - 60_000) {
      return this.cachedLogin5Token.token;
    }

    if (this.pendingLogin5Token) return this.pendingLogin5Token;
    this.pendingLogin5Token = this._fetchLogin5Token();
    try {
      return await this.pendingLogin5Token;
    } finally {
      this.pendingLogin5Token = null;
    }
  }

  private async _fetchLogin5Token(): Promise<string | null> {
    let creds: { username: string; type: number; data: string } | null = null;
    try {
      creds = JSON.parse(fs.readFileSync(this.deps.credentialsPath, "utf-8"));
    } catch {
      return null;
    }
    if (!creds?.username || !creds?.data) return null;

    const deviceId = crypto.randomBytes(20).toString("hex");

    const requestBody = new ProtoWriter()
      .writeNested(1, (w) => {
        w.writeString(1, DESKTOP_CLIENT_ID);
        w.writeString(2, deviceId);
      })
      .writeNested(100, (w) => {
        w.writeString(1, creds!.username);
        w.writeBytes(2, Buffer.from(creds!.data, "base64"));
      })
      .build();

    const res = await this.fetchWithRetry("https://login5.spotify.com/v3/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        Accept: "application/x-protobuf",
      },
      body: requestBody,
    });

    if (!res.ok) {
      this.deps.logger.warn(`login5 token request failed: ${res.status}`);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const response = readAll(buf);

    const okBuf = response.get(1)?.[0];
    if (!(okBuf instanceof Buffer)) {
      this.deps.logger.warn(`login5 returned error`);
      return null;
    }

    const ok = readAll(okBuf);
    const accessToken = ok.get(2)?.[0];
    const expiresIn = ok.get(4)?.[0] as number | undefined;

    if (!(accessToken instanceof Buffer)) {
      this.deps.logger.warn("login5: no access token in response");
      return null;
    }

    const token = accessToken.toString("utf-8");
    this.cachedLogin5Token = {
      token,
      expiresAt: Date.now() + (expiresIn ?? 3600) * 1000,
    };
    this.deps.logger.info("obtained access token via login5 (desktop-scoped)");

    return token;
  }

  async getSpClientToken(): Promise<string> {
    const login5Token = await this.getLogin5Token();
    if (login5Token) return login5Token;
    return this.getAccessToken();
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedSpDcToken && Date.now() < this.cachedSpDcToken.expiresAt - 60_000) {
      return this.cachedSpDcToken.token;
    }

    if (this.pendingAccessToken) return this.pendingAccessToken;
    this.pendingAccessToken = this._fetchAccessToken();
    try {
      return await this.pendingAccessToken;
    } finally {
      this.pendingAccessToken = null;
    }
  }

  private async _fetchAccessToken(): Promise<string> {
    const spDc = this.deps.spDc;
    if (!spDc) throw new Error("sp_dc not configured");

    const { totp, totpVer } = await generateSpotifyTOTP(this.deps.fetchFn);
    const params = new URLSearchParams({
      reason: "transport",
      productType: "web-player",
      totp,
      totpServer: totp,
      totpVer,
    });

    const spKey = this.deps.spKey;
    const cookies = spKey ? `sp_dc=${spDc}; sp_key=${spKey}` : `sp_dc=${spDc}`;

    const res = await this.fetchWithRetry(
      `https://open.spotify.com/api/token?${params}`,
      {
        headers: {
          cookie: cookies,
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          accept: "application/json",
        },
      },
    );

    if (!res.ok) throw new Error(`Failed to get access token: ${res.status}`);

    const data = await res.json() as any;

    if (data.isAnonymous) {
      throw new Error(
        "Spotify sp_dc cookie is expired or invalid — got anonymous token. Refresh your sp_dc cookie.",
      );
    }

    this.cachedSpDcToken = {
      token: data.accessToken,
      expiresAt: data.accessTokenExpirationTimestampMs,
    };
    this.cachedWebClientId = data.clientId ?? null;

    return this.cachedSpDcToken.token;
  }

  invalidateTokens(): void {
    this.cachedLogin5Token = null;
    this.cachedSpDcToken = null;
    this.cachedOAuthToken = null;
    this.cachedClientToken = null;
  }

  async getClientToken(): Promise<string> {
    if (this.cachedClientToken && Date.now() < this.cachedClientToken.expiresAt - 60_000) {
      return this.cachedClientToken.token;
    }

    if (this.pendingClientToken) return this.pendingClientToken;
    this.pendingClientToken = this._fetchClientToken();
    try {
      return await this.pendingClientToken;
    } finally {
      this.pendingClientToken = null;
    }
  }

  private async _fetchClientToken(): Promise<string> {
    if (!this.cachedWebClientId) {
      await this.getAccessToken();
    }
    const clientId = this.cachedWebClientId ?? DESKTOP_CLIENT_ID;

    const res = await this.fetchWithRetry(
      "https://clienttoken.spotify.com/v1/clienttoken",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_data: {
            client_version: "1.2.70.61.g856ccd63",
            client_id: clientId,
            js_sdk_data: {},
          },
        }),
      },
    );

    if (!res.ok) throw new Error(`client token failed: ${res.status}`);
    const data = (await res.json()) as any;
    const granted = data.granted_token;

    this.cachedClientToken = {
      token: granted.token,
      expiresAt: Date.now() + (granted.refresh_after_seconds ?? 3600) * 1000,
    };

    return this.cachedClientToken.token;
  }

  private async spotifyApi(path: string): Promise<any> {
    const token = await this.getOAuthToken();
    const res = await this.fetchWithRetry(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Spotify API error: ${res.status} on ${path}`);
    return res.json();
  }

  async searchTrack(query: string): Promise<SpotifyTrack | null> {
    const data = await this.spotifyApi(
      `/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
    );
    const item = data?.tracks?.items?.[0];
    if (!item) return null;
    return parseTrack(item);
  }

  async getTrack(id: string): Promise<SpotifyTrack> {
    const item = await this.spotifyApi(`/tracks/${id}`);
    return parseTrack(item);
  }

  async getTrackMetadata(trackId: string): Promise<Buffer> {
    const token = await this.getSpClientToken();

    const requestBody = new ProtoWriter()
      .writeNested(2, (w) => {
        w.writeString(1, `spotify:track:${trackId}`);
        w.writeNested(2, (q) => {
          q.writeVarint(1, 10);
        });
      })
      .build();

    const res = await this.fetchWithRetry(
      "https://gae2-spclient.spotify.com/extended-metadata/v0/extended-metadata",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-protobuf",
          Accept: "application/x-protobuf",
        },
        body: requestBody,
      },
    );
    if (!res.ok) throw new Error(`extended-metadata failed: ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());

    const resp = readAll(buf);
    const extMetadata = resp.get(2)?.[0] as Buffer;
    if (!extMetadata) throw new Error("No extended metadata in response");

    const arrFields = readAll(extMetadata);
    const extData = arrFields.get(3)?.[0] as Buffer;
    if (!extData) throw new Error("No extension data in response");

    const dataFields = readAll(extData);
    const anyData = dataFields.get(3)?.[0] as Buffer;
    if (!anyData) throw new Error("No Any data in response");

    const anyFields = readAll(anyData);
    const trackProto = anyFields.get(2)?.[0] as Buffer;
    if (!trackProto) throw new Error("No track protobuf in response");

    return trackProto;
  }

  async resolveStorageUrl(fileHexId: string): Promise<string> {
    const token = await this.getSpClientToken();
    const res = await this.fetchWithRetry(
      `https://gae2-spclient.spotify.com/storage-resolve/files/audio/interactive/${fileHexId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/x-protobuf",
        },
      },
    );
    if (!res.ok) throw new Error(`storage-resolve failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const fields = readAll(buf);
    const cdnUrls = fields.get(2);
    if (!cdnUrls || cdnUrls.length === 0) {
      throw new Error("No CDN URLs in storage-resolve response");
    }
    return (cdnUrls[0] as Buffer).toString("utf-8");
  }

  async getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
    const data = await this.spotifyApi(
      `/playlists/${playlistId}/tracks?limit=100&fields=items(track(id,name,artists,album,duration_ms,uri))`,
    );
    return data.items
      .filter((i: any) => i.track)
      .map((i: any) => parseTrack(i.track));
  }

  async getAlbumTracks(albumId: string): Promise<SpotifyTrack[]> {
    const album = await this.spotifyApi(`/albums/${albumId}`);
    return album.tracks.items.map((item: any) => ({
      id: item.id,
      title: item.name,
      artist: item.artists.map((a: any) => a.name).join(", "),
      album: album.name,
      albumArt: album.images?.[0]?.url ?? null,
      duration: item.duration_ms,
      uri: item.uri,
    }));
  }

  async getPlaybackInfo(trackId: string): Promise<{ fileId: string; formatId: string }[]> {
    const token = await this.getSpClientToken();
    const res = await this.fetchWithRetry(
      `https://gue1-spclient.spotify.com/track-playback/v1/media/spotify:track:${trackId}?manifestFileFormat=file_ids_mp4`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "app-platform": "WebPlayer",
        },
      },
    );
    if (!res.ok) throw new Error(`playback-info failed: ${res.status}`);
    const data = (await res.json()) as any;

    const mediaKey = Object.keys(data.media || {})[0];
    if (!mediaKey) throw new Error("no media in playback info");

    const item = data.media[mediaKey].item;
    const files: { fileId: string; formatId: string }[] = [];

    for (const f of item?.manifest?.file_ids_mp4 ?? []) {
      if (f.file_id && f.format) {
        files.push({ fileId: f.file_id, formatId: f.format });
      }
    }

    return files;
  }

  async resolveStorageUrlV2(fileId: string, formatId = "11"): Promise<string> {
    const token = await this.getSpClientToken();
    const res = await this.fetchWithRetry(
      `https://gue1-spclient.spotify.com/storage-resolve/v2/files/audio/interactive/${formatId}/${fileId}?version=10000000&product=9&platform=39&alt=json`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) throw new Error(`storage-resolve v2 failed: ${res.status}`);
    const data = (await res.json()) as any;
    const urls = data.cdnurl;
    if (!urls || urls.length === 0) {
      throw new Error("no CDN URLs in storage-resolve v2 response");
    }
    return urls[0];
  }

  async getTrackLyrics(trackId: string): Promise<TrackLyrics | null> {
    const accessToken = await this.getAccessToken();
    const clientToken = await this.getClientToken();
    const res = await this.fetchWithRetry(
      `https://gue1-spclient.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "client-token": clientToken,
          "app-platform": "WebPlayer",
          "spotify-app-version": "1.2.70.61.g856ccd63",
          Accept: "application/json",
          Origin: "https://open.spotify.com",
          Referer: "https://open.spotify.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        },
      },
    );
    if (!res.ok) {
      this.deps.logger.warn(`lyrics API returned ${res.status} for track ${trackId}`);
      return null;
    }
    const data = (await res.json()) as any;
    const lyrics = data.lyrics;
    if (!lyrics?.lines?.length) return null;
    return {
      syncType: lyrics.syncType,
      lines: lyrics.lines.map((l: any) => ({ startTimeMs: l.startTimeMs, words: l.words })),
    };
  }
}

function parseTrack(item: any): SpotifyTrack {
  return {
    id: item.id,
    title: item.name,
    artist: item.artists.map((a: any) => a.name).join(", "),
    album: item.album.name,
    albumArt: item.album.images?.[0]?.url ?? null,
    duration: item.duration_ms,
    uri: item.uri,
  };
}

export function parseSpotifyInput(
  input: string,
): { type: "track" | "playlist" | "album"; id: string } | null {
  const uriMatch = input.match(/^spotify:(track|playlist|album):([a-zA-Z0-9]+)$/);
  if (uriMatch) return { type: uriMatch[1] as any, id: uriMatch[2] };

  const urlMatch = input.match(/open\.spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
  if (urlMatch) return { type: urlMatch[1] as any, id: urlMatch[2] };

  return null;
}

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function base62ToHex(b62: string): string {
  let n = 0n;
  for (const c of b62) {
    const idx = BASE62.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base62 char: ${c}`);
    n = n * 62n + BigInt(idx);
  }
  return n.toString(16).padStart(32, "0");
}

export function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}
