import * as net from "node:net";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { Shannon } from "./shannon.js";
import { ProtoWriter, readAll } from "./proto.js";
import type { SpotifyApi } from "./api.js";
import type { Logger } from "./types.js";
import type { ProxyConfig } from "./proxy.js";
import { connectTcpProxy } from "./proxy.js";

const CMD_PING = 0x04;
const CMD_PONG = 0x49;
const CMD_LOGIN = 0xab;
const CMD_AUTH_SUCCESS = 0xac;
const CMD_AUTH_FAILURE = 0xad;
const CMD_AES_KEY = 0x0d;
const CMD_AES_KEY_ERROR = 0x0e;
const CMD_REQUEST_KEY = 0x0c;
const CMD_COUNTRY_CODE = 0x1b;
const CMD_PRODUCT_INFO = 0x50;

const MAC_SIZE = 4;

const DH_PRIME = BigInt(
  "0x" +
    "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74" +
    "020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f1437" +
    "4fe1356d6d51c245e485b576625e7ec6f44c42e9a63a3620ffffffffffffffff",
);
const DH_GENERATOR = 2n;

interface PendingRead {
  resolve: (pkt: { cmd: number; payload: Buffer }) => void;
  reject: (err: Error) => void;
}

const DEVICE_ID = crypto.randomBytes(20).toString("hex");

export interface SessionDeps {
  api: SpotifyApi;
  fetchFn: typeof globalThis.fetch;
  logger: Logger;
  credentialsPath: string;
  proxy?: ProxyConfig;
}

let storedCredentials: {
  username: string;
  type: number;
  data: Buffer;
} | null = null;

function loadStoredCredentials(credPath: string, logger: Logger): typeof storedCredentials {
  if (storedCredentials) return storedCredentials;
  try {
    const raw = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    if (raw.username && raw.data && raw.type !== undefined) {
      storedCredentials = {
        username: raw.username,
        type: raw.type,
        data: Buffer.from(raw.data, "base64"),
      };
      logger.info(`loaded spotify credentials for ${raw.username}`);
      return storedCredentials;
    }
  } catch {
    // file doesn't exist or is invalid
  }
  return null;
}

export class SpotifySession extends EventEmitter {
  private socket: net.Socket | null = null;
  private sendCipher: Shannon | null = null;
  private recvCipher: Shannon | null = null;
  private sendNonce = 0;
  private recvNonce = 0;
  private connected = false;
  private keyCallbacks = new Map<
    number,
    { resolve: (key: Buffer) => void; reject: (err: Error) => void }
  >();
  private keySeq = 0;
  private readBuffer = Buffer.alloc(0);
  private pendingReads: PendingRead[] = [];
  private backgroundReading = false;

  private oauthToken: string | null = null;
  private deps: SessionDeps;

  constructor(deps: SessionDeps) {
    super();
    this.deps = deps;
  }

  async connect(opts?: { oauthToken?: string }): Promise<void> {
    if (opts?.oauthToken) this.oauthToken = opts.oauthToken;

    const apRes = await this.deps.fetchFn(
      "https://apresolve.spotify.com/?type=accesspoint",
    );
    const apData = (await apRes.json()) as { accesspoint: string[] };
    const ap =
      apData.accesspoint.find((a) => a.endsWith(":443")) ??
      apData.accesspoint[0];
    const [host, portStr] = ap.split(":");
    const port = parseInt(portStr);

    this.deps.logger.info(`connecting to spotify AP: ${host}:${port}`);

    this.socket = await this.connectTcp(host, port);

    this.socket.on("error", (err) => {
      this.deps.logger.error("spotify session socket error:", err);
      this.emit("error", err);
    });

    this.socket.on("close", () => {
      this.connected = false;
      this.emit("close");
    });

    this.socket.on("data", (chunk) => {
      this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
      this.tryProcessReads();
    });

    await this.handshake();
    await this.login();

    this.connected = true;
    this.deps.logger.info("spotify session authenticated");
    this.startBackgroundReader();
  }

