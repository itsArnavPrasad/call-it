"""A stand-in for the Telegram Bot API, for end-to-end tests of call-it.

It answers the methods call-it uses, logs every message the bot sends to
LOG (one JSON line each, voice notes saved beside it), and plays the phone:
REPLY=allow presses the first button of a message that has buttons,
REPLY=<path to .ogg> answers it with that voice note instead.

    REPLY=allow LOG=/tmp/tg.jsonl python3 test/fake_telegram.py 8765
"""

import json
import os
import sys
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHAT = 42
LOG = os.environ.get("LOG", "/tmp/fake-telegram.jsonl")
REPLY = os.environ.get("REPLY", "allow")
updates, next_msg, next_update = [], [100], [1]


def queue(update):
    update["update_id"] = next_update[0]
    next_update[0] += 1
    updates.append(update)


def fields(handler):
    body = handler.rfile.read(int(handler.headers.get("content-length", 0)))
    kind = handler.headers.get("content-type", "")
    if kind.startswith("multipart/"):
        msg = BytesParser(policy=default).parsebytes(b"content-type: " + kind.encode() + b"\r\n\r\n" + body)
        out = {}
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition")
            raw = part.get_payload(decode=True)
            out[name] = raw if part.get_filename() else raw.decode("utf-8")
        return out
    return json.loads(body or b"{}")


def phone_answers(msg_id, markup):
    if not markup:
        return
    markup = json.loads(markup) if isinstance(markup, str) else markup
    if REPLY == "allow":
        data = markup["inline_keyboard"][0][0]["callback_data"]
        queue({"callback_query": {"id": "cb", "data": data, "message": {"message_id": msg_id, "chat": {"id": CHAT}}}})
    elif REPLY.endswith(".ogg"):
        queue({"message": {"message_id": 900 + msg_id, "chat": {"id": CHAT}, "voice": {"file_id": "reply"}, "reply_to_message": {"message_id": msg_id}}})


class Bot(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, result, raw=None):
        body = raw if raw is not None else json.dumps({"ok": True, "result": result}).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if "/file/" in self.path:
            with open(REPLY, "rb") as f:
                return self.reply(None, f.read())
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        method = self.path.rsplit("/", 1)[-1]
        f = fields(self)
        if method == "getMe":
            return self.reply({"id": 1, "is_bot": True, "username": "callit_test_bot"})
        if method == "getUpdates":
            ready = [u for u in updates if u["update_id"] >= int(f.get("offset", 0))]
            updates[:] = ready
            return self.reply(ready)
        if method == "getFile":
            return self.reply({"file_id": f["file_id"], "file_path": "voice/reply.oga"})
        if method in ("sendMessage", "sendVoice"):
            msg_id = next_msg[0]
            next_msg[0] += 1
            entry = {"method": method, "message_id": msg_id}
            for k, v in f.items():
                if isinstance(v, bytes):
                    path = f"{LOG}.{msg_id}.ogg"
                    with open(path, "wb") as out:
                        out.write(v)
                    entry[k] = path
                else:
                    entry[k] = v
            with open(LOG, "a") as out:
                out.write(json.dumps(entry, ensure_ascii=False) + "\n")
            phone_answers(msg_id, f.get("reply_markup"))
            return self.reply({"message_id": msg_id, "chat": {"id": CHAT}})
        return self.reply(True)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8765), Bot).serve_forever()
