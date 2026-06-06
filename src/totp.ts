import * as crypto from "node:crypto";

const SECRETS_URL =
  "https://github.com/xyloflake/spot-secrets-go/blob/main/secrets/secretDict.json?raw=true";

let cachedSecrets: Record<string, number[]> | null = null;
let secretsFetchedAt = 0;
const SECRETS_TTL = 6 * 60 * 60 * 1000;

type FetchFn = typeof globalThis.fetch;

async function fetchSecrets(fetchFn: FetchFn): Promise<Record<string, number[]>> {
  if (cachedSecrets && Date.now() - secretsFetchedAt < SECRETS_TTL) {
    return cachedSecrets;
  }

  const res = await fetchFn(SECRETS_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to fetch TOTP secrets: ${res.status}`);
  cachedSecrets = (await res.json()) as Record<string, number[]>;
  secretsFetchedAt = Date.now();
  return cachedSecrets;
}

function base32Encode(buf: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }

  return out;
}

function generateTOTP(secret: string, time: number): string {
  const counter = Math.floor(time / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const secretBuf = base32Decode(secret);
  const hmac = crypto.createHmac("sha1", secretBuf).update(counterBuf).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, "0");
}

function base32Decode(encoded: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of encoded.toUpperCase()) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function deriveSecret(cipher: number[]): string {
  const transformed = cipher.map((e, t) => e ^ ((t % 33) + 9));
  const joined = transformed.map(String).join("");
  const hexStr = Buffer.from(joined, "utf-8").toString("hex");
  const cleaned = hexStr.replace(/[^0-9a-fA-F]/g, "");
  const evenCleaned = cleaned.length % 2 === 0 ? cleaned : cleaned.slice(0, -1);
  return base32Encode(Buffer.from(evenCleaned, "hex"));
}

export async function generateSpotifyTOTP(fetchFn: FetchFn = globalThis.fetch): Promise<{
  totp: string;
  totpVer: string;
}> {
  const secrets = await fetchSecrets(fetchFn);
  const ver = Math.max(...Object.keys(secrets).map(Number));
  const secret = deriveSecret(secrets[String(ver)]);
  const serverTime = Math.floor(Date.now() / 1000);
  return { totp: generateTOTP(secret, serverTime), totpVer: String(ver) };
}

/** Returns the derived base32 TOTP secret + version without computing an OTP. */
export async function fetchSpotifyTotpSecret(fetchFn: FetchFn = globalThis.fetch): Promise<{
  secret: string;
  ver: string;
}> {
  const secrets = await fetchSecrets(fetchFn);
  const ver = Math.max(...Object.keys(secrets).map(Number));
  return { secret: deriveSecret(secrets[String(ver)]), ver: String(ver) };
}

/** Compute a TOTP code for an explicit counter value (not time-derived). */
export function computeTotp(secret: string, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const secretBuf = base32Decode(secret);
  const hmac = crypto.createHmac("sha1", secretBuf).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}
