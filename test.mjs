import { SpotLib } from "./dist/index.js";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dir, ".env") });

const spot = new SpotLib({
  spDc: process.env.SP_DC,
  wvdPath: process.env.WVD_PATH || "./device.wvd",
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

console.log("searching for a track...");
const track = await spot.search("Never Gonna Give You Up Rick Astley");
console.log("search result:", JSON.stringify(track, null, 2));

if (track) {
  console.log("\ndownloading track:", track.id);
  const mp3 = await spot.download(track.id, {
    onProgress: (step) => console.log("  step:", step),
  });
  console.log("saved to:", mp3);
}

spot.destroy();
