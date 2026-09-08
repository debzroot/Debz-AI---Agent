<?php
// c0n73xt Provider Registry — multi endpoint AI + routing (fixed / round-robin / failover)
// Storage: .ai-providers.json (di folder ini, diblokir dari web via .htaccess)
// Format:
// {
//   "active": "debz",
//   "routing": "fixed|roundrobin|failover",
//   "providers": {
//     "id": {"name":..., "base_url":..., "api_key":..., "model":..., "mode": "agent|native|chat", "enabled": true, "models": [...]}
//   }
// }
// mode:
//   native = agent loop di api.php: OpenAI tools + tool server :8000 (Debz_AI mandiri)
//   agent  = runs API legacy (disimpan buat kompatibilitas, gak dipakai default)
//   chat   = plain chat/completions streaming, tanpa tools
// routing:
//   fixed       = cuma provider "active" (perilaku lama)
//   roundrobin  = ganti provider tiap request (dari pool enabled) + failover kalau error
//   failover    = mulai dari provider aktif, kalau error pindah ke enabled berikutnya

function providers_file() { return __DIR__ . '/.ai-providers.json'; }
function providers_rr_state_file() { return __DIR__ . '/.ai-rr-state.json'; }

function providers_defaults() {
    return [
        'active' => 'debz',
        'routing' => 'fixed',
        'providers' => [
            'debz' => [
                'name' => 'Debz Combo (20128)',
                'base_url' => 'http://127.0.0.1:20128/v1',
                'api_key' => '',
                'model' => 'debz_ai',
                'mode' => 'native',
                'enabled' => true
            ]
        ]
    ];
}

function providers_load() {
    $f = providers_file();
    if (file_exists($f)) {
        $d = json_decode((string)file_get_contents($f), true);
        if (is_array($d) && isset($d['providers']) && is_array($d['providers']) && $d['providers']) {
            return $d;
        }
    }
    return providers_defaults();
}

function providers_save($data) {
    $ok = file_put_contents(providers_file(), json_encode($data, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE));
    if ($ok === false) {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'gak bisa nulis .ai-providers.json — cek permission (chown www-data)']);
        exit;
    }
    return true;
}

// Routing mode valid: fixed | roundrobin | failover
function providers_routing($data) {
    $r = (string)($data['routing'] ?? 'fixed');
    return in_array($r, ['fixed', 'roundrobin', 'failover'], true) ? $r : 'fixed';
}

// Daftar id provider yang enabled (urutan sesuai config)
function providers_enabled_ids($data) {
    $ids = [];
    foreach (($data['providers'] ?? []) as $id => $p) {
        if (($p['enabled'] ?? true) === true) $ids[] = $id;
    }
    return $ids;
}

// ROUND-ROBIN: pilih provider berikutnya dari pool enabled. State index disimpan
// di .ai-rr-state.json biar rotasi persist antar request (bukan reset tiap hit).
function providers_rr_pick($data) {
    $pool = providers_enabled_ids($data);
    if (!$pool) return '';
    $f = providers_rr_state_file();
    $st = [];
    if (is_file($f)) {
        $st = json_decode((string)@file_get_contents($f), true);
        if (!is_array($st)) $st = [];
    }
    $idx = ((int)($st['idx'] ?? 0)) % count($pool);
    $st['idx'] = $idx + 1;
    @file_put_contents($f, json_encode($st));
    return $pool[$idx];
}

function providers_mask($data) {
    // buat dikirim ke browser: key gak full dikirim
    $out = ['active' => $data['active'] ?? '', 'routing' => providers_routing($data), 'providers' => []];
    foreach (($data['providers'] ?? []) as $id => $p) {
        $k = (string)($p['api_key'] ?? '');
        $ms = isset($p['models']) && is_array($p['models']) ? array_values($p['models']) : [];
        $out['providers'][$id] = [
            'name' => $p['name'] ?? $id,
            'base_url' => $p['base_url'] ?? '',
            'model' => $p['model'] ?? '',
            'mode' => $p['mode'] ?? 'chat',
            'enabled' => (bool)($p['enabled'] ?? true),
            'key_hint' => $k === '' ? '' : (substr($k, 0, 6) . '…' . substr($k, -4)),
            'has_key' => $k !== '',
            'extra' => isset($p['extra']) && is_array($p['extra']) ? $p['extra'] : [],
            'models' => array_slice($ms, 0, 400),
            'models_count' => count($ms)
        ];
    }
    return $out;
}

// FETCH list model dari provider (OpenAI-compatible GET {base}/models).
// UA policy sama kayak agent.php: OpenRouter butuh UA harness + header atribusi.
// Return ['error' => '', 'models' => [...]] atau ['error' => '...', 'models' => []]
function providers_fetch_models($baseUrl, $apiKey, $ua = '') {
    $baseUrl = trim((string)$baseUrl);
    if (!preg_match('#^https?://#i', $baseUrl)) return ['error' => 'base_url invalid', 'models' => []];
    $headers = ['Authorization: Bearer ' . (string)$apiKey];
    $isOR = stripos($baseUrl, 'openrouter.ai') !== false;
    if ($ua === '' && $isOR) $ua = 'opencode/1.0 (linux; x64)';
    if ($ua !== '') $headers[] = 'User-Agent: ' . $ua;
    if ($isOR) {
        $headers[] = 'HTTP-Referer: https://c0n73xt.app';
        $headers[] = 'X-Title: c0n73xt WebUX';
    }
    $ch = curl_init(rtrim($baseUrl, '/') . '/models');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 25,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0
    ]);
    $raw = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    if ($raw === false) return ['error' => 'unreachable: ' . $err, 'models' => []];
    $dec = json_decode($raw, true);
    $ids = [];
    if (is_array($dec) && isset($dec['data']) && is_array($dec['data'])) {
        foreach ($dec['data'] as $m) {
            if (!empty($m['id']) && is_string($m['id'])) $ids[] = $m['id'];
        }
    }
    $ids = array_values(array_unique($ids));
    if ($http >= 400) return ['error' => 'HTTP ' . $http . (isset($dec['error']['message']) ? ' — ' . $dec['error']['message'] : ''), 'models' => $ids];
    if (!$ids) return ['error' => 'gak ada model di response', 'models' => []];
    return ['error' => '', 'models' => $ids];
}

// Fetch + simpan list model ke config provider. Return hasil fetch.
function providers_refresh_models(&$PROVIDERS, $id) {
    if (!isset($PROVIDERS['providers'][$id])) return ['error' => 'provider gak ada', 'models' => []];
    $p = $PROVIDERS['providers'][$id];
    $ua = '';
    if (isset($p['extra']['user_agent']) && is_string($p['extra']['user_agent'])) $ua = $p['extra']['user_agent'];
    $r = providers_fetch_models($p['base_url'] ?? '', $p['api_key'] ?? '', $ua);
    if ($r['error'] === '' && $r['models']) {
        $PROVIDERS['providers'][$id]['models'] = $r['models'];
        providers_save($PROVIDERS);
    }
    return $r;
}

// === CRUD via api.php ?action=providers ===
// Dipanggil dari api.php (bukan standalone — tapi aman kalau kebuka langsung? gak, exit dulu)
if (realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'] ?? '')) {
    http_response_code(403);
    exit('no direct access');
}

return true;
