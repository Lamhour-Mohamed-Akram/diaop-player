#!/usr/bin/env python3
"""
Diamond Operatore Player audio helper (OPTIONAL).

Browsers cannot decode Dolby AC-3/E-AC-3 audio or some containers (.mkv/.avi).
This tiny local helper uses ffmpeg to convert ONLY the audio track to AAC on
the fly (video is copied untouched), so every stream plays with sound in any
browser. The web app detects it automatically when it is running.

Usage:
    python3 tools/audio-helper.py          (requires ffmpeg: brew install ffmpeg)

It listens on 127.0.0.1:8765 only (never reachable from other machines),
stores nothing, and talks only to the stream URL the player asks for.
Licensed under GPL-3.0, same as the player.
"""
import json
import os
import select
import shutil
import socket
import subprocess
import sys
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

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

    def do_GET(self):
        p = urlparse(self.path)

        if p.path == "/probe":
            body = json.dumps({"ok": True, "ffmpeg": bool(FFMPEG)}).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
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
