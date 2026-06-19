import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SpotifySession, type SessionDeps } from "./session.js";
import { SpotifyApi, base62ToHex, hexToBytes } from "./api.js";
import { readAll } from "./proto.js";
import { Format } from "./types.js";
import type { Logger, FileInfo, DownloadStep, OnProgress } from "./types.js";
import type { ProxyConfig } from "./proxy.js";

const execFileAsync = promisify(execFile);

const HEADER_SIZE = 0xa7;
const AUDIO_EXTS = [".mp3", ".ogg", ".m4a"];

export interface DownloaderDeps {
  api: SpotifyApi;
  fetchFn: typeof globalThis.fetch;
  logger: Logger;
  credentialsPath: string;
  cachePath: string;
  maxCacheSize: number;
  wvdPath: string;
  pythonCmd: string;
  widevineHelperPath: string;
  proxy?: ProxyConfig;
  noEvict?: boolean;
}

export class SpotifyDownloader {
  private session: SpotifySession | null = null;
  private downloading = false;
  private queue: {
    trackId: string;
    onProgress?: OnProgress;
    resolve: (path: string) => void;
    reject: (err: Error) => void;
  }[] = [];
  private lru = new Map<string, number>();
  private deps: DownloaderDeps;

  constructor(deps: DownloaderDeps) {
    this.deps = deps;
  }

  async ensureSession(onProgress?: OnProgress): Promise<SpotifySession> {
    if (this.session?.isConnected()) return this.session;
    onProgress?.("connecting");
    const sessionDeps: SessionDeps = {
      api: this.deps.api,
      fetchFn: this.deps.fetchFn,
      logger: this.deps.logger,
      credentialsPath: this.deps.credentialsPath,
      proxy: this.deps.proxy,
    };
    this.session = new SpotifySession(sessionDeps);
    await this.session.connect();
    return this.session;
  }

