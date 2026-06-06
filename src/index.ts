import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SpotifyApi, parseSpotifyInput } from "./api.js";
import { SpotifyDownloader } from "./downloader.js";
import { parseProxy, createProxyFetch } from "./proxy.js";
import type { ProxyConfig } from "./proxy.js";
import type {
  SpotLibConfig,
  Logger,
  SpotifyTrack,
  DownloadOptions,
  TrackLyrics,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type {
  SpotLibConfig,
  SpotifyTrack,
  DownloadOptions,
  TrackLyrics,
  Logger,
  OnProgress,
  DownloadStep,
  LyricsLine,
} from "./types.js";
export { parseSpotifyInput } from "./api.js";
export { Format } from "./types.js";

const defaultLogger: Logger = {
  info: (msg) => console.log(`[spotlib] ${msg}`),
  warn: (msg) => console.warn(`[spotlib] ${msg}`),
  error: (msg, ...args) => console.error(`[spotlib] ${msg}`, ...args),
};

export class SpotLib {
  private api: SpotifyApi;
  private downloader: SpotifyDownloader;
  private logger: Logger;

  constructor(config: SpotLibConfig) {
    this.logger = config.logger ?? defaultLogger;

    let proxyConfig: ProxyConfig | undefined;
    let fetchFn: typeof globalThis.fetch = globalThis.fetch;

    if (config.proxy) {
      proxyConfig = parseProxy(config.proxy);
      fetchFn = createProxyFetch(proxyConfig);
    }

    const credentialsPath = config.credentialsPath ?? path.resolve("spotify_credentials.json");
    const cachePath = config.cachePath ?? path.resolve("cache", "music");
    const maxCacheSize = config.maxCacheSize ?? 2 * 1024 * 1024 * 1024;
    const pythonCmd = config.pythonCmd ?? "python3";
    const widevineHelperPath = path.resolve(__dirname, "..", "widevine-helper.py");

    this.api = new SpotifyApi({
      spDc: config.spDc,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      credentialsPath,
      fetchFn,
      logger: this.logger,
    });

    this.downloader = new SpotifyDownloader({
      api: this.api,
      fetchFn,
      logger: this.logger,
      credentialsPath,
      cachePath,
      maxCacheSize,
      wvdPath: config.wvdPath,
      pythonCmd,
      widevineHelperPath,
      proxy: proxyConfig,
    });
  }

  /** Download a track by Spotify URL, URI, or track ID. Returns path to audio file. */
  async download(input: string, opts?: DownloadOptions): Promise<string> {
    const trackId = this.resolveTrackId(input);
    return this.downloader.getTrackAudio(trackId, opts?.onProgress);
  }

  /** Search for a track by query string */
  async search(query: string): Promise<SpotifyTrack | null> {
    return this.api.searchTrack(query);
  }

  /** Get track metadata by ID */
  async getTrack(id: string): Promise<SpotifyTrack> {
    return this.api.getTrack(id);
  }

  /** Get synced lyrics for a track */
  async getLyrics(trackId: string): Promise<TrackLyrics | null> {
    return this.api.getTrackLyrics(trackId);
  }

  /** Get all tracks in a playlist */
  async getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
    return this.api.getPlaylistTracks(playlistId);
  }

  /** Get all tracks in an album */
  async getAlbumTracks(albumId: string): Promise<SpotifyTrack[]> {
    return this.api.getAlbumTracks(albumId);
  }

  /** Invalidate all cached tokens */
  invalidateTokens(): void {
    this.api.invalidateTokens();
  }

  /** Clean up resources (close session, etc.) */
  destroy(): void {
    this.downloader.destroy();
  }

  private resolveTrackId(input: string): string {
    const parsed = parseSpotifyInput(input);
    if (parsed) {
      if (parsed.type !== "track") {
        throw new Error(`Expected a track, got ${parsed.type}. Use getPlaylistTracks() or getAlbumTracks() for collections.`);
      }
      return parsed.id;
    }
    return input;
  }
}
