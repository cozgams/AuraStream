#!/usr/bin/env python3
import os
import re
import sys
import mimetypes
from pathlib import Path
from http import HTTPStatus
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DIRECTORY = Path(sys.argv[1] if len(sys.argv) > 1 else "/data/home/Project/A/HGhubX/downloads").resolve()
PORT = int(sys.argv[2] if len(sys.argv) > 2 else 8080)

mimetypes.add_type("application/vnd.android.package-archive", ".apk")

class TurboDownloadHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIRECTORY), **kwargs)

    def do_HEAD(self):
        self.send_file(head_only=True)

    def do_GET(self):
        self.send_file(head_only=False)

    def send_file(self, head_only=False):
        clean_path = self.path.split("?")[0].lstrip("/")
        if not clean_path or clean_path.endswith("/"):
            clean_path = "index.html"

        file_path = (DIRECTORY / clean_path).resolve()
        try:
            file_path.relative_to(DIRECTORY)
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN, "Access denied")
            return

        if not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        file_size = file_path.stat().st_size
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = "application/octet-stream"

        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1
        status = HTTPStatus.OK

        if range_header:
            m = re.match(r"^bytes=(\d*)-(\d*)$", range_header.strip())
            if m:
                s_str, e_str = m.groups()
                if s_str:
                    start = int(s_str)
                    if e_str:
                        end = int(e_str)
                elif e_str:
                    suffix_len = int(e_str)
                    if suffix_len <= 0:
                        start = file_size
                    else:
                        start = max(0, file_size - suffix_len)

                if start >= file_size or end >= file_size or start > end:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.end_headers()
                    return

                status = HTTPStatus.PARTIAL_CONTENT

        content_length = end - start + 1

        self.send_response(status)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=3600")

        # Force direct attachment download for APK files
        if file_path.suffix.lower() == ".apk":
            self.send_header("Content-Disposition", f'attachment; filename="{file_path.name}"')

        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")

        self.end_headers()

        if head_only:
            return

        try:
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                # Use os.sendfile for kernel-level zero-copy ultra fast transmission
                sock_fd = self.wfile.fileno()
                file_fd = f.fileno()
                try:
                    while remaining > 0:
                        sent = os.sendfile(sock_fd, file_fd, f.tell(), remaining)
                        if sent == 0:
                            break
                        f.seek(f.tell() + sent)
                        remaining -= sent
                except (AttributeError, OSError):
                    # Fallback to 1MB memory buffer copy
                    buf_size = 1024 * 1024
                    while remaining > 0:
                        chunk = f.read(min(remaining, buf_size))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

def run():
    print(f"Starting Turbo Download Server on 127.0.0.1:{PORT} serving {DIRECTORY}...")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), TurboDownloadHandler)
    server.serve_forever()

if __name__ == "__main__":
    run()
