#!/bin/sh
# =============================================================================
#  debz.sh — Debz AI Bootstrap & Service Manager
# =============================================================================
#  Usage:
#    ./debz.sh            → install dep (jika perlu) + start semua service
#    ./debz.sh start      → sama seperti di atas
#    ./debz.sh install    → install dependency aja (tanpa start)
#    ./debz.sh stop       → stop semua service
#    ./debz.sh status     → cek status semua service
#    ./debz.sh term       → jalankan CLI terminal (Debz AI)
#    ./debz.sh help       → bantuan
#
#  Setelah start, akses:
#    • WebUI  → http://127.0.0.1:8080
#    • CLI    → ketik  debz-term
# =============================================================================

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

# Konfigurasi (bisa di-override via env)
WEBUI_PORT="${WEBUI_PORT:-8080}"
TOOLS_PORT="${TOOLS_PORT:-9090}"
PW_PORT="${PW_PORT:-9222}"
HOST="${HOST:-0.0.0.0}"

LOG_DIR="$SCRIPT_DIR/logs"
VENV_DIR="$SCRIPT_DIR/venv"
VENV_PY="$VENV_DIR/bin/python"
REQ="$SCRIPT_DIR/requirements.txt"
USE_VENV=1
mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------
info()  { printf '\033[36m[i]\033[0m %s\n'   "$*"; }
ok()    { printf '\033[32m[✓]\033[0m %s\n'   "$*"; }
warn()  { printf '\033[33m[!]\033[0m %s\n'   "$*"; }
err()   { printf '\033[31m[x]\033[0m %s\n'   "$*"; }
die()   { err "$*"; exit 1; }

detect_pm() {
    # Termux: PREFIX di-set & berisi com.termux, atau ada command pkg
    if [ -n "$PREFIX" ] && printf '%s' "$PREFIX" | grep -q "com.termux"; then echo termux
    elif command -v pkg >/dev/null 2>&1; then echo termux
    elif command -v apk >/dev/null 2>&1; then echo apk
    elif command -v apt-get >/dev/null 2>&1; then echo apt
    elif command -v dnf >/dev/null 2>&1; then echo dnf
    else echo none; fi
}

is_running() { # <pattern>
    pgrep -f "$1" >/dev/null 2>&1
}

webui_up()   { curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEBUI_PORT/" 2>/dev/null; }
tools_up()   { curl -s -m 2 "http://127.0.0.1:$TOOLS_PORT/api/health" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 0) AUTO-PORT FIX untuk Termux (port < 1024 tidak bisa bind non-root)
#    Default sekarang 8080, tapi tetap guard kalau user override ke port kecil
# ---------------------------------------------------------------------------
TERMUX_SAFE_PORT="${TERMUX_SAFE_PORT:-8080}"

auto_fix_port() {
    PM=$(detect_pm)
    if [ "$PM" = "termux" ]; then
        # Termux non-root: port < 1024 gak bisa bind.
        # Juga beberapa build Termux menolak port tertentu → pastikan port aman
        if [ "$WEBUI_PORT" -lt 1024 ] 2>/dev/null; then
            OLD_PORT="$WEBUI_PORT"
            WEBUI_PORT="$TERMUX_SAFE_PORT"
            warn "Termux: port $OLD_PORT < 1024 gak bisa bind non-root — WebUI naik ke port $WEBUI_PORT"
        fi
    fi
}

# ---------------------------------------------------------------------------
# 0b) CLEAR PYTHON CACHE (__pycache__) — hindari file .pyc stale setelah git pull
# ---------------------------------------------------------------------------
clear_pycache() {
    CLEARED=0
    for d in "$SCRIPT_DIR" "$SCRIPT_DIR"/logs; do
        if [ -d "$d/__pycache__" ]; then
            rm -rf "$d/__pycache__"
            CLEARED=$((CLEARED + 1))
        fi
    done
    # Hapus .pyc files yang tersebar (max kedalaman 2)
    find "$SCRIPT_DIR" -maxdepth 2 -name "*.pyc" -delete 2>/dev/null
    if [ "$CLEARED" -gt 0 ]; then
        info "Cleared $CLEARED __pycache__ dirs"
    fi
}

# ---------------------------------------------------------------------------
# 0c) AUTO-UPDATE — pull dari GitHub kalau ada remote
# ---------------------------------------------------------------------------
auto_update() {
    if [ -d "$SCRIPT_DIR/.git" ]; then
        # Fetch untuk cek apakah ada update
        LOCAL=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null)
        REMOTE=$(git -C "$SCRIPT_DIR" rev-parse @{u} 2>/dev/null)
        if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
            info "Update tersedia — git pull..."
            git -C "$SCRIPT_DIR" pull --ff-only 2>/dev/null \
                && ok "Updated ke versi terbaru" \
                || warn "git pull gagal — lanjut dengan versi saat ini"
            clear_pycache
        fi
    fi
}

