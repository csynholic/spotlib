export interface SpotLibConfig {
  /** Spotify sp_dc cookie (required for authentication) */
  spDc: string;

  /** Path to Widevine .wvd device file (required for MP4/AAC fallback) */
  wvdPath: string;

  /** Spotify API client ID (recommended — avoids rate limits on search/metadata) */
  clientId?: string;

  /** Spotify API client secret (required if clientId is set) */
  clientSecret?: string;

  /** HTTP proxy in ip:port:username:password format */
  proxy?: string;

  /** Path to stored credentials JSON file (default: ./spotify_credentials.json) */
  credentialsPath?: string;

  /** Directory for cached audio files (default: ./cache/music) */
  cachePath?: string;

  /** Max cache size in bytes (default: 2GB) */
  maxCacheSize?: number;

  /** Python command for widevine helper (default: python3) */
  pythonCmd?: string;

  /** Custom logger — defaults to console */
  logger?: Logger;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArt: string | null;
  duration: number;
  uri: string;
}

export interface FileInfo {
  fileId: string;
  format: number;
  trackGid?: Buffer;
}

export const Format = {
  OGG_VORBIS_96: 0,
  OGG_VORBIS_160: 1,
  OGG_VORBIS_320: 2,
  MP3_256: 3,
  MP3_320: 4,
  MP3_160: 5,
  MP3_96: 6,
  MP3_160_ENC: 7,
  AAC_24: 8,
  AAC_48: 9,
} as const;

export type DownloadStep =
  | "connecting"
  | "metadata"
  | "audiokey"
  | "cdn"
  | "decrypting"
  | "saving"
  | "cached";

export type OnProgress = (step: DownloadStep) => void;

export interface LyricsLine {
  startTimeMs: string;
  words: string;
}

export interface TrackLyrics {
  syncType: "LINE_SYNCED" | "UNSYNCED";
  lines: LyricsLine[];
}

export interface DownloadOptions {
  onProgress?: OnProgress;
}