  private connectTcp(host: string, port: number): Promise<net.Socket> {
    if (this.deps.proxy) {
      return connectTcpProxy(host, port, this.deps.proxy);
    }
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port }, () => resolve(sock));
      sock.once("error", reject);
    });
  }

  private async handshake(): Promise<void> {
    const privateKeyBytes = crypto.randomBytes(0x5f);
    const privateKey = bigintFromBytes(privateKeyBytes);
    const publicKey = modPow(DH_GENERATOR, privateKey, DH_PRIME);
    const publicKeyBytes = bigintToBytes(publicKey);

    const clientNonce = crypto.randomBytes(16);

    const clientHello = new ProtoWriter()
      .writeNested(10, (w) => {
        w.writeVarint(10, 0);
        w.writeVarint(20, 0);
        w.writeVarint(30, 16);
        w.writeVarint(40, 117300517);
      })
      .writeVarint(30, 0)
      .writeNested(50, (w) => {
        w.writeNested(10, (w2) => {
          w2.writeBytes(10, publicKeyBytes);
          w2.writeVarint(20, 1);
        });
      })
      .writeBytes(60, clientNonce)
      .writeBytes(70, Buffer.from([0x1e]))
      .build();

    const accumulator: Buffer[] = [];

    const magic = Buffer.from([0x00, 0x04]);
    const sizeValue = 2 + 4 + clientHello.length;
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(sizeValue, 0);
    const helloPacket = Buffer.concat([magic, sizeBuf, clientHello]);

    this.socketWrite(helloPacket);
    accumulator.push(helloPacket);

    const apLengthBuf = await this.readExact(4);
    const apLength = apLengthBuf.readUInt32BE(0);
    const apPayload = await this.readExact(apLength - 4);

    accumulator.push(apLengthBuf);
    accumulator.push(apPayload);

    const apFields = readAll(apPayload);
    const challengeBuf = apFields.get(10)?.[0] as Buffer;
    const challengeFields = readAll(challengeBuf);
    const cryptoChallenge = readAll(challengeFields.get(10)?.[0] as Buffer);
    const dhChallenge = readAll(cryptoChallenge.get(10)?.[0] as Buffer);
    const serverPublicBytes = dhChallenge.get(10)?.[0] as Buffer;

    const serverPublic = bigintFromBytes(serverPublicBytes);
    const sharedSecret = modPow(serverPublic, privateKey, DH_PRIME);
    const sharedSecretBytes = bigintToBytes(sharedSecret);

    const accBuf = Buffer.concat(accumulator);

    const hmacOutputs: Buffer[] = [];
    for (let i = 1; i <= 5; i++) {
      const mac = crypto.createHmac("sha1", sharedSecretBytes);
      mac.update(accBuf);
      mac.update(Buffer.from([i]));
      hmacOutputs.push(mac.digest());
    }
    const keyBlock = Buffer.concat(hmacOutputs);

    const challengeKey = keyBlock.subarray(0, 0x14);
    const challengeMac = crypto.createHmac("sha1", challengeKey);
    challengeMac.update(accBuf);
    const challenge = challengeMac.digest();

    const sendKeyRaw = keyBlock.subarray(0x14, 0x34);
    const recvKeyRaw = keyBlock.subarray(0x34, 0x54);

    const clientResponse = new ProtoWriter()
      .writeNested(10, (w) => {
        w.writeNested(10, (w2) => {
          w2.writeBytes(10, challenge);
        });
      })
      .writeNested(20, () => {})
      .writeNested(30, () => {})
      .build();

    const respSizeBuf = Buffer.alloc(4);
    respSizeBuf.writeUInt32BE(4 + clientResponse.length, 0);
    this.socketWrite(Buffer.concat([respSizeBuf, clientResponse]));

    const failed = await this.checkForFailure();
    if (failed) {
      throw new Error("AP handshake rejected");
    }

    this.sendCipher = new Shannon();
    this.sendCipher.key(sendKeyRaw);
    this.recvCipher = new Shannon();
    this.recvCipher.key(recvKeyRaw);
    this.sendNonce = 0;
    this.recvNonce = 0;
  }

  private socketWrite(data: Buffer): void {
    this.socket!.write(data);
  }

  private readExact(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.readBuffer.length >= n) {
          const data = Buffer.from(this.readBuffer.subarray(0, n));
          this.readBuffer = this.readBuffer.subarray(n);
          resolve(data);
          return true;
        }
        return false;
      };

      if (check()) return;

      const interval = setInterval(() => {
        if (check()) clearInterval(interval);
      }, 10);

      setTimeout(() => {
        clearInterval(interval);
        reject(new Error("Read timeout"));
      }, 15_000);
    });
  }

  private checkForFailure(): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, 1000);

      const check = () => {
        if (this.readBuffer.length >= 4) {
          clearTimeout(timeout);
          clearInterval(interval);
          this.deps.logger.error(
            "AP sent failure response after handshake:",
            this.readBuffer.subarray(0, 20).toString("hex"),
          );
          resolve(true);
        }
      };

      const interval = setInterval(check, 50);
      setTimeout(() => clearInterval(interval), 1100);
    });
  }

  private async login(): Promise<void> {
    const creds = loadStoredCredentials(this.deps.credentialsPath, this.deps.logger);
    let loginPayload: Buffer;

    const buildSystemInfo = (w: ProtoWriter) => {
      w.writeVarint(10, 0);
      w.writeVarint(60, 0);
      w.writeString(90, "spotlib");
      w.writeString(100, DEVICE_ID);
    };

    const buildTokenAuth = (token: string) =>
      new ProtoWriter()
        .writeNested(10, (w) => {
          w.writeString(10, "");
          w.writeVarint(20, 3);
          w.writeBytes(30, Buffer.from(token, "utf-8"));
        })
        .writeNested(50, buildSystemInfo)
        .writeString(70, "spotlib 1.0.0")
        .build();

    if (creds) {
      const login5Token = await this.deps.api.getLogin5Token();
      if (login5Token) {
        this.deps.logger.info(`authenticating shannon session with login5 token for ${creds.username}`);
        loginPayload = buildTokenAuth(login5Token);
      } else {
        this.deps.logger.info(`authenticating with stored credentials for ${creds.username}`);
        loginPayload = new ProtoWriter()
          .writeNested(10, (w) => {
            w.writeString(10, creds.username);
            w.writeVarint(20, creds.type);
            w.writeBytes(30, creds.data);
          })
          .writeNested(50, buildSystemInfo)
          .writeString(70, "spotlib 1.0.0")
          .build();
      }
    } else if (this.oauthToken) {
      loginPayload = buildTokenAuth(this.oauthToken);
    } else {
      const token = await this.deps.api.getAccessToken();
      loginPayload = buildTokenAuth(token);
    }

    this.sendPacket(CMD_LOGIN, loginPayload);

    const response = await this.readEncryptedPacket();
    if (response.cmd === CMD_AUTH_FAILURE) {
      if (creds) {
        this.deps.logger.warn("stored credentials rejected — delete credentials file and re-run setup");
        storedCredentials = null;
      }
      throw new Error("Spotify authentication failed");
    }
    if (response.cmd !== CMD_AUTH_SUCCESS) {
      throw new Error(`Unexpected auth response: 0x${response.cmd.toString(16)}`);
    }

    const welcome = readAll(response.payload);

    const usernameField = welcome.get(10)?.[0];
    const reusableType = welcome.get(30)?.[0] as number | undefined;
    const reusable = welcome.get(40)?.[0];
    if (usernameField instanceof Buffer) {
      const username = usernameField.toString("utf-8");
      this.deps.logger.info(`logged in as: ${username}`);

      if (reusable instanceof Buffer && reusableType !== undefined) {
        storedCredentials = { username, type: reusableType, data: Buffer.from(reusable) };
        try {
          fs.writeFileSync(
            this.deps.credentialsPath,
            JSON.stringify({ username, type: reusableType, data: reusable.toString("base64") }, null, 2),
          );
        } catch {
          // non-fatal
        }
      }
    }
  }

  private sendPacket(cmd: number, payload: Buffer): void {
    const cipher = this.sendCipher!;
    cipher.nonce(this.sendNonce);
    this.sendNonce++;

    const header = Buffer.alloc(3);
    header[0] = cmd;
    header.writeUInt16BE(payload.length, 1);

    const packet = Buffer.concat([header, payload]);
    const encrypted = cipher.encrypt(packet);
    const mac = cipher.finish(MAC_SIZE);

    this.socket!.write(Buffer.concat([encrypted, mac]));
  }

  private readEncryptedPacket(): Promise<{ cmd: number; payload: Buffer }> {
    return new Promise((resolve, reject) => {
      this.pendingReads.push({ resolve, reject });
      this.tryProcessReads();

      setTimeout(() => {
        const idx = this.pendingReads.findIndex((p) => p.resolve === resolve);
        if (idx !== -1) {
          this.pendingReads.splice(idx, 1);
          reject(new Error("Read timeout"));
        }
      }, 15_000);
    });
  }

  private tryProcessReads(): void {
    if (this.pendingReads.length === 0) return;
    if (!this.recvCipher) return;

    while (this.pendingReads.length > 0) {
      const cipher = this.recvCipher;

      if (this.readBuffer.length < 3) return;

      cipher.nonce(this.recvNonce);

      const headerCopy = Buffer.from(this.readBuffer.subarray(0, 3));
      const decryptedHeader = cipher.decrypt(headerCopy);
      const cmd = decryptedHeader[0];
      const payloadLen = (decryptedHeader[1] << 8) | decryptedHeader[2];
      const totalNeeded = 3 + payloadLen + MAC_SIZE;
      if (this.readBuffer.length < totalNeeded) return;

      this.recvNonce++;
      const packetBuf = Buffer.from(this.readBuffer.subarray(3, 3 + payloadLen));
      const receivedMac = Buffer.from(this.readBuffer.subarray(3 + payloadLen, totalNeeded));
      this.readBuffer = this.readBuffer.subarray(totalNeeded);

      const decryptedPayload = cipher.decrypt(packetBuf);

      const expectedMac = cipher.finish(MAC_SIZE);
      if (!receivedMac.equals(expectedMac)) {
        const pending = this.pendingReads.shift()!;
        pending.reject(new Error("MAC verification failed"));
        return;
      }

      const pending = this.pendingReads.shift()!;
      pending.resolve({ cmd, payload: Buffer.from(decryptedPayload) });
    }
  }

  private startBackgroundReader(): void {
    if (this.backgroundReading) return;
    this.backgroundReading = true;

    const readLoop = async () => {
      while (this.connected && this.socket) {
        try {
          const pkt = await this.readEncryptedPacket();
          this.handlePacket(pkt.cmd, pkt.payload);
        } catch {
          if (this.connected) {
            this.deps.logger.warn("spotify session read error, connection may be lost");
            this.connected = false;
          }
          break;
        }
      }
      this.backgroundReading = false;
    };
    readLoop();
  }

  private handlePacket(cmd: number, payload: Buffer): void {
    switch (cmd) {
      case CMD_PING:
        this.sendPacket(CMD_PONG, payload);
        break;
      case CMD_COUNTRY_CODE:
        if (payload.length >= 2) {
          this.deps.logger.info(`spotify country code: ${payload.toString("utf-8")}`);
        }
        break;
      case CMD_PRODUCT_INFO: {
        const xml = payload.toString("utf-8");
        const typeMatch = xml.match(/<type>([^<]+)<\/type>/);
        if (typeMatch?.[1] !== "premium") {
          this.deps.logger.warn(
            `account is NOT premium (type=${typeMatch?.[1]}) — audio key requests will be denied`,
          );
        }
        break;
      }
      case CMD_AES_KEY: {
        const seq = payload.readUInt32BE(0);
        const key = payload.subarray(4, 20);
        const cb = this.keyCallbacks.get(seq);
        if (cb) {
          cb.resolve(Buffer.from(key));
          this.keyCallbacks.delete(seq);
        }
        break;
      }
      case CMD_AES_KEY_ERROR: {
        const seq = payload.readUInt32BE(0);
        const errorCode = payload.length >= 6 ? payload.readUInt16BE(4) : -1;
        this.deps.logger.error(
          `audio key error: seq=${seq}, errorCode=${errorCode}`,
        );
        const cb = this.keyCallbacks.get(seq);
        if (cb) {
          cb.reject(
            new Error(
              errorCode === 1
                ? "Audio key request denied — premium account required"
                : `Audio key request failed (error code: ${errorCode})`,
            ),
          );
          this.keyCallbacks.delete(seq);
        }
        break;
      }
      default:
        break;
    }
  }

  requestAudioKey(trackGid: Buffer, fileId: Buffer): Promise<Buffer> {
    const seq = this.keySeq++;
    const payload = Buffer.alloc(fileId.length + trackGid.length + 4 + 2);
    let offset = 0;
    fileId.copy(payload, offset);
    offset += fileId.length;
    trackGid.copy(payload, offset);
    offset += trackGid.length;
    payload.writeUInt32BE(seq, offset);
    offset += 4;
    payload.writeUInt16BE(0, offset);

    this.sendPacket(CMD_REQUEST_KEY, payload);

    return new Promise((resolve, reject) => {
      this.keyCallbacks.set(seq, { resolve, reject });
      setTimeout(() => {
        if (this.keyCallbacks.has(seq)) {
          this.keyCallbacks.delete(seq);
          reject(new Error("Audio key request timed out"));
        }
      }, 10_000);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  destroy(): void {
    this.connected = false;
    this.socket?.destroy();
    this.socket = null;
  }
}

function bigintFromBytes(buf: Buffer): bigint {
  let result = 0n;
  for (const byte of buf) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function bigintToBytes(n: bigint): Buffer {
  if (n === 0n) return Buffer.from([0]);
  const hex = n.toString(16);
  const paddedHex = hex.length % 2 === 0 ? hex : "0" + hex;
  return Buffer.from(paddedHex, "hex");
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}
