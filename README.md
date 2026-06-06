# spotlib

TypeScript library for downloading Spotify audio tracks with dual decryption paths: **Shannon OGG** (preferred) and **Widevine MP4/AAC** (fallback). Outputs MP3 with embedded metadata and album art.

## Features

- Download tracks by URL, URI, or track ID
- Automatic Shannon → Widevine fallback
- MP3 conversion with ID3 tags + album art
- Search tracks, fetch metadata, get synced lyrics
- Playlist and album track listing
- LRU cache with configurable size limit
- HTTP/SOCKS proxy support
- Automatic 429 rate-limit handling with retry

## Prerequisites

- **Node.js** >= 18
- **ffmpeg** in your PATH (for MP3 conversion and Widevine decryption)
- **Spotify Premium** account (required for audio key requests)
- **sp_dc cookie** from your browser

### For Widevine fallback (optional)

- **Python 3.10+** with `httpx` and `pywidevine` packages
- A `.wvd` device file

## Setup

```bash
# Clone the repo
git clone <this-repo-url> spotlib
cd spotlib

# Install dependencies
npm install

# Build
npm run build

# Copy the example env and fill in your credentials
cp .env.example .env
```

### Getting your sp_dc cookie

1. Open [open.spotify.com](https://open.spotify.com) in your browser and log in
2. Open DevTools (`F12` or `Ctrl+Shift+I`)
3. Go to **Application** > **Cookies** > `https://open.spotify.com`
4. Find the `sp_dc` cookie and copy its value
5. Paste it into your `.env` file

### Getting Spotify API credentials (recommended)

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Create a new app (redirect URI doesn't matter for this use case)
3. Copy the **Client ID** and **Client Secret** into your `.env`

These are optional but recommended — without them, search and metadata requests share the sp_dc token pool which can hit rate limits faster.

### Widevine setup (optional)

The Shannon path handles most tracks. Widevine is only needed as a fallback when Shannon fails (rare). If you want it:

```bash
pip install httpx pywidevine
```

You'll also need a `.wvd` device file — place it in the project root as `device.wvd` or set the path in your `.env`.

## Usage

```typescript
import { SpotLib } from "./dist/index.js";
import "dotenv/config"; // or load env vars however you want

const spot = new SpotLib({
  spDc: process.env.SP_DC!,
  wvdPath: process.env.WVD_PATH || "./device.wvd",
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  proxy: process.env.SPOT_PROXY,
  pythonCmd: process.env.PYTHON_CMD || "python3",
});

// Download a track — accepts URLs, URIs, or raw track IDs
const mp3Path = await spot.download("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
console.log(`saved to: ${mp3Path}`);

// Search
const track = await spot.search("Never Gonna Give You Up");
console.log(track);
// { id: '4cOdK2wGLETKBW3PvgPWqT', title: 'Never Gonna Give You Up', artist: 'Rick Astley', ... }

// Download with progress tracking
const path = await spot.download("spotify:track:4cOdK2wGLETKBW3PvgPWqT", {
  onProgress: (step) => console.log(`step: ${step}`),
  // steps: connecting → metadata → audiokey → cdn → decrypting → saving
});

// Get synced lyrics
const lyrics = await spot.getLyrics("4cOdK2wGLETKBW3PvgPWqT");
if (lyrics) {
  for (const line of lyrics.lines) {
    console.log(`[${line.startTimeMs}] ${line.words}`);
  }
}

// Playlist tracks
const tracks = await spot.getPlaylistTracks("37i9dQZF1DXcBWIGoYBM5M");
for (const t of tracks) {
  console.log(`${t.artist} - ${t.title}`);
}

// Album tracks
const albumTracks = await spot.getAlbumTracks("6DEjYFkNZh67HP7R9PSZvv");

// Clean up when done
spot.destroy();
```

## API Reference

### `new SpotLib(config)`

| Config field | Type | Required | Default | Description |
|---|---|---|---|---|
| `spDc` | `string` | yes | — | Spotify sp_dc cookie |
| `wvdPath` | `string` | yes | — | Path to `.wvd` device file |
| `clientId` | `string` | no | — | Spotify API client ID |
| `clientSecret` | `string` | no | — | Spotify API client secret |
| `proxy` | `string` | no | — | Proxy in `ip:port:user:pass` format |
| `credentialsPath` | `string` | no | `./spotify_credentials.json` | Stored credentials path |
| `cachePath` | `string` | no | `./cache/music` | Audio cache directory |
| `maxCacheSize` | `number` | no | `2147483648` (2GB) | Max cache size in bytes |
| `pythonCmd` | `string` | no | `python3` | Python executable for Widevine helper |
| `logger` | `Logger` | no | console | Custom logger |

### Methods

| Method | Returns | Description |
|---|---|---|
| `download(input, opts?)` | `Promise<string>` | Download track, returns path to MP3 |
| `search(query)` | `Promise<SpotifyTrack \| null>` | Search for a track |
| `getTrack(id)` | `Promise<SpotifyTrack>` | Get track metadata by ID |
| `getLyrics(trackId)` | `Promise<TrackLyrics \| null>` | Get synced lyrics |
| `getPlaylistTracks(id)` | `Promise<SpotifyTrack[]>` | Get all tracks in a playlist |
| `getAlbumTracks(id)` | `Promise<SpotifyTrack[]>` | Get all tracks in an album |
| `invalidateTokens()` | `void` | Clear all cached auth tokens |
| `destroy()` | `void` | Close connections and clean up |

### Types

```typescript
interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArt: string | null;
  duration: number;     // milliseconds
  uri: string;          // spotify:track:xxxxx
}

interface TrackLyrics {
  syncType: "LINE_SYNCED" | "UNSYNCED";
  lines: { startTimeMs: string; words: string }[];
}

type DownloadStep = "connecting" | "metadata" | "audiokey" | "cdn" | "decrypting" | "saving" | "cached";
```

## How It Works

1. **Authentication**: Uses your sp_dc cookie to get web player tokens. If a `spotify_credentials.json` exists, it uses Login5 protocol for desktop-scoped tokens (auto-generated on first successful connection).

2. **Shannon path** (preferred): Connects to Spotify's Access Point over TCP, performs a Diffie-Hellman handshake, establishes Shannon cipher encryption, requests an audio key, downloads the encrypted OGG from CDN, and decrypts it with AES-128-CTR.

3. **Widevine path** (fallback): Fetches the PSSH from Spotify's seektable API, acquires a Widevine license via Python helper, downloads the encrypted MP4 from CDN, and decrypts with ffmpeg.

4. **Post-processing**: Converts to MP3 using ffmpeg with embedded ID3 tags (title, artist, album) and album artwork.

## Project Structure

```
spotlib/
├── src/
│   ├── index.ts        # Main SpotLib class and exports
│   ├── types.ts        # TypeScript interfaces and constants
│   ├── api.ts          # Spotify API client (auth, metadata, search, lyrics)
│   ├── downloader.ts   # Download orchestration, decryption, caching
│   ├── session.ts      # TCP session with Shannon cipher
│   ├── shannon.ts      # Shannon stream cipher implementation
│   ├── totp.ts         # TOTP generation for sp_dc auth
│   ├── proxy.ts        # HTTP and TCP proxy support
│   └── proto.ts        # Protobuf reader/writer
├── widevine-helper.py  # Python Widevine license acquisition
├── .env.example        # Environment template
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
