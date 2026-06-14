"""
spotlib API — presence audio + canvas

Public:
  GET /track/{id}        serve cached MP3, 404 if not in presence cache
  GET /canvas/{id}       fetch Spotify Canvas video URL(s) for a track

Authenticated (X-API-Key header):
  POST /download         pre-fetch a track, cache 5 min, return JSON
  GET  /download/{id}    download on-demand, serve MP3 directly

Cache is disk-only: files live in cache/presence/, TTL tracked by mtime (90 days).
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.responses import FileResponse
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded


BASE_DIR     = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

NODE_PORT    = int(os.getenv("NODE_PORT", "7331"))
PY_PORT      = 8888
NODE_URL     = f"http://127.0.0.1:{NODE_PORT}"
API_KEY      = os.getenv("API_KEY", "")
CACHE_TTL        = 90 * 24 * 60 * 60  # 90 days (default)
DOWNLOAD_CMD_TTL = 60 * 60             # 1 hour for /download endpoints
PRESENCE_DIR     = BASE_DIR / "cache" / "presence"
PRESENCE_DIR.mkdir(parents=True, exist_ok=True)

if not API_KEY:
    raise RuntimeError("API_KEY not set in .env")

logging.basicConfig(level=logging.INFO, format="[spotlib] %(message)s")
log = logging.getLogger(__name__)


def _ppath(track_id: str) -> Path:
    return PRESENCE_DIR / f"{track_id}.mp3"


def _mpath(track_id: str) -> Path:
    return PRESENCE_DIR / f"{track_id}.meta"


def _read_expires_at(track_id: str) -> float | None:
    """Return the stored expiry timestamp, or estimate from mtime for legacy files."""
    mp = _mpath(track_id)
    try:
        return json.loads(mp.read_text())["expires_at"]
    except Exception:
        p = _ppath(track_id)
        if p.exists():
            return p.stat().st_mtime + CACHE_TTL  # legacy: assume 90-day TTL from cache time
        return None


def _do_cache_put(src: str, dst: Path, meta: Path, expires_at: float):
    if Path(src) != dst:
        shutil.copy2(src, dst)
    os.utime(dst, None)
    meta.write_text(json.dumps({"expires_at": expires_at}))


async def cache_put(track_id: str, src: str, ttl: int = CACHE_TTL) -> float:
    dst = _ppath(track_id)
    new_expires = time.time() + ttl
    existing = _read_expires_at(track_id)
    if existing is not None:
        new_expires = max(existing, new_expires)  # never shrink an existing TTL
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _do_cache_put, src, dst, _mpath(track_id), new_expires)
    return new_expires


def cache_get(track_id: str) -> Path | None:
    p = _ppath(track_id)
    if not p.exists():
        return None
    expires_at = _read_expires_at(track_id)
    if expires_at is None or time.time() > expires_at:
        p.unlink(missing_ok=True)
        _mpath(track_id).unlink(missing_ok=True)
        return None
    return p


def _purge_expired():
    """Delete presence files + their cache/music originals when TTL exceeded."""
    now = time.time()
    music_dir = BASE_DIR / "cache" / "music"
    for f in PRESENCE_DIR.glob("*.mp3"):
        try:
            expires_at = _read_expires_at(f.stem)
            if expires_at is None or now > expires_at:
                f.unlink()
                _mpath(f.stem).unlink(missing_ok=True)
                for ext in (".mp3", ".ogg", ".m4a"):
                    src = music_dir / f"{f.stem}{ext}"
                    src.unlink(missing_ok=True)
                log.info(f"evicted {f.stem}")
        except Exception:
            pass
    # clean up orphaned .meta files (audio evicted by Node LRU without removing sidecar)
    for m in PRESENCE_DIR.glob("*.meta"):
        if not _ppath(m.stem).exists():
            try:
                m.unlink()
            except Exception:
                pass


async def _cleanup_loop():
    while True:
        await asyncio.sleep(3600)
        _purge_expired()


_node_proc: subprocess.Popen | None = None
_node_lock: asyncio.Lock | None = None


def _start_node() -> subprocess.Popen:
    return subprocess.Popen(
        ["node", str(BASE_DIR / "server.mjs")],
        cwd=str(BASE_DIR),
        env={**os.environ, "NODE_PORT": str(NODE_PORT)},
    )


async def _wait_for_node(timeout: float = 25.0):
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient() as c:
        while time.monotonic() < deadline:
            try:
                r = await c.get(f"{NODE_URL}/health", timeout=2.0)
                if r.is_success:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.5)
    raise RuntimeError("node backend did not start in time")


async def _node_watchdog():
    global _node_proc
    await asyncio.sleep(10)
    while True:
        await asyncio.sleep(5)
        if _node_proc and _node_proc.poll() is not None:
            log.warning(f"node crashed (exit {_node_proc.returncode}), restarting...")
            async with _node_lock:  # type: ignore
                _node_proc = _start_node()
            try:
                await _wait_for_node(timeout=20.0)
                log.info("node restarted ok")
            except RuntimeError:
                log.error("node failed to restart in time")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _node_proc, _node_lock
    _node_lock = asyncio.Lock()
    _purge_expired()  # clean up any files left over from a previous crash
    _node_proc = _start_node()
    await _wait_for_node()
    log.info(f"node backend ready on :{NODE_PORT}")
    asyncio.create_task(_cleanup_loop())
    asyncio.create_task(_node_watchdog())
    yield
    if _node_proc and _node_proc.poll() is None:
        _node_proc.terminate()
        _node_proc.wait()


_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def _is_local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost")


def require_key(request: Request, key: str | None = Security(_key_header)):
    if _is_local(request):
        return  # localhost bypasses auth
    if key != API_KEY:
        raise HTTPException(401, detail="invalid or missing API key")


def _real_ip(request: Request) -> str:
    # Return a fixed key for localhost so rate limits never apply locally
    host = request.client.host if request.client else ""
    if host in ("127.0.0.1", "::1", "localhost"):
        return "localhost-unlimited"
    fwd = request.headers.get("X-Forwarded-For")
    return fwd.split(",")[0].strip() if fwd else host or "unknown"


limiter = Limiter(key_func=_real_ip, default_limits=["9999999/minute"])

app = FastAPI(title="spotlib", version="2.0.0", lifespan=lifespan, redirect_slashes=False)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


async def _node_download(input_str: str) -> dict:
    async with httpx.AsyncClient() as c:
        try:
            r = await c.post(f"{NODE_URL}/download", json={"input": input_str}, timeout=180.0)
        except httpx.RequestError as e:
            raise HTTPException(502, detail=str(e))
    if not r.is_success:
        body = r.json() if "application/json" in r.headers.get("content-type", "") else {}
        raise HTTPException(r.status_code, detail=body.get("error", r.text))
    return r.json()

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/track/{track_id}")
@limiter.limit("60/minute")
async def get_track(request: Request, track_id: str):
    """Serve cached MP3. 404 if not in presence cache (nothing was pre-fetched)."""
    p = cache_get(track_id)
    if not p:
        raise HTTPException(404, detail="not cached")
    return FileResponse(str(p), media_type="audio/mpeg", filename=f"{track_id}.mp3")


class DownloadBody(BaseModel):
    input: str        # Spotify URL, URI, or track ID
    ttl: int | None = None  # seconds; None → 90 days default

@app.post("/download", dependencies=[Depends(require_key)])
@app.post("/download/", dependencies=[Depends(require_key)], include_in_schema=False)
async def trigger_download(body: DownloadBody):
    """Pre-fetch a track. Default TTL 90 days; pass ttl to override. Never shrinks existing TTL."""
    ttl = body.ttl if body.ttl is not None else CACHE_TTL
    track_id = body.input
    for prefix in ["open.spotify.com/track/", "spotify:track:"]:
        if prefix in track_id:
            track_id = track_id.split(prefix)[-1].split("?")[0].strip()
            break

    existing = cache_get(track_id)
    if existing:
        expires = await cache_put(track_id, str(existing), ttl=ttl)
        return {"ok": True, "id": track_id, "cached": True, "cached_until": expires}

    data = await _node_download(body.input)
    src = data.get("path", "")
    if not src or not Path(src).exists():
        raise HTTPException(500, detail="download succeeded but file missing")

    expires = await cache_put(track_id, src, ttl=ttl)
    return {"ok": True, "id": track_id, "cached": False, "cached_until": expires, "steps": data.get("steps", [])}


@app.get("/download/{track_id}", dependencies=[Depends(require_key)])
async def download_track(track_id: str, ttl: int | None = None):
    """On-demand download — always works. Serves MP3 directly. Default TTL 90 days."""
    effective_ttl = ttl if ttl is not None else CACHE_TTL
    p = cache_get(track_id)
    if not p:
        data = await _node_download(track_id)
        src = data.get("path", "")
        if not src or not Path(src).exists():
            raise HTTPException(500, detail="download failed")
        await cache_put(track_id, src, ttl=effective_ttl)
        p = _ppath(track_id)
    else:
        await cache_put(track_id, str(p), ttl=effective_ttl)
    return FileResponse(str(p), media_type="audio/mpeg", filename=f"{track_id}.mp3")

@app.get("/lyrics/{track_id}", dependencies=[Depends(require_key)])
async def get_lyrics(track_id: str):
    """Synced lyrics for a track. Null if unavailable."""
    async with httpx.AsyncClient() as c:
        try:
            r = await c.get(f"{NODE_URL}/lyrics/{track_id}", timeout=15.0)
        except httpx.RequestError as e:
            raise HTTPException(502, detail=str(e))
    if not r.is_success:
        raise HTTPException(r.status_code)
    data = r.json()
    if data is None:
        raise HTTPException(404, detail="no lyrics available")
    return data


@app.get("/check/{track_id}")
@limiter.limit("30/minute")
async def check_track(request: Request, track_id: str):
    """Check if a track is cached or downloadable — never triggers a download."""
    if cache_get(track_id):
        return {"cached": True, "downloadable": True}
    async with httpx.AsyncClient() as c:
        try:
            r = await c.get(f"{NODE_URL}/check/{track_id}", timeout=15.0)
            downloadable = r.json().get("downloadable", False) if r.is_success else False
        except Exception:
            downloadable = False
    return {"cached": False, "downloadable": downloadable}


@app.get("/canvas/{track_id}", dependencies=[Depends(require_key)])
@limiter.limit("300/minute")
async def canvas_track(request: Request, track_id: str):
    """Fetch Spotify Canvas looping video URL(s) for a track. Proxies to Node backend."""
    async with httpx.AsyncClient() as c:
        try:
            r = await c.get(f"{NODE_URL}/canvas/{track_id}", timeout=15.0)
        except httpx.RequestError as e:
            raise HTTPException(502, detail=str(e))
    if not r.is_success:
        raise HTTPException(r.status_code, detail=r.text)
    return r.json()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=PY_PORT, reload=False, access_log=True)