# ---------------------------------------------------------------------------
# 1a) INSTALL CUA DEPENDENCIES (Xvfb, openbox, xdotool)
# ---------------------------------------------------------------------------
install_cua_deps() {
    PM=$(detect_pm)
    CUA_PKGS=""
    case "$PM" in
        termux)
            # Termux: perlu x11-repo dulu buat akses xvfb, openbox, xdotool
            CUA_PKGS="xvfb openbox xdotool scrot"
            # Pastikan x11-repo ada
            if ! pkg list-installed 2>/dev/null | grep -q "x11-repo"; then
                info "Installing x11-repo (Termux)..."
                pkg install -y x11-repo 2>/dev/null || apt install -y x11-repo 2>/dev/null || warn "gagal install x11-repo"
            fi
            ;;
        apk)
            CUA_PKGS="xvfb openbox xdotool scrot"
            ;;
        apt)
            CUA_PKGS="xvfb openbox xdotool scrot imagemagick"
            ;;
        dnf)
            CUA_PKGS="xorg-x11-server-Xvfb openbox xdotool scrot ImageMagick"
            ;;
        none)
            warn "Package manager gak terdeteksi — skip install CUA deps"
            return 0
            ;;
    esac

    if [ -z "$CUA_PKGS" ]; then
        return 0
    fi

    # Cek mana yang belum ada
    MISSING=""
    for bin_name in Xvfb openbox xdotool scrot; do
        command -v "$bin_name" >/dev/null 2>&1 || MISSING="$MISSING $bin_name"
    done

    if [ -n "$MISSING" ]; then
        info "Installing CUA dependencies:$MISSING"
        case "$PM" in
            termux)
                pkg install -y $CUA_PKGS 2>/dev/null || apt install -y $CUA_PKGS 2>/dev/null || warn "gagal install CUA deps"
                ;;
            apk)
                apk add --no-cache $CUA_PKGS 2>/dev/null || warn "gagal install CUA deps"
                ;;
            apt)
                DEBIAN_FRONTEND=noninteractive apt-get install -y $CUA_PKGS 2>/dev/null || warn "gagal install CUA deps"
                ;;
            dnf)
                dnf install -y $CUA_PKGS 2>/dev/null || warn "gagal install CUA deps"
                ;;
        esac
        # Validasi
        if command -v Xvfb >/dev/null 2>&1; then
            ok "CUA deps terinstall (Xvfb, openbox, xdotool)"
        else
            warn "Beberapa CUA deps belum terinstall — CUA (Computer Use) mungkin gak jalan"
        fi
    else
        ok "CUA deps sudah lengkap"
    fi
}

