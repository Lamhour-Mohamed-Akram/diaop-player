#!/usr/bin/env python3
"""
Diamond Operatore Player audio helper (OPTIONAL).

Two jobs, both on your own machine only:

1. HTTPS bridge - the hosted player (https://diaop.netlify.app) cannot load
   plain-HTTP providers directly (browsers forbid mixed content), but pages
   MAY talk to 127.0.0.1. While this helper runs, the player automatically
   relays playlists and streams through it, so HTTP providers work on the
   HTTPS site. Nothing leaves your machine except requests to your provider.
2. Audio fallback - converts Dolby AC-3/E-AC-3 audio to AAC with ffmpeg for
   the rare stream the in-browser engine cannot handle (needs ffmpeg).

Usage:
    python3 tools/audio-helper.py          (requires ffmpeg: brew install ffmpeg)

It listens on 127.0.0.1:8765 only (never reachable from other machines),
stores nothing, and talks only to the stream URL the player asks for.
Licensed under GPL-3.0, same as the player.
"""
import json
import os
import re
import select
import shutil
import socket
import subprocess
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urljoin, quote as urlquote

HOST, PORT = "127.0.0.1", 8765
FFMPEG = shutil.which("ffmpeg")
# One transcode at a time: IPTV accounts usually allow a single connection, so
# starting a new stream must kill the previous ffmpeg (and its connection).
_PROC_LOCK = threading.Lock()
_CURRENT_PROC = None


def _replace_current_proc(proc):
    global _CURRENT_PROC
    with _PROC_LOCK:
        old = _CURRENT_PROC
        _CURRENT_PROC = proc
    if old and old.poll() is None:
        old.kill()


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0: the streamed body is delimited by connection close.
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def _upstream(self, url, send_range=True):
        """Open the upstream URL, forwarding the viewer's Range header."""
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "VLC/3.0.21 LibVLC/3.0.21")
        if send_range and self.headers.get("Range"):
            req.add_header("Range", self.headers["Range"])
        return urllib.request.urlopen(req, timeout=20)

    def _bad_gateway(self, err):
        code = getattr(err, "code", None) or 502
        try:
            self.send_response(code)
            self._cors()
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        p = urlparse(self.path)

        if p.path == "/probe":
            body = json.dumps({"ok": True, "ffmpeg": bool(FFMPEG), "bridge": True}).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # ── HTTPS bridge ──────────────────────────────────────────────────
        # Browsers forbid an HTTPS page from loading plain-HTTP content, but
        # 127.0.0.1 is exempt (a "potentially trustworthy origin"). These
        # endpoints let the hosted HTTPS player reach HTTP-only providers by
        # relaying through THIS machine only - no third party ever involved.

        if p.path == "/fetch":
            # Playlists and provider API calls (text/JSON), streamed through.
            url = (parse_qs(p.query).get("url") or [""])[0]
            if not url.startswith(("http://", "https://")):
                self.send_response(400); self._cors(); self.end_headers(); return
            try:
                up = self._upstream(url, send_range=False)
            except Exception as e:
                self._bad_gateway(e); return
            self.send_response(up.status)
            self._cors()
            self.send_header("Content-Type", up.headers.get("Content-Type", "application/octet-stream"))
            self.end_headers()
            try:
                shutil.copyfileobj(up, self.wfile, 65536)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                up.close()
            return

        if p.path == "/raw":
            # Byte-for-byte stream relay with Range passthrough (movies, TS
            # segments, the single-connection MKV pipeline).
            url = (parse_qs(p.query).get("url") or [""])[0]
            if not url.startswith(("http://", "https://")):
                self.send_response(400); self._cors(); self.end_headers(); return
            try:
                up = self._upstream(url)
            except Exception as e:
                self._bad_gateway(e); return
            self.send_response(up.status)
            self._cors()
            for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                if up.headers.get(h):
                    self.send_header(h, up.headers[h])
            self.end_headers()
            try:
                shutil.copyfileobj(up, self.wfile, 65536)
            except (BrokenPipeError, ConnectionResetError):
                pass  # viewer stopped/seeked - drop the provider connection too
            finally:
                up.close()
            return

        if p.path == "/hls":
            # HLS manifest relay: rewrite every URI to come back through this
            # bridge, else the browser would fetch http segments and be blocked.
            url = (parse_qs(p.query).get("url") or [""])[0]
            if not url.startswith(("http://", "https://")):
                self.send_response(400); self._cors(); self.end_headers(); return
            try:
                up = self._upstream(url, send_range=False)
                text = up.read(8 * 1024 * 1024).decode("utf-8", "replace")
                final_url = up.geturl()  # follow redirects for correct base
                up.close()
            except Exception as e:
                self._bad_gateway(e); return

            def bridge_uri(u):
                absu = urljoin(final_url, u.strip())
                ep = "/hls" if ".m3u8" in absu.split("?")[0].lower() else "/raw"
                return f"http://{HOST}:{PORT}{ep}?url=" + urlquote(absu, safe="")

            out = []
            for line in text.splitlines():
                s = line.strip()
                if s and not s.startswith("#"):
                    out.append(bridge_uri(s))
                elif 'URI="' in line:
                    line = re.sub(r'URI="([^"]+)"', lambda m: 'URI="' + bridge_uri(m.group(1)) + '"', line)
                    out.append(line)
                else:
                    out.append(line)
            body = ("\n".join(out) + "\n").encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if p.path == "/play":
            url = (parse_qs(p.query).get("url") or [""])[0]
            if not FFMPEG or not url.startswith(("http://", "https://")):
                self.send_response(400)
                self._cors()
                self.end_headers()
                return

            cmd = [
                FFMPEG, "-hide_banner", "-loglevel", "error",
                "-user_agent", "VLC/3.0.21 LibVLC/3.0.21",
                "-rw_timeout", "15000000",  # give up on a stalled/refused input after 15s
                "-i", url,
                "-map", "0:v:0?", "-map", "0:a:0?",
                "-c:v", "copy",
                "-c:a", "aac", "-ac", "2", "-b:a", "192k",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "-f", "mp4", "pipe:1",
            ]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            _replace_current_proc(proc)
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "video/mp4")
            self.end_headers()
            # Stream with a watchdog: stop when the viewer disconnects, when
            # ffmpeg ends, or when no data has flowed for 25s - so a stuck
            # ffmpeg can never hold the provider connection open forever.
            fd = proc.stdout.fileno()
            idle = 0
            try:
                while True:
                    ready, _, _ = select.select([fd, self.connection], [], [], 1.0)
                    if self.connection in ready:
                        try:
                            if not self.connection.recv(1, socket.MSG_PEEK):
                                break  # viewer disconnected
                        except OSError:
                            break
                    if fd in ready:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break  # ffmpeg finished or was replaced
                        idle = 0
                        self.wfile.write(chunk)
                    else:
                        idle += 1
                        if idle > 25:
                            break  # stalled - release the provider connection
            except (BrokenPipeError, ConnectionResetError):
                pass  # viewer stopped or switched streams
            finally:
                proc.kill()
            return

        self.send_response(404)
        self._cors()
        self.end_headers()


if __name__ == "__main__":
    if not FFMPEG:
        print("ffmpeg was not found. Install it first:  brew install ffmpeg")
        sys.exit(1)
    print(f"Diamond Operatore Player audio helper running on http://{HOST}:{PORT}")
    print("Leave this window open while watching. Press Ctrl+C to stop.")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
