#!/bin/sh
# pw_daemon.sh — start/stop browser daemon persistent (CDP-native, tanpa playwright)
# Usage: pw_daemon.sh [start|stop|status]
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DAEMON="$SCRIPT_DIR/pw_daemon.mjs"
LOG="$SCRIPT_DIR/logs/pw_daemon.log"
PORT="${PW_PORT:-9222}"

# pastikan dir log ada
mkdir -p "$SCRIPT_DIR/logs" 2>/dev/null || true

start() {
  if curl -s -m 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "daemon sudah jalan di port $PORT"
    return 0
  fi
  setsid sh -c "nohup node $DAEMON start >> $LOG 2>&1 &" < /dev/null
  echo "daemon di-start, port $PORT (log: $LOG)"
}

stop() {
  pkill -f "pw_daemon.mjs" 2>/dev/null
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  echo "daemon di-stop"
}

status() {
  if curl -s -m 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "daemon AKTIF di port $PORT"
  else
    echo "daemon MATI"
  fi
}

case "$1" in
  stop) stop ;;
  status) status ;;
  *) start ;;
esac