# ---------------------------------------------------------------------------
# 1) INSTALL SYSTEM DEPENDENCIES
# ---------------------------------------------------------------------------
install_system_deps() {
    PM=$(detect_pm)
    case "$PM" in
        termux)
            # Termux: nama paket beda dari Debian/Ubuntu
            NEED="php python nodejs-lts chromium curl"
            MISSING=""
            for c in php python3 node chromium curl; do
                command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"
            done
            if [ -n "$MISSING" ]; then
                info "Menginstall package system (Termux):$MISSING"
                pkg update -y || apt update -y || die "gagal pkg update"
                pkg install -y $NEED || apt install -y $NEED || die "gagal pkg install"
            fi
            # pip (di beberapa versi Termux, pip terpisah di paket python-pip)
            if ! python3 -m pip --version >/dev/null 2>&1; then
                pkg install -y python-pip 2>/dev/null || warn "pip belum terinstall — jalankan: pkg install python-pip"
            fi
            # PHP modul (curl/session/sqlite3/json sudah built-in di paket php Termux)
            for m in curl session sqlite3 json; do
                php -m 2>/dev/null | grep -qix "$m" || warn "php-$m tidak tersedia (opsional — cek: php -m)"
            done
            # Termux single-user → tanpa venv, pip langsung ke system python
            USE_VENV=0
            ;;
        apk)
            # Alpine: PHP + Python + Node + Chromium
            NEED="php python3 py3-pip nodejs npm chromium"
            MISSING=""
            for p in php python3 node npm chromium; do
                command -v "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"
            done
            if [ -n "$MISSING" ]; then
                info "Menginstall package system (Alpine):$MISSING"
                apk add --no-cache php python3 py3-pip nodejs npm chromium || die "gagal apk add"
            fi
            # PHP modul wajib (cek via php -m)
            for m in curl session sqlite3 json; do
                php -m 2>/dev/null | grep -qix "$m" || { apk add --no-cache "php-$m" 2>/dev/null || warn "gagal install php-$m (opsional)"; }
            done
            ;;
        apt)
            NEED="php-cli php-curl php-sqlite3 python3 python3-venv nodejs npm chromium-browser"
            MISSING=""
            for c in php python3 node npm; do
                command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"
            done
            if [ -n "$MISSING" ]; then
                info "Menginstall package system (Debian/Ubuntu):"
                apt-get update -y || die "gagal apt-get update"
                DEBIAN_FRONTEND=noninteractive apt-get install -y $NEED || die "gagal apt-get install"
            fi
            ;;
        dnf)
            NEED="php-cli php-curl php-sqlite3 python3 python3-pip nodejs npm chromium"
            MISSING=""
            for c in php python3 node npm; do
                command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"
            done
            if [ -n "$MISSING" ]; then
                info "Menginstall package system (Fedora/RHEL):"
                dnf install -y $NEED || die "gagal dnf install"
            fi
            ;;
        none)
            warn "Package manager tidak terdeteksi — pastikan php, python3, node sudah terinstall manual."
            ;;
    esac

    # Validasi minimal
    command -v php >/dev/null 2>&1   || die "PHP tidak terinstall"
    command -v python3 >/dev/null 2>&1 || die "Python3 tidak terinstall"
    command -v node >/dev/null 2>&1  || warn "Node tidak terinstall — browser daemon dinonaktifkan"
    ok "System dependencies OK"
}

# ---------------------------------------------------------------------------
# 2) PYTHON VENV + DEPENDENCIES
# ---------------------------------------------------------------------------
install_python_deps() {
    REQ_MODS="flask flask_sock requests rich prompt_toolkit"

    # Mode tanpa venv (Termux): pakai python system langsung
    if [ "$USE_VENV" = "0" ]; then
        VENV_PY="$(command -v python3)"
        if "$VENV_PY" -c "import flask, flask_sock, requests, rich, prompt_toolkit" 2>/dev/null; then
            ok "Python dependencies sudah lengkap"
            return 0
        fi
        info "Install Python dependencies via pip (system python)..."
        "$VENV_PY" -m pip install -q -r "$REQ" 2>/dev/null || warn "pip install gagal — pastikan koneksi internet"
        "$VENV_PY" -c "import flask, flask_sock, requests, rich, prompt_toolkit" 2>/dev/null \
            || die "Dependency Python tidak lengkap. Jalankan: $VENV_PY -m pip install -r $REQ"
        ok "Python dependencies OK"
        return 0
    fi

    if [ ! -x "$VENV_PY" ]; then
        info "Membuat virtualenv Python (--system-site-packages)..."
        python3 -m venv --system-site-packages "$VENV_DIR" || die "gagal buat venv"
    fi

    # Cepat: cek apakah semua modul sudah tersedia (di venv / system-site-packages)
    if "$VENV_PY" -c "import flask, flask_sock, requests, rich, prompt_toolkit" 2>/dev/null; then
        ok "Python dependencies sudah lengkap"
        return 0
    fi

    # Kalau venv lama dibuat tanpa system-site-packages (tidak lengkap) → recreate
    if ! "$VENV_PY" -c "import flask" 2>/dev/null; then
        warn "venv lama tidak lengkap — recreate dengan --system-site-packages"
        rm -rf "$VENV_DIR"
        python3 -m venv --system-site-packages "$VENV_DIR" || die "gagal recreate venv"
        if "$VENV_PY" -c "import flask, flask_sock, requests, rich, prompt_toolkit" 2>/dev/null; then
            ok "Python dependencies lengkap (via system)"
            return 0
        fi
    fi

    # Install dependencies via pip
    info "Install Python dependencies via pip..."
    "$VENV_PY" -m pip install -q -r "$REQ" 2>/dev/null || true
    "$VENV_PY" -m pip install -q flask-cors requests 2>/dev/null || true
    
    "$VENV_PY" -c "import flask, flask_sock, requests, rich, prompt_toolkit, flask_cors" 2>/dev/null \
        || die "Dependency Python tidak lengkap. Jalankan: $VENV_PY -m pip install flask-cors requests"
    ok "Python dependencies OK"
}

