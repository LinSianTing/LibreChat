"""Loopback-only synthetic API for reviewing the real built Chat frontend.

No database, credentials, external requests or model implementation. Not a runtime service.
Usage: python openschool/mobile-preview.py --dist <client/dist> --port 15412
"""
import argparse
import base64
import json
import time
from datetime import datetime, timezone, timedelta
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs


USER = {"id": "507f1f77bcf86cd799439011", "_id": "507f1f77bcf86cd799439011",
        "name": "本機合成預覽・不連 API", "username": "preview", "email": "preview@example.test",
        "role": "USER", "provider": "local", "emailVerified": True, "plugins": [],
        "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-01T00:00:00Z"}


def token():
    def enc(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    return enc({"alg": "none"}) + "." + enc({"id": USER["id"], "exp": int(time.time()) + 7200}) + ".synthetic"


class Preview(SimpleHTTPRequestHandler):
    asks = 0
    handoffs = 0

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "connect-src 'self'; frame-src 'none'; object-src 'none'")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # Do not log editable draft content or request bodies.

    def reply(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 100000))
        self.api(urlsplit(self.path).path)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/"):
            return self.api(parsed.path)
        if parsed.path == "/preview-stats":
            return self.reply({"handoffs": Preview.handoffs, "sendAttempts": Preview.asks, "modelCalls": 0})
        if parsed.path == "/preview":
            case = parse_qs(parsed.query).get("case", [""])[0]
            if case in {"success", "expired", "forbidden", "unavailable", "long"}:
                self.send_response(302)
                self.send_header("Set-Cookie", f"preview_case={case}; Path=/; SameSite=Strict")
                self.send_header("Location", "/c/new?endpoint=OpenSchool&model=personal&os_handoff=" + "a" * 64)
                self.end_headers()
                return
            body = '''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
            <title>OpenSchool 手機本機預覽</title><style>body{font:18px/1.7 system-ui;max-width:650px;margin:32px auto;padding:16px}a{display:block;padding:12px}</style>
            <h1>手機 Chat 排版預覽</h1><p>實際前端產物＋合成登入／提示稿。無 Google、資料庫或模型呼叫；送出只顯示本機拒絕，不能當真 API 驗收。</p>
            <p>可編輯、關閉提示並檢查草稿保留。重新選情境會開始新的合成帶稿。</p>
            <a href="/preview?case=success">成功提示與短草稿</a><a href="/preview?case=long">長草稿</a>
            <a href="/preview?case=expired">已逾期</a><a href="/preview?case=forbidden">取用遭拒</a>
            <a href="/preview?case=unavailable">暫時無法取得</a><a href="/preview-stats">檢查本機請求計數</a>'''.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path in {"/sw.js", "/service-worker.js"}:
            return self.reply({}, 404)
        if not Path(self.translate_path(parsed.path)).is_file():
            self.path = "/index.html"
        super().do_GET()

    def api(self, path):
        if path.startswith("/api/auth/"):
            return self.reply({"user": USER, "token": token()})
        if path in {"/api/user", "/api/user/"}:
            return self.reply(USER)
        if path == "/api/config":
            return self.reply({"appTitle": "OpenSchool 本機合成預覽", "registrationEnabled": False,
                "emailLoginEnabled": False, "socialLoginEnabled": False,
                "openschoolReturnUrl": f"http://127.0.0.1:{self.server.server_port}/preview",
                "openschoolPromptHandoffEnabled": True, "interface": {"modelSelect": True},
                "modelSpecs": {"list": []}, "balance": {"enabled": False}})
        if path == "/api/endpoints":
            return self.reply({"OpenSchool": {"type": "custom", "titleConvo": False,
                "modelDisplayLabel": "本機預覽", "userProvide": False}})
        if path == "/api/models":
            return self.reply({"OpenSchool": ["personal", "circle-light"]})
        if path.startswith("/api/roles/"):
            return self.reply({"name": "USER", "permissions": {}})
        if path == "/api/openschool/handoff":
            Preview.handoffs += 1
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            case = cookie["preview_case"].value if "preview_case" in cookie else "success"
            if case in {"expired", "forbidden", "unavailable"}:
                return self.reply({"error": "synthetic"}, {"expired": 404, "forbidden": 403, "unavailable": 503}[case])
            prompt = "【合成預覽】請依光影觀察教材，設計兩道適合課堂討論的問答。這裡不會呼叫模型。"
            if case == "long":
                prompt += ("\n補充：保留學生原本的觀察，再引導比較早晨、正午與傍晚的影子。" * 35)
            return self.reply({"prompt": prompt, "model": "personal",
                "expiresAtUtc": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()})
        if path.startswith("/api/ask") or path.startswith("/api/agents/chat"):
            if self.command != "POST":
                return self.reply([])
            Preview.asks += 1
            return self.reply({"message": "本機版面預覽不呼叫模型。草稿僅供編輯與版面確認。"}, 400)
        if path.startswith("/api/projects"):
            return self.reply({"projects": [], "nextCursor": None})
        if path.startswith("/api/convos"):
            return self.reply({"conversations": [], "nextCursor": None})
        if path.startswith("/api/search"):
            return self.reply({"conversations": [], "messages": []})
        if path == "/api/user/settings/pinned-order":
            return self.reply([])
        if path.startswith("/api/config/") or path.startswith("/api/user/"):
            return self.reply({})
        return self.reply([])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--port", type=int, default=15412)
    args = parser.parse_args()
    assert (args.dist / "index.html").is_file(), "Build the actual client first"
    import functools
    ThreadingHTTPServer.allow_reuse_address = False
    server = ThreadingHTTPServer(("127.0.0.1", args.port), functools.partial(Preview, directory=str(args.dist.resolve())))
    print(f"Synthetic-only preview: http://127.0.0.1:{args.port}/preview", flush=True)
    server.serve_forever()
