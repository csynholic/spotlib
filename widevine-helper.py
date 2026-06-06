"""
Widevine helper for Spotify audio decryption.
Takes a file_id and sp_dc cookie, returns the content decryption key.

Handles the full auth flow internally (session token + client token)
to match what the web player sends.

Usage:
  python widevine-helper.py <file_id> --sp-dc <cookie> [--wvd <path>]
  python widevine-helper.py <file_id> --token <access_token> --client-token <token> [--wvd <path>]

Output (JSON):
  {"key": "<hex>", "key_id": "<hex>"}
"""

import argparse
import json
import sys

import httpx
from pywidevine import PSSH, Cdm, Device

SEEK_TABLE_URL = "https://seektables.scdn.co/seektable/{file_id}.json"
WIDEVINE_LICENSE_URL = "https://gue1-spclient.spotify.com/widevine-license/v1/audio/license"
SESSION_TOKEN_URL = "https://open.spotify.com/api/token"
CLIENT_TOKEN_URL = "https://clienttoken.spotify.com/v1/clienttoken"
SERVER_TIME_URL = "https://open.spotify.com/api/server-time"
CLIENT_VERSION = "1.2.70.61.g856ccd63"

BROWSER_HEADERS = {
    "Accept": "application/json",
    "Accept-Language": "en-US",
    "Origin": "https://open.spotify.com",
    "Referer": "https://open.spotify.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "spotify-app-version": CLIENT_VERSION,
    "app-platform": "WebPlayer",
}


def get_web_tokens(sp_dc: str) -> tuple[str, str]:
    """Get access token and client token using sp_dc cookie."""
    client = httpx.Client(cookies={"sp_dc": sp_dc}, headers=BROWSER_HEADERS)

    # Get session token
    resp = client.get(SESSION_TOKEN_URL, params={
        "reason": "transport",
        "productType": "web-player",
    })
    if resp.status_code != 200:
        raise RuntimeError(f"session token failed: {resp.status_code}")
    session = resp.json()
    access_token = session["accessToken"]
    client_id = session["clientId"]

    # Get client token
    resp = client.post(CLIENT_TOKEN_URL, json={
        "client_data": {
            "client_version": CLIENT_VERSION,
            "client_id": client_id,
            "js_sdk_data": {},
        }
    }, headers={"Accept": "application/json"})
    if resp.status_code != 200:
        raise RuntimeError(f"client token failed: {resp.status_code}")
    client_token = resp.json()["granted_token"]["token"]

    client.close()
    return access_token, client_token


def get_pssh(file_id: str) -> str:
    resp = httpx.get(
        SEEK_TABLE_URL.format(file_id=file_id),
        headers={
            "Accept": "*/*",
            "Origin": "https://open.spotify.com",
            "Referer": "https://open.spotify.com/",
        },
    )
    if resp.status_code != 200:
        raise RuntimeError(f"seek table failed: {resp.status_code} {resp.text[:200]}")
    data = resp.json()
    pssh = data.get("pssh") or data.get("widevine_pssh")
    if not pssh:
        raise RuntimeError(f"no PSSH in seek table response: {list(data.keys())}")
    return pssh


def get_widevine_key(pssh_str: str, access_token: str, client_token: str, wvd_path: str) -> dict:
    device = Device.load(wvd_path)
    cdm = Cdm.from_device(device)
    session = cdm.open()

    try:
        pssh = PSSH(pssh_str)
        challenge = cdm.get_license_challenge(session, pssh)

        resp = httpx.post(
            WIDEVINE_LICENSE_URL,
            content=challenge,
            headers={
                "Authorization": f"Bearer {access_token}",
                "client-token": client_token,
                "Content-Type": "application/octet-stream",
                "Accept": "*/*",
                "Origin": "https://open.spotify.com",
                "Referer": "https://open.spotify.com/",
                "User-Agent": BROWSER_HEADERS["User-Agent"],
                "spotify-app-version": CLIENT_VERSION,
                "app-platform": "WebPlayer",
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(f"widevine license failed: {resp.status_code} {resp.text[:200]}")

        cdm.parse_license(session, resp.content)
        content_key = next(k for k in cdm.get_keys(session) if k.type == "CONTENT")
        return {
            "key": content_key.key.hex(),
            "key_id": content_key.kid.hex,
        }
    finally:
        cdm.close(session)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file_id", help="Spotify file ID (hex)")
    parser.add_argument("--sp-dc", help="Spotify sp_dc cookie (handles full auth)")
    parser.add_argument("--token", help="Pre-obtained access token")
    parser.add_argument("--client-token", help="Pre-obtained client token")
    parser.add_argument("--wvd", default="device.wvd", help="Path to .wvd file")
    args = parser.parse_args()

    if args.sp_dc:
        access_token, client_token = get_web_tokens(args.sp_dc)
    elif args.token and args.client_token:
        access_token = args.token
        client_token = args.client_token
    else:
        parser.error("either --sp-dc or both --token and --client-token are required")

    pssh = get_pssh(args.file_id)
    result = get_widevine_key(pssh, access_token, client_token, args.wvd)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