# ---------------------------------------------------------------------------
# 3) PLAYWRIGHT (browser daemon, opsional)
# ---------------------------------------------------------------------------
install_playwright() {
    if ! command -v node >/dev/null 2>&1; then
        warn "Node tidak ada — browser daemon dilewati"
        return 0
    fi
    if npm ls -g playwright >/dev/null 2>&1; then
        ok "Playwright sudah terinstall"
    else
        info "Install playwright (global)..."
        npm install -g playwright 2>/dev/null && ok "Playwright OK" || warn "gagal install playwright (opsional)"
    fi
    # Chromium untuk playwright
    if command -v chromium >/dev/null 2>&1; then
        CHROMIUM_BIN=$(command -v chromium)
        [ -x /usr/bin/chromium-browser ] && CHROMIUM_BIN=/usr/bin/chromium-browser
        export CHROMIUM_BIN
    fi
}

# ---------------------------------------------------------------------------
# 3b) ENSURE CONFIG (buat dari example kalau belum ada)
# ---------------------------------------------------------------------------
ensure_config() {
    if [ ! -f "$SCRIPT_DIR/.ai-providers.json" ] && [ -f "$SCRIPT_DIR/.ai-providers.example" ]; then
        cp "$SCRIPT_DIR/.ai-providers.example" "$SCRIPT_DIR/.ai-providers.json"
        warn ".ai-providers.json dibuat dari template — atur API key & model di WebUI ⚙️"
    fi
    if [ ! -f "$SCRIPT_DIR/.ai-config.ini" ] && [ -f "$SCRIPT_DIR/.ai-config.example" ]; then
        cp "$SCRIPT_DIR/.ai-config.example" "$SCRIPT_DIR/.ai-config.ini"
        warn ".ai-config.ini dibuat dari template — isi AI_API_KEY & AI_TOOLS_TOKEN"
    fi
    if [ -f "$SCRIPT_DIR/.ai-config.ini" ] && ! grep -q "AI_TOOLS_TOKEN=" "$SCRIPT_DIR/.ai-config.ini"; then
        warn ".ai-config.ini tidak punya AI_TOOLS_TOKEN — tambahkan manual atau pakai WebUI ⚙️"
    fi
}

