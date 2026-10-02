#!/bin/sh
# End to end: a real `claude -p` with this plugin, talking to a fake Telegram.
#   1. Claude asks to run a command; the "phone" taps Allow; it runs; a "done" voice note follows.
#   2. Claude asks again; the "phone" says "No, don't do that" by voice; whisper hears it; it's denied.
# Needs claude, python3, say, ffmpeg, whisper-cli and the speech model in ~/.claude/call-it/models.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE=${CLAUDE:-claude}
W=$(mktemp -d)
PORT=8765
fail() { echo "FAIL: $*"; exit 1; }

run_case() { # name reply prompt
  mkdir -p "$W/$1/models"
  ln -sf ~/.claude/call-it/models/ggml-base.bin "$W/$1/models/"
  echo '{"token":"1:test","chatId":42,"connectAll":true}' > "$W/$1/config.json"
  REPLY=$2 LOG="$W/$1.jsonl" python3 "$ROOT/test/fake_telegram.py" $PORT &
  pid=$!
  sleep 1
  CALLIT_API=http://127.0.0.1:$PORT CALLIT_DIR="$W/$1" "$CLAUDE" -p --plugin-dir "$ROOT" --permission-mode default "$3" || true
  kill $pid
}

run_case allow allow "Use the Bash tool to run exactly this command: echo callit-ok > $W/allow.txt  Then reply with the single word: done"
[ "$(cat "$W/allow.txt" 2>/dev/null)" = callit-ok ] || fail "allowed command did not run"
grep -q "🔐 @" "$W/allow.jsonl" || fail "no permission prompt (with intact emoji) reached the phone"
grep '"sendVoice"' "$W/allow.jsonl" | grep -q 'is done' || fail "no done voice note"
ffprobe -v error -show_entries stream=codec_name -of csv=p=0 "$(ls "$W"/allow.jsonl.*.ogg | head -1)" | grep -q opus || fail "voice note is not opus"
echo "ok: tap Allow on the phone -> command runs -> done voice note"

say -o "$W/no.aiff" "No, don't do that."
ffmpeg -y -loglevel error -i "$W/no.aiff" -c:a libopus "$W/no.ogg"
run_case deny "$W/no.ogg" "Use the Bash tool to run exactly this command: echo callit-bad > $W/deny.txt  If it is denied, reply with the single word: stopped"
[ ! -e "$W/deny.txt" ] || fail "denied command ran anyway"
grep -qi "don't do that" "$W/deny.jsonl" || fail "voice reply was not transcribed"
echo "ok: say 'no' by voice -> whisper hears it -> command denied"

echo "PASS ($W)"