  async getTrackAudio(trackId: string, onProgress?: OnProgress): Promise<string> {
    const cached = this.getCachedPath(trackId);
    if (cached) {
      this.lru.set(trackId, Date.now());
      onProgress?.("cached");
      return cached;
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ trackId, onProgress, resolve, reject });
      this.processQueue();
    });
  }

  getCachedPath(trackId: string): string | null {
    for (const ext of AUDIO_EXTS) {
      const filePath = path.join(this.deps.cachePath, `${trackId}${ext}`);
      if (fs.existsSync(filePath)) return filePath;
    }
    return null;
  }

  private async processQueue(): Promise<void> {
    if (this.downloading || this.queue.length === 0) return;
    this.downloading = true;

    const item = this.queue.shift()!;

    try {
      const filePath = await this.downloadTrack(item.trackId, item.onProgress);
      item.resolve(filePath);
    } catch (err) {
      item.reject(err as Error);
    } finally {
      this.downloading = false;
      this.processQueue();
    }
  }

  private async downloadTrack(trackId: string, onProgress?: OnProgress): Promise<string> {
    this.deps.logger.info(`downloading track ${trackId}...`);

    let rawPath: string;
    try {
      rawPath = await this.downloadViaShannonOgg(trackId, onProgress);
    } catch (shannonErr) {
      this.deps.logger.warn(`shannon path failed: ${(shannonErr as Error).message}`);
      rawPath = await this.downloadViaWidevine(trackId, onProgress);
    }

    return await this.convertToMp3(trackId, rawPath, onProgress);
  }

  private async downloadViaShannonOgg(trackId: string, onProgress?: OnProgress): Promise<string> {
    const session = await this.ensureSession(onProgress);
    const hexId = base62ToHex(trackId);
    const requestedGid = hexToBytes(hexId);

    onProgress?.("metadata");
    const metaBuf = await this.deps.api.getTrackMetadata(trackId);
    const fileInfo = this.extractFileInfo(metaBuf);

    if (!fileInfo) {
      throw new Error(`no suitable audio file found for track ${trackId}`);
    }

    const trackGid = fileInfo.trackGid ?? requestedGid;

    this.deps.logger.info(`found file: format=${fileInfo.format}, fileId=${fileInfo.fileId}`);

    onProgress?.("audiokey");
    const fileIdBuf = hexToBytes(fileInfo.fileId);
    const audioKey = await session.requestAudioKey(trackGid, fileIdBuf);

    onProgress?.("cdn");
    const cdnUrl = await this.deps.api.resolveStorageUrl(fileInfo.fileId);

    const res = await this.deps.fetchFn(cdnUrl);
    if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
    const encrypted = Buffer.from(await res.arrayBuffer());

    onProgress?.("decrypting");
    const decrypted = this.decryptAudio(encrypted, audioKey);

    onProgress?.("saving");
    await this.evictIfNeeded(decrypted.length);
    const outPath = path.join(this.deps.cachePath, `${trackId}.ogg`);
    fs.mkdirSync(this.deps.cachePath, { recursive: true });
    fs.writeFileSync(outPath, decrypted.subarray(HEADER_SIZE));

    this.lru.set(trackId, Date.now());
    this.deps.logger.info(`cached track ${trackId} via shannon (${(decrypted.length / 1024 / 1024).toFixed(1)}MB)`);

    return outPath;
  }

  private async downloadViaWidevine(trackId: string, onProgress?: OnProgress): Promise<string> {
    if (!fs.existsSync(this.deps.wvdPath)) {
      throw new Error(
        `widevine device file not found at ${this.deps.wvdPath}. ` +
        "Provide a valid wvdPath in your SpotLib config.",
      );
    }

    onProgress?.("metadata");
    const mp4Files = await this.deps.api.getPlaybackInfo(trackId);
    if (mp4Files.length === 0) {
      throw new Error(`no MP4 audio files available for track ${trackId}`);
    }

    const file = mp4Files.find((f) => f.formatId === "11")
      ?? mp4Files.find((f) => f.formatId === "10")
      ?? mp4Files[0];

    this.deps.logger.info(`widevine: using file ${file.fileId} (format ${file.formatId})`);

    onProgress?.("audiokey");
    const accessToken = await this.deps.api.getAccessToken();
    const clientToken = await this.deps.api.getClientToken();
    const [pyCmd, ...pyArgs] = this.deps.pythonCmd.split(" ");
    const pyEnv = { ...process.env };
    delete pyEnv.SSL_CERT_FILE;
    delete pyEnv.SSL_CERT_DIR;
    const { stdout, stderr } = await execFileAsync(pyCmd, [
      ...pyArgs,
      this.deps.widevineHelperPath,
      file.fileId,
      "--token",
      accessToken,
      "--client-token",
      clientToken,
      "--wvd",
      this.deps.wvdPath,
    ], { timeout: 30_000, env: pyEnv });

    if (stderr) this.deps.logger.warn(`widevine helper stderr: ${stderr}`);

    const keyResult = JSON.parse(stdout.trim()) as { key: string; key_id: string };
    this.deps.logger.info(`widevine: got content key (key_id=${keyResult.key_id})`);

    onProgress?.("cdn");
    const cdnUrl = await this.deps.api.resolveStorageUrlV2(file.fileId, file.formatId);

    const encryptedPath = path.join(this.deps.cachePath, `${trackId}_enc.mp4`);
    const outPath = path.join(this.deps.cachePath, `${trackId}.m4a`);
    fs.mkdirSync(this.deps.cachePath, { recursive: true });

    const res = await this.deps.fetchFn(cdnUrl);
    if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
    const encrypted = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(encryptedPath, encrypted);

    onProgress?.("decrypting");
    try {
      await execFileAsync("ffmpeg", [
        "-loglevel", "error",
        "-hide_banner",
        "-y",
        "-decryption_key", keyResult.key,
        "-i", encryptedPath,
        "-c", "copy",
        outPath,
      ], { timeout: 60_000 });
    } finally {
      try { fs.unlinkSync(encryptedPath); } catch {}
    }

    onProgress?.("saving");
    const stat = fs.statSync(outPath);
    await this.evictIfNeeded(stat.size);

    this.lru.set(trackId, Date.now());
    this.deps.logger.info(`cached track ${trackId} via widevine (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

    return outPath;
  }

  private async convertToMp3(trackId: string, rawPath: string, onProgress?: OnProgress): Promise<string> {
    const mp3Path = path.join(this.deps.cachePath, `${trackId}.mp3`);

    let track;
    try {
      track = await this.deps.api.getTrack(trackId);
    } catch (err) {
      this.deps.logger.warn(`failed to fetch track metadata: ${(err as Error).message}`);
    }

    let coverPath: string | undefined;
    if (track?.albumArt) {
      try {
        const artRes = await this.deps.fetchFn(track.albumArt);
        if (artRes.ok) {
          coverPath = path.join(this.deps.cachePath, `${trackId}_cover.jpg`);
          fs.writeFileSync(coverPath, Buffer.from(await artRes.arrayBuffer()));
        }
      } catch (err) {
        this.deps.logger.warn(`failed to download album art: ${(err as Error).message}`);
      }
    }

    const ffmpegArgs = [
      "-loglevel", "error",
      "-hide_banner",
      "-y",
      "-i", rawPath,
    ];

    if (coverPath) {
      ffmpegArgs.push("-i", coverPath);
      ffmpegArgs.push("-map", "0:a", "-map", "1:0");
      ffmpegArgs.push("-disposition:v:0", "attached_pic");
    }

    ffmpegArgs.push("-c:a", "libmp3lame", "-q:a", "2");
    ffmpegArgs.push("-id3v2_version", "3", "-write_id3v1", "1");

    if (track) {
      ffmpegArgs.push(
        "-metadata", `title=${track.title}`,
        "-metadata", `artist=${track.artist}`,
        "-metadata", `album=${track.album}`,
      );
    }

    ffmpegArgs.push(mp3Path);

    try {
      await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 120_000 });
    } catch (err) {
      this.deps.logger.error(`mp3 conversion failed: ${(err as Error).message}`);
      if (coverPath) try { fs.unlinkSync(coverPath); } catch {}
      return rawPath;
    }

    try { fs.unlinkSync(rawPath); } catch {}
    if (coverPath) try { fs.unlinkSync(coverPath); } catch {}

    this.deps.logger.info(`converted ${trackId} to mp3 with metadata`);
    return mp3Path;
  }

  private extractFileInfo(metaBuf: Buffer): FileInfo | null {
    const fields = readAll(metaBuf);
    const trackGid = fields.get(1)?.[0] as Buffer | undefined;

    const preferred = [
      Format.OGG_VORBIS_320,
      Format.OGG_VORBIS_160,
      Format.OGG_VORBIS_96,
      Format.MP3_320,
      Format.MP3_256,
    ];

    const result = this.pickFile(fields.get(12) ?? [], preferred);
    if (result) {
      return { ...result, trackGid: trackGid instanceof Buffer ? trackGid : undefined };
    }

    const alternatives = fields.get(13) ?? [];
    for (const alt of alternatives) {
      if (!(alt instanceof Buffer)) continue;
      const altFields = readAll(alt);
      const altGid = altFields.get(1)?.[0] as Buffer | undefined;
      const altResult = this.pickFile(altFields.get(12) ?? [], preferred);
      if (altResult) {
        return { ...altResult, trackGid: altGid instanceof Buffer ? altGid : undefined };
      }
    }

    return null;
  }

  private pickFile(
    fileEntries: unknown[],
    preferred: number[],
  ): { fileId: string; format: number } | null {
    for (const pref of preferred) {
      for (const entry of fileEntries) {
        if (!(entry instanceof Buffer)) continue;
        const ef = readAll(entry);
        const fileId = ef.get(1)?.[0] as Buffer | undefined;
        const format = ef.get(2)?.[0] as number | undefined;
        if (fileId && format === pref) {
          return { fileId: fileId.toString("hex"), format };
        }
      }
    }

    for (const entry of fileEntries) {
      if (!(entry instanceof Buffer)) continue;
      const ef = readAll(entry);
      const fileId = ef.get(1)?.[0] as Buffer | undefined;
      const format = ef.get(2)?.[0] as number | undefined;
      if (fileId && format !== undefined) {
        return { fileId: fileId.toString("hex"), format };
      }
    }

    return null;
  }

  private decryptAudio(encrypted: Buffer, audioKey: Buffer): Buffer {
    const AUDIO_AES_IV = Buffer.from("72e067fbddcbcf77ebe8bc643f630d93", "hex");
    const CHUNK_SIZE = 4096;
    const IV_DIFF = 0x100n;
    const parts: Buffer[] = [];
    let ivInt = bigintFromBE(AUDIO_AES_IV);

    for (let i = 0; i < encrypted.length; i += CHUNK_SIZE) {
      const chunk = encrypted.subarray(i, Math.min(i + CHUNK_SIZE, encrypted.length));
      const ivBuf = bigintToBE16(ivInt);
      const decipher = crypto.createDecipheriv("aes-128-ctr", audioKey, ivBuf);
      parts.push(Buffer.concat([decipher.update(chunk), decipher.final()]));
      ivInt += IV_DIFF;
    }

    return Buffer.concat(parts);
  }

  private async evictIfNeeded(incomingSize: number): Promise<void> {
    if (this.deps.noEvict) return;
    if (!fs.existsSync(this.deps.cachePath)) return;

    const files = fs.readdirSync(this.deps.cachePath).filter((f) =>
      AUDIO_EXTS.some((ext) => f.endsWith(ext)),
    );
    let totalSize = files.reduce((sum, f) => {
      try {
        return sum + fs.statSync(path.join(this.deps.cachePath, f)).size;
      } catch {
        return sum;
      }
    }, 0);

    if (totalSize + incomingSize <= this.deps.maxCacheSize) return;

    const sorted = files
      .map((f) => {
        const trackId = f.replace(/\.(mp3|ogg|m4a)$/, "");
        return {
          name: f,
          trackId,
          lastAccess: this.lru.get(trackId) ?? 0,
          size: fs.statSync(path.join(this.deps.cachePath, f)).size,
        };
      })
      .sort((a, b) => a.lastAccess - b.lastAccess);

    for (const file of sorted) {
      if (totalSize + incomingSize <= this.deps.maxCacheSize) break;
      fs.unlinkSync(path.join(this.deps.cachePath, file.name));
      try { fs.unlinkSync(path.join(this.deps.cachePath, `${file.trackId}.meta`)); } catch {}
      this.lru.delete(file.trackId);
      totalSize -= file.size;
      this.deps.logger.info(`evicted cached track: ${file.trackId}`);
    }
  }

  destroy(): void {
    this.session?.destroy();
    this.session = null;
  }
}

function bigintFromBE(buf: Buffer): bigint {
  let result = 0n;
  for (const byte of buf) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function bigintToBE16(n: bigint): Buffer {
  const buf = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}