# ---------------------------------------------------------------------------
# 4) SETUP COMMAND debz-term
# ---------------------------------------------------------------------------
setup_cli_cmd() {
    chmod +x "$SCRIPT_DIR/debz-term" "$SCRIPT_DIR/debz-term.py" "$SCRIPT_DIR/debz.sh" "$SCRIPT_DIR/pw_daemon.sh" 2>/dev/null || true

    # Pilih direktori yang benar-benar ada di PATH
    # (prioritas: $PREFIX/bin untuk Termux, lalu /usr/local/bin, /usr/bin, ~/.local/bin)
    BIN_DIR=""
    for d in "$PREFIX/bin" /usr/local/bin /usr/bin "$HOME/.local/bin"; do
        case ":$PATH:" in
            *":$d:"*) BIN_DIR="$d"; break ;;
        esac
    done
    [ -z "$BIN_DIR" ] && BIN_DIR="${PREFIX:-/usr/local}/bin"
    mkdir -p "$BIN_DIR" 2>/dev/null || true

    # Replace command lama yang masih hardcode path (biar portabel)
    if [ -f /usr/bin/debz-term ] && grep -q "root/debz_ai" /usr/bin/debz-term 2>/dev/null; then
        rm -f /usr/bin/debz-term
        warn "Command debz-term lama (hardcoded) dihapus — diganti versi portabel"
    fi

    if [ -L "$BIN_DIR/debz-term" ] && [ "$(readlink -f "$BIN_DIR/debz-term")" = "$SCRIPT_DIR/debz-term" ]; then
        ok "Command 'debz-term' siap"
    else
        ln -sf "$SCRIPT_DIR/debz-term" "$BIN_DIR/debz-term" 2>/dev/null \
            && ok "Command 'debz-term' dipasang → $BIN_DIR/debz-term" \
            || warn "Gagal symlink $BIN_DIR/debz-term (butuh root/sudo)"
    fi
}

# ---------------------------------------------------------------------------
# 5) START SERVICES
# ---------------------------------------------------------------------------
start_services() {
    # --- Tool server (backend.py, Flask) ---
    if is_running "backend.py"; then
        ok "Tool server sudah jalan (port $TOOLS_PORT)"
    else
        info "Start tool server (backend.py) di port $TOOLS_PORT..."
        setsid sh -c "nohup '$VENV_PY' '$SCRIPT_DIR/backend.py' >> '$LOG_DIR/backend.log' 2>&1 &" < /dev/null
        sleep 2
        if tools_up; then ok "Tool server aktif → http://127.0.0.1:$TOOLS_PORT"
        else warn "Tool server belum merespon — cek $LOG_DIR/backend.log"; fi
    fi

    # --- WebUI (PHP built-in server) ---
    if is_running "php -S .*:$WEBUI_PORT"; then
        ok "WebUI sudah jalan (port $WEBUI_PORT)"
    else
        info "Start WebUI (php -S) di port $WEBUI_PORT..."
        setsid sh -c "nohup php -S $HOST:$WEBUI_PORT -t '$SCRIPT_DIR' >> '$LOG_DIR/webui.log' 2>&1 &" < /dev/null
        sleep 1
        if [ "$(webui_up)" = "200" ] || [ "$(webui_up)" = "302" ]; then
            ok "WebUI aktif → http://127.0.0.1:$WEBUI_PORT"
        else
            warn "WebUI belum merespon — cek $LOG_DIR/webui.log"
        fi
    fi

    # --- Browser daemon (opsional) ---
    if command -v node >/dev/null 2>&1 && npm ls -g playwright >/dev/null 2>&1; then
        if is_running "pw_daemon.mjs"; then
            ok "Browser daemon sudah jalan (port $PW_PORT)"
        else
            info "Start browser daemon (port $PW_PORT)..."
            "$SCRIPT_DIR/pw_daemon.sh" start >/dev/null 2>&1 || true
            sleep 2
            "$SCRIPT_DIR/pw_daemon.sh" status | sed 's/^/    /'
        fi
    else
        warn "Browser daemon dilewati (butuh node + playwright)"
    fi
}

# ---------------------------------------------------------------------------
# 6) STOP
# ---------------------------------------------------------------------------
stop_services() {
    info "Menghentikan semua service..."
    pkill -f "backend.py" 2>/dev/null && ok "Tool server di-stop" || warn "Tool server tidak berjalan"
    pkill -f "php -S .*:$WEBUI_PORT" 2>/dev/null && ok "WebUI di-stop" || warn "WebUI tidak berjalan"
    pkill -f "pw_daemon.mjs" 2>/dev/null && ok "Browser daemon di-stop" || warn "Browser daemon tidak berjalan"
    ok "Semua service berhenti"
}

