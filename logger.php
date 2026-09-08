<?php
// c0n73xt Logger — analisis error pemakaian
// Tulis ke logs/app-YYYYMMDD.log (auto rotate harian).
// Folder logs/ HARUS writable www-data. File .log diblokir dari web (.htaccess).

function applog($tag, $msg, $ctx = []) {
    static $dir = null;
    if ($dir === null) $dir = __DIR__ . '/logs';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $file = $dir . '/app-' . date('Ymd') . '.log';
    $ip = $_SERVER['REMOTE_ADDR'] ?? '-';
    $ua = isset($_SERVER['HTTP_USER_AGENT']) ? substr($_SERVER['HTTP_USER_AGENT'], 0, 80) : '-';
    $ctxStr = '';
    if ($ctx) {
        $j = json_encode($ctx, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (is_string($j)) $ctxStr = ' ' . substr($j, 0, 600);
    }
    $line = sprintf("[%s] [%s] [%s] %s |%s%s\n", date('H:i:s.v'), $_SERVER['REQUEST_METHOD'] ?? '-', $tag, $msg, $ip, $ctxStr);
    @file_put_contents($file, $line, FILE_APPEND | LOCK_EX);
    return true;
}

// Bersihin log lama (> 14 hari) — dipanggil kadang aja (probabilistik biar hemat)
function applog_rotate() {
    if (random_int(1, 200) !== 1) return;
    $dir = __DIR__ . '/logs';
    foreach (glob($dir . '/app-*.log') ?: [] as $f) {
        $m = [];
        if (preg_match('/app-(\d{8})\.log$/', $f, $m) && isset($m[1])) {
            if (strtotime($m[1]) < time() - 14 * 86400) @unlink($f);
        }
    }
}

if (realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'] ?? '')) {
    http_response_code(403);
    exit('no direct access');
}
