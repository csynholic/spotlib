"""Print total size of the song cache directories."""
from pathlib import Path

BASE = Path(__file__).parent
DIRS = {
    "presence": BASE / "cache" / "presence",
    "music":    BASE / "cache" / "music",
}

AUDIO_EXTS = {".mp3", ".ogg", ".m4a"}

def fmt(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"

total_size = 0
total_songs = 0
for name, d in DIRS.items():
    if not d.exists():
        print(f"{name}: (not found)")
        continue
    files = [f for f in d.iterdir() if f.suffix in AUDIO_EXTS]
    size = sum(f.stat().st_size for f in files)
    total_size += size
    total_songs += len(files)
    print(f"{name}: {fmt(size)} ({len(files)} songs)")

print(f"total:    {fmt(total_size)} ({total_songs} songs)")