# ---------------------------------------------------------------------------
# 7) STATUS
# ---------------------------------------------------------------------------
status() {
    printf '\n  \033[36m═══ Status Debz AI ═══\033[0m\n\n'
    # WebUI
    code=$(webui_up)
    if [ "$code" = "200" ] || [ "$code" = "302" ]; then
        printf '  \033[32m[✓]\033[0m WebUI        → http://127.0.0.1:%s  (HTTP %s)\n' "$WEBUI_PORT" "$code"
    else
        printf '  \033[31m[x]\033[0m WebUI        → port %s  (mati)\n' "$WEBUI_PORT"
    fi
    # Tool server
    if tools_up; then
        printf '  \033[32m[✓]\033[0m Tool server  → http://127.0.0.1:%s  (healthy)\n' "$TOOLS_PORT"
    else
        printf '  \033[31m[x]\033[0m Tool server  → port %s  (mati)\n' "$TOOLS_PORT"
    fi
    # CLI command
    if command -v debz-term >/dev/null 2>&1; then
        printf '  \033[32m[✓]\033[0m CLI command   → debz-term  (tersedia)\n'
    else
        printf '  \033[31m[x]\033[0m CLI command   → debz-term  (belum terpasang — jalankan ./debz.sh)\n'
    fi
    # Browser daemon
    if curl -s -m 2 "http://127.0.0.1:$PW_PORT/json/version" >/dev/null 2>&1; then
        printf '  \033[32m[✓]\033[0m Browser daemon → port %s  (aktif)\n' "$PW_PORT"
    else
        printf '  \033[31m[x]\033[0m Browser daemon → port %s  (mati/opsional)\n' "$PW_PORT"
    fi
    # CUA status
    if command -v Xvfb >/dev/null 2>&1 && command -v xdotool >/dev/null 2>&1; then
        printf '  \033[32m[✓]\033[0m CUA (CUA)    → deps lengkap (Xvfb + xdotool)\n'
    else
        printf '  \033[33m[!]\033[0m CUA (CUA)    → deps belum lengkap (opsional)\n'
    fi
    # Config
    if [ -f "$SCRIPT_DIR/.ai-providers.json" ]; then
        printf '  \033[32m[✓]\033[0m Config        → .ai-providers.json (atur API key & model di WebUI ⚙️)\n'
    else
        printf '  \033[33m[!]\033[0m Config        → .ai-providers.json belum ada\n'
    fi
    printf '\n'
}

# ---------------------------------------------------------------------------
# SUCCESS BANNER
# ---------------------------------------------------------------------------
success_banner() {
    printf '\n'
    printf '  \033[32m  ┌─────────────────────────────────────────────────────┐\033[0m\n'
    printf '  \033[32m  │  ✅  Debz AI berhasil dijalankan!                    │\033[0m\n'
    printf '  \033[32m  └─────────────────────────────────────────────────────┘\033[0m\n'
    printf '\n'
    printf '  \033[36m  🌐 WebUI\033[0m      → \033[1mhttp://127.0.0.1:%s\033[0m\n' "$WEBUI_PORT"
    printf '  \033[36m  💻 CLI\033[0m        → ketik \033[1mdebz-term\033[0m\n'
    printf '  \033[36m  ⚙️  Konfigurasi\033[0m → API key & model diatur lewat WebUI (tombol ⚙️ Settings)\n'
    printf '  \033[36m  🛠️  Tool server\033[0m → http://127.0.0.1:%s\n' "$TOOLS_PORT"
    printf '\n'
    printf '  \033[90m  Cek status: ./debz.sh status    |    Stop: ./debz.sh stop\033[0m\n'
    printf '\n'
}

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
auto_fix_port

case "${1:-start}" in
    install)
        ensure_config
        clear_pycache
        install_system_deps
        install_cua_deps
        install_python_deps
        install_playwright
        setup_cli_cmd
        ok "Installasi selesai. Jalankan ./debz.sh untuk mulai."
        ;;
    start)
        ensure_config
        clear_pycache
        auto_update
        install_system_deps
        install_cua_deps
        install_python_deps
        install_playwright
        setup_cli_cmd
        start_services
        success_banner
        ;;
    stop)
        stop_services
        ;;
    status)
        status
        ;;
    term)
        shift
        exec "$SCRIPT_DIR/debz-term" "$@"
        ;;
    help|-h|--help)
        sed -n '2,14p' "$0"
        ;;
    *)
        err "Perintah tidak dikenal: $1"
        sed -n '2,14p' "$0"
        exit 1
        ;;
esac
