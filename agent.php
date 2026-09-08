<?php
require_once __DIR__ . "/agent-helpers.php";
// c0n73xt Native Agent Loop — jantung Debz_AI (mandiri, multi-provider)
// ===================================================
// Dipanggil dari api.php pas provider mode=native.
// Kontrak: fungsi native_agent_run($P, ...) — P = config provider aktif.
// Stream ke UI pakai emit()/emitDone() dari api.php.
//
// Loop: chat/completions (stream) -> kalau tool_calls -> eksekusi di tool server
// (:8000) -> append hasil -> ulang. Max iterasi & timeout dijaga.

// [uagate-20260906-0729] UA gate OpenRouter: alias "opencode-compat" kena 403
// "agentic harnesses only". UA harus format harness bener "name/version".
function debz_ua_ok($ua) {
    if (stripos($ua, 'compat') !== false) return false;
    return (bool)preg_match('#^[A-Za-z0-9._-]+/\d#', $ua);
}

function native_tool_definitions() {
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'shell',
                'description' => 'Jalankan command shell di server. Untuk cek sistem, install, git, network, dsb. Output dibatasi, kalau butuh file spesifik pakai tool lain.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'command' => ['type' => 'string', 'description' => 'Command shell lengkap'],
                        'cwd' => ['type' => 'string', 'description' => 'Working directory (default /root/ChatUX)'],
                    ],
                    'required' => ['command']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'read_file',
                'description' => 'Baca isi file teks.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'path' => ['type' => 'string']
                    ],
                    'required' => ['path']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'write_file',
                'description' => 'Tulis/replace isi file (buat file baru kalau belum ada).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'path' => ['type' => 'string'],
                        'content' => ['type' => 'string']
                    ],
                    'required' => ['path', 'content']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'list_dir',
                'description' => 'List isi folder.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'path' => ['type' => 'string']
                    ],
                    'required' => ['path']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'search',
                'description' => 'Cari file by nama (regex) atau isi file. Return daftar path.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'pattern' => ['type' => 'string', 'description' => 'Regex'],
                        'path' => ['type' => 'string', 'description' => 'Folder search (default /root/ChatUX)'],
                        'content' => ['type' => 'boolean', 'description' => 'true = cari di isi file, false = nama file']
                    ],
                    'required' => ['pattern']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'http_request',
                'description' => 'Fetch URL / panggil API (GET/POST/PUT/DELETE). Buat riset web, akses API luar, cek status, dsb. Body dibatasi ~256KB.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'url' => ['type' => 'string'],
                        'method' => ['type' => 'string', 'enum' => ['GET', 'POST', 'PUT', 'DELETE'], 'description' => 'default GET'],
                        'headers' => ['type' => 'object', 'description' => 'header tambahan (opsional)'],
                        'body' => ['type' => 'string', 'description' => 'request body (opsional)'],
                        'timeout' => ['type' => 'integer', 'description' => 'detik, max 60'],
                    ],
                    'required' => ['url']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'download_file',
                'description' => 'Download file dari URL ke path lokal. Buat ambil gambar, APK, dataset, dll.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'url' => ['type' => 'string'],
                        'path' => ['type' => 'string', 'description' => 'path tujuan HARUS kasih nama file, misal /root/x.zip'],
                        'max_mb' => ['type' => 'integer', 'description' => 'batas ukuran MB, default 200'],
                    ],
                    'required' => ['url', 'path']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'db_query',
                'description' => 'Query SQLite (SELECT/INSERT/UPDATE/DELETE). Buat nyimpen data terstruktur, kalender, tracking, dll.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'db_path' => ['type' => 'string', 'description' => 'path file .db/.sqlite'],
                        'sql' => ['type' => 'string'],
                        'params' => ['type' => 'array', 'description' => 'parameter query (opsional)'],
                    ],
                    'required' => ['db_path', 'sql']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'archive',
                'description' => 'Buat atau ekstrak arsip zip/tar/tar.gz. action create (perlu files) atau extract (perlu target_dir).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'action' => ['type' => 'string', 'enum' => ['create', 'extract']],
                        'archive_path' => ['type' => 'string'],
                        'files' => ['type' => 'array', 'description' => '(create) daftar path file/folder'],
                        'target_dir' => ['type' => 'string', 'description' => '(extract) folder tujuan'],
                    ],
                    'required' => ['action', 'archive_path']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'process_list',
                'description' => 'List proses yang berjalan. Bisa difilter pakai pattern (nama/pid).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'pattern' => ['type' => 'string', 'description' => 'filter substring (opsional)'],
                    ],
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'process_kill',
                'description' => 'Kill proses by pid atau nama (pattern). signal default 15 (SIGTERM), pilihan 1/2/9/15.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'pid' => ['type' => 'integer'],
                        'pattern' => ['type' => 'string'],
                        'signal' => ['type' => 'integer'],
                    ],
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'note',
                'description' => 'Memori persisten AI ke notes.db. action: list/get/add/delete/search. Buat nyimpen fakta/keputusan antar sesi.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'action' => ['type' => 'string', 'enum' => ['list', 'get', 'add', 'delete', 'search']],
                        'key' => ['type' => 'string', 'description' => 'nama unik note (buat add/get/delete)'],
                        'content' => ['type' => 'string', 'description' => 'isi note (buat add)'],
                        'pattern' => ['type' => 'string', 'description' => 'keyword cari (buat search)'],
                    ],
                    'required' => ['action']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'app_install',
                'description' => 'Manajemen package via apk/pkg: search / install / remove / update / installed. Buat nambahin tools ke sistem.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'action' => ['type' => 'string', 'enum' => ['search', 'install', 'remove', 'update', 'installed']],
                        'package' => ['type' => 'string', 'description' => 'nama paket (buat search/install/remove)'],
                    ],
                    'required' => ['action']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'computer_use',
                'description' => 'Kendali komputer via layar virtual (CUA driver): lihat screenshot, klik, ketik, scroll, drag, buka URL di browser. Gunakan screenshot dulu buat liat layar, tentuin koordinat, baru aksi.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'action' => ['type' => 'string', 'enum' => ['status', 'screenshot', 'open', 'launch', 'click', 'dblclick', 'rightclick', 'move', 'drag', 'type', 'key', 'scroll', 'meta'], 'description' => 'aksi yang mau dijalankan; screenshot buat liat layar dulu'],
                        'url' => ['type' => 'string', 'description' => '(open) URL yang dibuka di browser virtual'],
                        'cmd' => ['type' => 'string', 'description' => '(launch) command program di layar virtual'],
                        'x' => ['type' => 'integer', 'description' => '(click/dblclick/rightclick/move) koordinat X'],
                        'y' => ['type' => 'integer', 'description' => '(click/dblclick/rightclick/move) koordinat Y'],
                        'button' => ['type' => 'integer', 'description' => '(click/drag) 1=kiri, 2=tengah, 3=kanan; default 1'],
                        'x1' => ['type' => 'integer', 'description' => '(drag) X awal'],
                        'y1' => ['type' => 'integer', 'description' => '(drag) Y awal'],
                        'x2' => ['type' => 'integer', 'description' => '(drag) X akhir'],
                        'y2' => ['type' => 'integer', 'description' => '(drag) Y akhir'],
                        'duration' => ['type' => 'number', 'description' => '(drag) durasi detik, default 0.3'],
                        'text' => ['type' => 'string', 'description' => '(type) teks yang diketik'],
                        'key' => ['type' => 'string', 'description' => '(key) hotkey, contoh: ctrl+c, Return, alt+Tab'],
                        'dx' => ['type' => 'integer', 'description' => '(scroll) horizontal, negatif=kanan'],
                        'dy' => ['type' => 'integer', 'description' => '(scroll) 1=turun 0, -1=naik; default 1'],
                        'times' => ['type' => 'integer', 'description' => '(scroll) berapa kali scroll, max 20'],
                    ],
                    'required' => ['action']
                ]
            ]
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'browser',
                'description' => 'Browser automation Playwright + Chromium headless (daemon persistent port 9222): buka URL, baca konten, klik elemen, isi form, screenshot, jalanin JS. Cocok buat test frontend & ambil data halaman. Command: goto|content|text|title|screenshot|click|type|press|wait|eval|close. State browser kebawa antar step (daemon), jadi bisa buka -> klik -> isi -> cek -> screenshot berurutan.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'command' => ['type' => 'string', 'enum' => ['goto', 'content', 'text', 'title', 'screenshot', 'click', 'type', 'press', 'wait', 'eval', 'close'], 'description' => 'aksi yang mau dijalankan'],
                        'url' => ['type' => 'string', 'description' => '(goto) URL tujuan, contoh https://example.com'],
                        'selector' => ['type' => 'string', 'description' => '(click/type) CSS selector elemen, contoh button.login atau input#search'],
                        'text' => ['type' => 'string', 'description' => '(type) teks untuk diisi ke input'],
                        'key' => ['type' => 'string', 'description' => '(press) tombol, contoh Enter / Tab / Backspace'],
                        'path' => ['type' => 'string', 'description' => '(screenshot) path PNG tujuan, default screenshots/browser_shot.png'],
                        'js' => ['type' => 'string', 'description' => '(eval) kode JavaScript yang dijalankan di halaman'],
                        'ms' => ['type' => 'integer', 'description' => '(wait) jeda milidetik, default 1000'],
                        'index' => ['type' => 'integer', 'description' => '(click) index elemen kalau selector match banyak, default 0'],
                    ],
                    'required' => ['command']
                ]
            ]
        ]

    ];
}

// Bawa nama tool UI -> endpoint tool server
function native_tool_endpoint($name) {
    static $map = [
        'shell' => 'exec',
        'read_file' => 'fs_read',
        'write_file' => 'fs_write',
        'list_dir' => 'fs_list',
        'search' => 'fs_search',
        'http_request' => 'http',
        'download_file' => 'download',
        'db_query' => 'db',
        'archive' => 'archive',
        'process_list' => 'ps',
        'process_kill' => 'kill',
        'note' => 'note',
        'app_install' => 'pkg',
        'computer_use' => 'cua',
        'browser' => 'browser',
    ];
    return $map[$name] ?? null;
}

function native_tools_token() {
    $f = __DIR__ . '/.ai-config.ini';
    if (file_exists($f)) {
        foreach (file($f, FILE_IGNORE_NEW_LINES|FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if (strpos($line, 'AI_TOOLS_TOKEN') === 0 && ($p = strpos($line, '=')) !== false) {
                return trim(substr($line, $p + 1));
            }
        }
    }
    return '';
}

// Panggil tool server. Return [ok(bool), data(array)]
function native_call_tool($endpoint, $args, &$approvalInfo = null) {
    $base = 'http://127.0.0.1:9090/api/' . $endpoint;
    $token = native_tools_token();
    $payload = array_merge(['token' => $token], $args);

    $ch = curl_init($base);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 620, // tool server sendiri max 600
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
        // [patch h11] HTTP/2 upload putus di jaringan ini (SSL_EOF 56) → force 1.1
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
    ]);
    $raw = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);

    if ($raw === false) {
        return [false, ['error' => 'tool server unreachable: ' . $err]];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return [false, ['error' => 'tool server response aneh: ' . substr($raw, 0, 200)]];
    }
    if ($http === 202 && !empty($data['need_approval'])) {
        $approvalInfo = $data;
        return [false, $data];
    }
    if ($http >= 400) {
        return [false, $data];
    }
    return [true, $data];
}

// Ambil thought_signature dari tool_call delta (format apapun), normalisasi ke
// bentuk yang diterima Gemini OpenAI-compat: {"google":{"thought_signature":...}}.
// Kenapa: model thinking Gemini nyertain signature tiap function call; kalau hasil
// tool dibalikin TANPA signature → HTTP 400 "Function call is missing a
// thought_signature in functionCall parts". Signature harus di-round-trip persis.
// Return array signature, atau null kalau gak ada.
function native_extract_tc_sig($tc) {
    if (!is_array($tc)) return null;
    // 1. Format resmi Gemini OpenAI-compat: extra_content.google.thought_signature
    if (isset($tc['extra_content']) && is_array($tc['extra_content'])) {
        $ec = $tc['extra_content'];
        if (isset($ec['google']) && is_array($ec['google']) && !empty($ec['google']['thought_signature'])) {
            return ['google' => ['thought_signature' => $ec['google']['thought_signature']]];
        }
        if (!empty($ec['thought_signature'])) {
            return ['google' => ['thought_signature' => $ec['thought_signature']]];
        }
    }
    // 2. Flat langsung di objek tool_call (beberapa router pake ini)
    if (!empty($tc['thought_signature'])) {
        return ['google' => ['thought_signature' => $tc['thought_signature']]];
    }
    // 3. Numpang di dalem objek function
    if (isset($tc['function']) && is_array($tc['function'])) {
        $f = $tc['function'];
        if (!empty($f['thought_signature'])) {
            return ['google' => ['thought_signature' => $f['thought_signature']]];
        }
        if (isset($f['extra_content']) && is_array($f['extra_content']) && !empty($f['extra_content']['thought_signature'])) {
            return ['google' => ['thought_signature' => $f['extra_content']['thought_signature']]];
        }
    }
    return null;
}

// === Reasoning-details helpers (round-trip lintas turn & antar tool-iter) ===
// Buang reasoning_details dari semua message (provider strict-schema gak nerima field asing).
function native_strip_rd($messages) {
    $out = [];
    foreach ($messages as $m) {
        if (!is_array($m)) continue;
        unset($m['reasoning_details']);
        $out[] = $m;
    }
    return $out;
}
function native_has_rd($messages) {
    foreach ($messages as $m) {
        if (is_array($m) && !empty($m['reasoning_details']) && is_array($m['reasoning_details'])) return true;
    }
    return false;
}
// Rapikan RD dari client (UI) — cuma field yang dikenal, type wajib.
function native_clean_rd($items) {
    $out = [];
    foreach ((array)$items as $rd) {
        if (!is_array($rd)) continue;
        $item = ['type' => (string)($rd['type'] ?? 'reasoning.text')];
        if (isset($rd['text']) && is_string($rd['text']) && $rd['text'] !== '') $item['text'] = $rd['text'];
        if (isset($rd['data']) && is_string($rd['data']) && $rd['data'] !== '') $item['data'] = $rd['data'];
        if (isset($rd['format']) && is_string($rd['format']) && $rd['format'] !== '') $item['format'] = $rd['format'];
        if (isset($rd['index'])) $item['index'] = (int)$rd['index'];
        if (isset($item['text']) || isset($item['data'])) $out[] = $item;
    }
    return $out;
}

// Streaming chat/completions ke provider, sambil collect tool_calls & konten.
// Return array: [content, reasoning, toolCalls[], usage, finish_reason, error]
// Wrapper: retry otomatis buat error TRANSIENT (blip jaringan Wi-Fi/lite, koneksi
// ke-reset server, 5xx). Error NON-transient (4xx, key salah, payload) gak diretry.
// $opts: optional — ['reasoning_effort' => 'none'|'low'|'medium'|'high', ...] dst.
function native_chat_once($baseUrl, $apiKey, $model, $messages, $tools, $maxTokens, $opts = []) {
    $attempt = 0;
    $stripRD = !empty($opts['strip_reasoning_details']); // force-strip per provider config
    while (true) {
        $sendMsgs = $stripRD ? native_strip_rd($messages) : $messages;
        $r = native_chat_once_raw($baseUrl, $apiKey, $model, $sendMsgs, $tools, $maxTokens, $opts);
        // Provider strict (gak kenal reasoning_details) → HTTP 400. Strip sekali & retry —
        // kalau masih 400 berarti beneran payload-nya salah, bukan gara2 RD.
        if ($r['error'] !== '' && !$stripRD && native_has_rd($messages)
            && stripos($r['error'], 'HTTP 400') !== false && $r['content'] === '' && $r['reasoning'] === '') {
            $stripRD = true;
            if (function_exists('emit')) emit(['type' => 'terminal', 'kind' => 'info', 'line' => '🧹 provider nolak reasoning_details — dibersihin & retry']);
            if (function_exists('applog')) applog('AGENT', '400 dgn reasoning_details di history → strip & retry', ['err' => substr($r['error'], 0, 200)]);
            continue;
        }
        if ($r['error'] === '') return $r;

        $errTxt = $r['error'];
        // 429 = rate limit → retry (provider free emang ketat, jeda agak lama)
        // 5xx / timeout / koneksi / DNS → transient, retry.
        // 4xx lain (400/401/403/404/422) → salah payload/key/model → JANGAN retry.
        $isTransient = (stripos($errTxt, 'cURL error') === 0)
            || (stripos($errTxt, 'HTTP 5') !== false && stripos($errTxt, 'HTTP 5') < 12)
            || (stripos($errTxt, 'HTTP 429') !== false);
        if (!$isTransient) return $r;
        // Udah dapat sebagian konten → jangan retry (bisa dobel konten ke user)
        if ($r['content'] !== '' || $r['reasoning'] !== '') return $r;

        $attempt++;
        $maxRetry = isset($opts['_maxRetry']) ? max(1, (int)$opts['_maxRetry']) : native_config_int('AI_NET_RETRY', 3);
        if ($attempt > $maxRetry) return $r;
        $backoff = min(1000 * pow(2, $attempt - 1), 8000); // 1s, 2s, 4s, cap 8s
        if (stripos($errTxt, 'HTTP 429') !== false) $backoff = max($backoff, 15000); // 429: hormati rate limit
        emit(['type' => 'terminal', 'kind' => 'info', 'line' => '🔁 jaringan/provider lagi ngadat — retry #' . $attempt . '/' . $maxRetry . ' dalam ' . ($backoff / 1000) . 's (' . native_trunc($errTxt, 80) . ')']);
        usleep($backoff * 1000);
    }
}

// Lapis transport + parser stream. SATU attempt, tanpa retry.
function native_chat_once_raw($baseUrl, $apiKey, $model, $messages, $tools, $maxTokens, $opts = []) {
    $url = rtrim($baseUrl, '/') . '/chat/completions';
    $payload = [
        'model' => $model,
        'messages' => $messages,
        'stream' => true,
        'stream_options' => ['include_usage' => true],
    ];
    if (!empty($tools)) $payload['tools'] = $tools;
    if ($maxTokens > 0) $payload['max_tokens'] = $maxTokens;
    // Extra options per-provider (dari .ai-providers.json "extra"): reasoning_effort, temperature, dst.
    // Yang penting: reasoning_effort=none buat matiin model reasoning (nemotron dll) —
    // tanpa ini model reasoning nge-stream "reasoning" doang dan konten kosong/nyampur.
    if (is_array($opts)) {
        // reasoning nested {enabled:bool} = format KHUSUS OpenRouter thinking models.
        // Kalau bocor ke provider lain (tokenrouter/kilo/zen/dll) = field asing di body
        // → bisa 400, diabaikan, atau perilaku ngaco (jawaban kosong/flood). Filter di sini.
        $isOR = stripos($baseUrl, 'openrouter.ai') !== false;
        foreach ($opts as $k => $v) {
            if ($v === '' || $v === null) continue;
            // key policy transport — jangan bocor ke body request provider
            if ($k === 'user_agent' || $k === 'headers' || $k === 'strip_reasoning_details' || $k === '_maxRetry') continue;
            if ($k === 'reasoning' && is_array($v) && !$isOR) continue; // PATCH: reasoning nested hanya OpenRouter
            $payload[$k] = $v;
        }
    }

    // === UA & header policy (multi-provider) ===
    // Beberapa provider nge-gate User-Agent (OpenRouter "agentic harnesses only"
    // buat model :free tertentu — UA default libcurl/php ditolak 403).
    // - extra.user_agent → UA custom per-provider (.ai-providers.json)
    // - openrouter.ai tanpa override → UA harness agent (opencode-compatible)
    // - extra.headers {Name: value} → header tambahan (HTTP-Referer, X-Title, dst)
    $uaPolicy = '';
    $extraHeaders = [];
    if (is_array($opts)) {
        if (isset($opts['user_agent']) && is_string($opts['user_agent']) && $opts['user_agent'] !== '') $uaPolicy = $opts['user_agent'];
        if (isset($opts['headers']) && is_array($opts['headers'])) {
            foreach ($opts['headers'] as $hn => $hv) {
                if (is_string($hn) && $hn !== '' && is_string($hv) && $hv !== '') $extraHeaders[] = $hn . ': ' . $hv;
            }
        }
    }
    $isOR = stripos($baseUrl, 'openrouter.ai') !== false;
    if ($uaPolicy === '' && $isOR) $uaPolicy = 'opencode/1.0 (linux; x64)';
    // [uagate-20260906-0729] UA custom harus lolos whitelist harness, kalau gak → fallback
    if ($uaPolicy !== '' && !debz_ua_ok($uaPolicy)) $uaPolicy = 'opencode/1.0 (linux; x64)';
    $chatHeaders = [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json',
        'Accept: text/event-stream'
    ];
    if ($isOR) { // atribusi standar OpenRouter
        $chatHeaders[] = 'HTTP-Referer: https://c0n73xt.app';
        $chatHeaders[] = 'X-Title: c0n73xt WebUX';
    }
    foreach ($extraHeaders as $eh) $chatHeaders[] = $eh;
    if ($uaPolicy !== '') array_unshift($chatHeaders, 'User-Agent: ' . $uaPolicy);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $chatHeaders,
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_CONNECTTIMEOUT => 15, // Wi-Fi blip: gagal cepet, biar retry wrapper yang urus
        CURLOPT_TIMEOUT => 0,
        // Watchdog stream mati: kalau <1 byte/detik selama AI_STALL_TIMEOUT (default 90s)
        // → curl abort (errno 28 "Operation too slow") → wrapper retry. Tanpa ini, koneksi
        // kegantung tanpa RST bisa nunggu sampe max_execution_time (3600s!).
        CURLOPT_LOW_SPEED_LIMIT => 1,
        CURLOPT_LOW_SPEED_TIME => native_config_int('AI_STALL_TIMEOUT', 90),
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
        // [patch h11] HTTP/2 upload putus di jaringan ini (SSL_EOF 56) → force 1.1
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
    ]);

    $result = ['content' => '', 'reasoning' => '', 'reasoningDetails' => [], 'toolCalls' => [], 'usage' => null, 'finish_reason' => '', 'error' => '', 'http_code' => 0];
    $rawBuf = '';
    $pendingTool = []; // index -> {id, name, args}

    // FIX: buffer baris SSE sebelum parse. Chunk curl TIDAK dijamin utuh per baris —
    // kepotong di tengah JSON bikin json_decode gagal & potongan teks HILANG (teks rusak/acak).
    $lineBuf = '';
    $pendingRD = []; // index -> reasoning_details merged {type, text, data, format, index}
    $processLine = function($line) use (&$result, &$pendingTool, &$pendingRD) {
            $line = trim($line);
            if ($line === '' || strncmp($line, 'data:', 5) !== 0) return;
            $json = trim(substr($line, 5));
            if ($json === '' || $json === '[DONE]') return;
            $obj = json_decode($json, true);
            if (!is_array($obj)) return;

            $choice = $obj['choices'][0] ?? null;
            if (!$choice) {
                if (isset($obj['usage']) && $obj['usage']) $result['usage'] = $obj['usage'];
                return; // (closure, bukan loop — pake return)
            }
            if (!empty($choice['finish_reason'])) $result['finish_reason'] = $choice['finish_reason'];
            $d = $choice['delta'] ?? null;
            if (!is_array($d)) return;

            // reasoning stream (progress "mikir") — 2 format: reasoning_content (deepseek dll) & reasoning (openrouter)
            if (!empty($d['reasoning_content']) && is_string($d['reasoning_content'])) {
                $result['reasoning'] .= $d['reasoning_content'];
            } elseif (!empty($d['reasoning']) && is_string($d['reasoning'])) {
                $result['reasoning'] .= $d['reasoning'];
            }
            // konten
            if (!empty($d['content']) && is_string($d['content'])) {
                $result['content'] .= $d['content'];
            }
            // reasoning_details (OpenRouter thinking models: inkling, z-ai GLM, dst) —
            // struktur resmi buat ROUND-TRIP: [{type:"reasoning.text"|"reasoning.encrypted",
            // text|data, format, index}]. Dateng per delta, text/data di-append antar delta.
            if (!empty($d['reasoning_details']) && is_array($d['reasoning_details'])) {
                foreach ($d['reasoning_details'] as $rd) {
                    if (!is_array($rd)) continue;
                    $rdIdx = (int)($rd['index'] ?? 0);
                    if (!isset($pendingRD[$rdIdx])) $pendingRD[$rdIdx] = ['type' => 'reasoning.text', 'text' => '', 'data' => '', 'format' => '', 'index' => $rdIdx];
                    if (!empty($rd['type'])) $pendingRD[$rdIdx]['type'] = $rd['type'];
                    if (!empty($rd['format'])) $pendingRD[$rdIdx]['format'] = $rd['format'];
                    if (isset($rd['text']) && is_string($rd['text'])) $pendingRD[$rdIdx]['text'] .= $rd['text'];
                    if (isset($rd['data']) && is_string($rd['data'])) $pendingRD[$rdIdx]['data'] .= $rd['data'];
                }
            }
            // tool_calls delta
            if (!empty($d['tool_calls']) && is_array($d['tool_calls'])) {
                foreach ($d['tool_calls'] as $tc) {
                    $idx = (int)($tc['index'] ?? 0);
                    if (!isset($pendingTool[$idx])) $pendingTool[$idx] = ['id' => '', 'name' => '', 'args' => '', 'sig' => null];
                    if (!empty($tc['id'])) $pendingTool[$idx]['id'] = $tc['id'];
                    if (!empty($tc['function']['name'])) $pendingTool[$idx]['name'] = $tc['function']['name'];
                    if (isset($tc['function']['arguments'])) $pendingTool[$idx]['args'] .= $tc['function']['arguments'];
                    // thought_signature (Gemini thinking models): muncul sekali, biasanya di
                    // delta pertama. Simpen yang paling baru yang gak null.
                    $sig = native_extract_tc_sig($tc);
                    if ($sig !== null) $pendingTool[$idx]['sig'] = $sig;
                }
            }
            if (!empty($obj['usage']) && is_array($obj['usage'])) $result['usage'] = $obj['usage'];
    };
    $write = function($curl, $chunk) use (&$lineBuf, $processLine) {
        $lineBuf .= $chunk;
        // pecah per baris; baris TERAKHIR (belum ketemu \n) tetap di buffer
        while (($nl = strpos($lineBuf, "\n")) !== false) {
            $line = substr($lineBuf, 0, $nl);
            $lineBuf = substr($lineBuf, $nl + 1);
            $processLine($line);
        }
        return strlen($chunk);
    };
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, $write);

    // [DEBZ PATCH] Simpan raw buffer untuk flush di akhir
    $rawBuf = $lineBuf; // alias supaya kelihatan jelas
    $raw = curl_exec($ch);
    $errno = curl_errno($ch);
    $error = curl_error($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $result['http_code'] = $httpCode;

    // [DEBZ PATCH] Flush sisa line buffer kalau stream putus tanpa newline
    if (isset($lineBuf) && $lineBuf !== '') {
        $processLine($lineBuf);
        $lineBuf = '';
        if (function_exists('applog')) applog('AGENT', 'chat_once flushed trailing chunk', ['len' => strlen($rawBuf)]);
    }


    if ($raw === false && $errno !== 0) {
        $result['error'] = 'cURL error: ' . $error;
        if (function_exists('applog')) applog('AGENT', 'chat_once cURL error', ['errno' => $errno, 'err' => substr($error, 0, 200)]);
    } elseif ($httpCode >= 400) {
        $errBody = '';
        $j = json_decode($rawBuf, true);
        if (is_array($j)) {
            $e = $j['error'] ?? ($j['message'] ?? null);
            if (is_string($e)) $errBody = $e;
            elseif (is_array($e)) $errBody = (string)($e['message'] ?? json_encode($e, JSON_UNESCAPED_UNICODE));
            elseif ($e === null && isset($j['detail']) && is_string($j['detail'])) $errBody = $j['detail'];
        }
        if ($errBody === '') $errBody = trim(native_trunc((string)$rawBuf, 200));
        $result['error'] = 'HTTP ' . $httpCode . ($errBody !== '' ? ' — ' . $errBody : '');
        if ($httpCode === 429) $result['error'] .= ' (rate limit / quota)';
        if (function_exists('applog')) applog('AGENT', 'chat_once HTTP ' . $httpCode, ['body' => substr($rawBuf, 0, 200)]);
    }
    foreach ($pendingTool as $pt) {
        if ($pt['name'] !== '') $result['toolCalls'][] = $pt;
    }
    // reasoning_details final: buang item kosong, urut index
    $rdOut = [];
    foreach ($pendingRD as $rIdx => $rdi) {
        if ($rdi['text'] === '' && $rdi['data'] === '') continue;
        $item = ['type' => $rdi['type'], 'index' => (int)$rIdx];
        if ($rdi['text'] !== '') $item['text'] = $rdi['text'];
        if ($rdi['data'] !== '') $item['data'] = $rdi['data'];
        if ($rdi['format'] !== '') $item['format'] = $rdi['format'];
        $rdOut[] = $item;
    }
    if ($rdOut) $result['reasoningDetails'] = $rdOut;
    return $result;
}

// === MAIN LOOP ===
// Emit event ke UI pakai format yang udah dikenal JS.
// Emit baris ke terminal live modal (console >_ di UI).
function termEmit($kind, $text) {
    emit(['type' => 'terminal', 'kind' => $kind, 'line' => $text]);
}

function native_agent_run($P, $messagesIn, $maxTokens, $userText, $toolsOn = true, $providerChain = [], $PROVIDERS = null, $allowSessionIn = false) {
    $baseUrl = $P['base_url'];
    $apiKey = $P['api_key'] ?? ''; // provider free bisa tanpa key
    $model = $P['model'];
    // extra opts per-provider (contoh: {"reasoning_effort":"none"}) — ke-apply ke tiap request
    $extraOpts = isset($P['extra']) && is_array($P['extra']) ? $P['extra'] : [];

    // Approval policy: session (per chat request / tab) & always (persist via file flag)
    $allowSession = $allowSessionIn === true;
    $allowAlways = native_allow_all_get();

    // Susun messages: system prompt agent + history + user
    $toolsNote = $toolsOn
        ? "Lu punya TOOLS beneran: shell, read_file, write_file, list_dir, search — dieksekusi di server langsung. "
          . "Untuk tugas teknis/automation: GUNAKAN TOOLS, jangan ngarang. Sertakan output nyata. "
        : "Mode chat biasa (tools OFF) di sesi ini.";
    $sysPrompt = $userText !== ''
        ? "Lu adalah Debz AI — agent yang jalan di c0n73xt WebUX. Bahasa gaul Indonesia (gue/lu). "
        . $toolsNote
        . "Format jawaban: markdown rapih, code block pakai label bahasa. Jawab santai tapi akurat."
        : "Lu adalah Debz AI di c0n73xt WebUX. Bahasa gaul Indonesia (gue/lu).";

    $chatMessages = [['role' => 'system', 'content' => $sysPrompt]];
    foreach ($messagesIn as $m) {
        if (!is_array($m) || empty($m['role'])) continue;
        $role = $m['role'] === 'assistant' ? 'assistant' : ($m['role'] === 'system' ? 'system' : 'user');
        $content = isset($m['content']) && is_string($m['content']) ? $m['content'] : '';
        if ($role === 'system') {
            $chatMessages[0]['content'] .= "\n" . $content;
            continue;
        }
        if ($role === 'assistant' && $content !== '' && !empty($m['reasoning_details']) && is_array($m['reasoning_details'])) {
            // Round-trip reasoning_details (OpenRouter thinking models): assistant
            // message boleh bawa reasoning_details turn sebelumnya — model lanjut
            // mikir dari bekas reasoning, gak mulai dari nol. (content wajib ada —
            // assistant kosong bikin provider strict nolak payload.)
            $rdClean = native_clean_rd($m['reasoning_details']);
            if ($rdClean) {
                $chatMessages[] = ['role' => 'assistant', 'content' => $content, 'reasoning_details' => $rdClean];
                continue;
            }
        }
        if ($content === '') continue;
        $chatMessages[] = ['role' => $role, 'content' => $content];
    }
    if ($userText !== '') {
        $chatMessages[] = ['role' => 'user', 'content' => $userText];
    }

    $tools = $toolsOn ? native_tool_definitions() : [];
    $MAX_ITER = native_config_int("AI_MAX_ITER", 40);
    emit(['type' => 'terminal', 'kind' => 'info', 'line' => '▶ agent start · model ' . $P['model'] . ' · tools ' . ($toolsOn ? 'ON' : 'OFF') . ' · iter maks ' . $MAX_ITER]);
    $finalContent = '';
    $totalUsage = ['input_tokens' => 0, 'output_tokens' => 0, 'total_tokens' => 0];

    // FAILOVER FAST: pas ada chain cadangan, retry internal dikurangi jadi 1
    // biar pindah provider lebih cepet (429 beruntun = jangan ngabisin 45s retry).
    $baseRetry = native_config_int('AI_NET_RETRY', 3);
    $optsFO = $extraOpts;
    if (!empty($providerChain)) $optsFO['_maxRetry'] = 1;

    // [DEBZ PATCH] Anti-flood: deteksi tool call yang berulang
    $lastCallSig = '';
    $repeatCount = 0;
    $MAX_REPEAT = native_config_int('AI_MAX_REPEAT', 100);

    for ($iter = 0; $iter < $MAX_ITER; $iter++) {
        emit(['type' => 'status', 'phase' => 'thinking', 'iter' => $iter + 1]);
        emit(['type' => 'terminal', 'kind' => 'think', 'line' => '🧠 iter ' . ($iter + 1) . ' — mikir...']);
        $r = native_chat_once($baseUrl, $apiKey, $model, $chatMessages, $tools, $maxTokens, $optsFO);

        // [DEBZ PATCH] Cek tool call signature untuk anti-flood
        $curSig = '';
        if (!empty($r['toolCalls']) && is_array($r['toolCalls'])) {
            $sigParts = [];
            foreach ($r['toolCalls'] as $tc) {
                $sigParts[] = ($tc['name'] ?? '?') . ':' . substr((string)($tc['arguments'] ?? ''), 0, 200);
            }
            $curSig = md5(implode('|', $sigParts));
        }
        if ($curSig !== '' && $curSig === $lastCallSig) {
            $repeatCount++;
            if ($repeatCount >= $MAX_REPEAT) {
                if (function_exists('applog')) applog('AGENT', 'FLOOD detected — same tool call repeated', ['iter' => $iter + 1, 'sig' => $curSig]);
                emit(['choices' => [['delta' => ['content' => "\n\n⚠️ **Agent loop terdeteksi** (tool call yang sama diulang {$MAX_REPEAT}x). Distop untuk mencegah flood.\n\nCoba perbaiki instruksi atau gunakan tools yang berbeda.\n"]]]]);
                emit(['type' => 'terminal', 'kind' => 'limit', 'line' => '⚠️ FLOOD STOP — tool call berulang ' . $MAX_REPEAT . 'x']);
                emitDone();
                return;
            }
        } elseif ($curSig !== '') {
            $repeatCount = 0;
        }
        if ($curSig !== '') $lastCallSig = $curSig;

        if ($r['error'] !== '') {
            if (function_exists('applog')) applog('AGENT', 'provider error iter ' . $iter, ['err' => substr($r['error'], 0, 300), 'finish' => $r['finish_reason'] ?: '-', 'content_len' => strlen($r['content']), 'reasoning_len' => strlen($r['reasoning'])]);
            $errTxt = (string)$r['error'];
            $isLimit = (stripos($errTxt, '429') !== false || stripos($errTxt, 'rate') !== false || stripos($errTxt, 'quota') !== false || stripos($errTxt, 'limit') !== false);
            if ($isLimit) {
                emit(['type' => 'terminal', 'kind' => 'limit', 'line' => '😫 429 LIMIT / QUOTA — ' . native_trunc($errTxt, 140)]);
            } else {
                emit(['type' => 'terminal', 'kind' => 'error', 'line' => '⚠️ provider error — ' . native_trunc($errTxt, 140)]);
            }
            // === FAILOVER: error sebelum konten final ke-stream → coba provider cadangan ===
            // [Patch iter-n] dulu cuma iter-0. Sekarang SEMUA iter bisa failover — asal konten final
            // belum ke-stream (finalContent masih kosong). Jadi stall/error di tengah tool-loop
            // (iter >= 1) juga otomatis pindah provider, gak nongolin error mentah ke chat.
            // Error 400/401 (key/payload salah) tetep gak di-failover — muter2 doang.
            if (!empty($providerChain) && is_array($PROVIDERS) && $finalContent === '') {
                $failoverWorthy = $isLimit
                    || (stripos($errTxt, 'HTTP 5') !== false)
                    || (stripos($errTxt, 'cURL error') === 0)
                    || (stripos($errTxt, 'timeout') !== false);
                if ($failoverWorthy) {
                    foreach ($providerChain as $fcid) {
                        $fp = $PROVIDERS['providers'][$fcid] ?? null;
                        if (!is_array($fp)) continue;
                        emit(['type' => 'terminal', 'kind' => 'info', 'line' => '🔄 FAILOVER: "' . (string)($P['name'] ?? 'utama') . '" error — pindah ke "' . (string)($fp['name'] ?? $fcid) . '" (' . (string)($fp['model'] ?? '?') . ')']);
                        if (function_exists('applog')) applog('AGENT', 'failover iter0 → ' . $fcid, ['err' => substr($errTxt, 0, 200)]);
                        // swap seluruh konfigurasi transport ke provider cadangan
                        $baseUrl = (string)($fp['base_url'] ?? '');
                        $apiKey = (string)($fp['api_key'] ?? '');
                        $model = (string)($fp['model'] ?? '');
                        $extraOpts = isset($fp['extra']) && is_array($fp['extra']) ? $fp['extra'] : [];
                        $P = $fp + ['name' => $fcid];
                        emit(['type' => 'terminal', 'kind' => 'info', 'line' => '▶ lanjut agent di cadangan · model ' . $model]);
                        // ulang iterasi ini di provider baru (jangan increment iter — masih iter 0)
                        $r = native_chat_once($baseUrl, $apiKey, $model, $chatMessages, $tools, $maxTokens, $optsFO);
                        if ($r['error'] === '') {
                            if ($isLimit) emit(['type' => 'terminal', 'kind' => 'ok', 'line' => '✅ FAILOVER sukses — provider cadangan ngerespon']);
                            continue 2; // lanjut pipeline normal (reasoning → konten → tool calls)
                        }
                        // cadangan juga error → coba cadangan berikutnya
                        emit(['type' => 'terminal', 'kind' => 'error', 'line' => '⚠️ cadangan "' . (string)($fp['name'] ?? $fcid) . '" juga error — ' . native_trunc((string)$r['error'], 90)]);
                        if (function_exists('applog')) applog('AGENT', 'failover ' . $fcid . ' juga gagal', ['err' => substr((string)$r['error'], 0, 150)]);
                    }
                    // SEMUA cadangan gagal → tampilin error final
                    emit(['choices' => [['delta' => ['content' => "\n\n😫 **Semua provider gagal.** Error terakhir: " . native_trunc($errTxt, 200)]]]]);
                    emitDone();
                    return;
                }
            }
            emit(['status' => '⚠️ Error: ' . native_trunc($errTxt, 70), 'progress' => '⚠️ Error: ' . native_trunc($errTxt, 70), 'emoji' => '⚠️']);
            emit(['choices' => [['delta' => ['content' => "\n\n" . ($isLimit ? "😫 **429 LIMIT QUOTA:** " : "⚠️ **Provider error:** ") . $r['error']]]]]);
            emitDone();
            return;
        }

        // Stream kosong? (gak ada konten & gak ada tool call) -> retry sampai 2x
        // (model router kadang balikin kosong — reasoning doang, atau malah bener2 kosong)
        if ($r['content'] === '' && empty($r['toolCalls']) && $r['finish_reason'] !== 'tool_calls') {
            $emptyRetries = isset($emptyRetries) ? $emptyRetries : 0;
            if ($emptyRetries < 2) {
                $emptyRetries++;
                if (function_exists('applog')) applog('AGENT', 'empty content retry #' . $emptyRetries, ['reasoning_len' => strlen($r['reasoning']), 'finish' => $r['finish_reason'] ?: '-', 'usage_total' => $r['usage']['total_tokens'] ?? 0]);
                emit(['type' => 'terminal', 'kind' => 'info', 'line' => '🔄 balasan kosong — pancing ulang #' . $emptyRetries]);
                // Kasih "pancingan": konteks user udah ada, suruh jawab eksplisit
                $chatMessages[] = ['role' => 'user', 'content' => $emptyRetries === 1
                    ? 'Jawab sekarang dengan teks lengkap. Jangan cuma reasoning.'
                    : 'JAWAB PERTANYAAN TERAKHIR. Output jawaban final lu sekarang juga dalam teks biasa.'];
                continue;
            }
            if (function_exists('applog')) applog('AGENT', 'empty content ABAIKAN setelah 2x retry', ['reasoning_len' => strlen($r['reasoning'])]);
        }

        if ($r['reasoning'] !== '') {
            // reasoning = proses mikir internal — TIDAK dicampur ke konten.
            // Kirim status ringkas + terminal (kolapsible), bukan ke konten chat.
            $rLen = mb_strlen($r['reasoning']);
            emit(['type' => 'terminal', 'kind' => 'think', 'line' => '💭 model mikir (' . $rLen . ' chars) — reasoning internal, gak ditampilkan biar teks bersih']);
        }

        // reasoning_details (structured, round-trippable) — beda dari "reasoning" text:
        // ke UI jadi event khusus (kolapsible 💭), DAN di-attach ke assistant message
        // internal supaya iter tool berikutnya masih inget jalur mikirnya.
        $rdItems = !empty($r['reasoningDetails']) && is_array($r['reasoningDetails']) ? $r['reasoningDetails'] : [];
        if ($rdItems) {
            $rdLen = 0;
            foreach ($rdItems as $rdi) $rdLen += mb_strlen($rdi['text'] ?? '') + strlen($rdi['data'] ?? '');
            emit(['type' => 'reasoning', 'items' => $rdItems, 'iter' => $iter + 1]);
            emit(['type' => 'terminal', 'kind' => 'think', 'line' => '🧠 reasoning_details · ' . count($rdItems) . ' item · ' . $rdLen . ' chars — di-round-trip ke history']);
        }

        if ($r['content'] !== '') {
            emit(['type' => 'status', 'phase' => 'writing']);
            emit(['type' => 'terminal', 'kind' => 'write', 'line' => '✍️ nulis jawaban · ' . strlen($r['content']) . ' chars']);
            emit(['choices' => [['delta' => ['content' => $r['content']]]]]);
            $finalContent .= $r['content'];
        }

        if (!empty($r['usage'])) {
            $u = $r['usage'];
            $totalUsage['input_tokens'] += (int)($u['prompt_tokens'] ?? $u['input_tokens'] ?? 0);
            $totalUsage['output_tokens'] += (int)($u['completion_tokens'] ?? $u['output_tokens'] ?? 0);
            $totalUsage['total_tokens'] += (int)($u['total_tokens'] ?? 0);
        }

        // Kadar tool calls?
        if (empty($r['toolCalls'])) {
            // [DEBZ PATCH] Fake completion detection: kalau content kosong & gak ada tool → jangan pura-pura selesai
            $finalTrim = trim((string)$finalContent);
            if ($finalTrim === '') {
                if (function_exists('applog')) applog('AGENT', 'FAKE_COMPLETION detected — empty content, no tool calls', ['iter' => $iter, 'reasoning_len' => strlen((string)($r['reasoning'] ?? '')), 'finish' => $r['finish_reason'] ?? '-']);
                emit(['choices' => [['delta' => ['content' => "\n\n⚠️ **Model tidak menghasilkan jawaban** (hanya reasoning tanpa konten final).\n\nCoba ulangi pertanyaan atau pilih model lain.\n"]]]]);
                emit(['type' => 'terminal', 'kind' => 'error', 'line' => '⚠️ FAKE COMPLETION — content kosong di iter ' . ($iter + 1)]);
                emitDone();
                return;
            }
            // selesai — jawaban final
            if (function_exists('applog')) applog('AGENT', 'run selesai', ['iter' => $iter, 'content_len' => strlen($finalContent), 'tools_used' => $iter > 0]);
            emit(['type' => 'terminal', 'kind' => 'ok', 'line' => '✔ selesai · ' . ($iter + 1) . ' iterasi · ' . $totalUsage['total_tokens'] . ' tokens total']);
            if ($totalUsage['total_tokens'] > 0) {
                emit(['type' => 'usage'] + $totalUsage);
            }
            emitDone();
            return;
        }

        // Ada tool calls -> eksekusi satu-satu
        // Stabilkan call ID dulu: dipake di assistant tool_calls msg DAN di tool result
        // msg — keduanya HARUS identik. (Sebelumnya uniqid() dipanggil 2x di tempat
        // beda → ID beda buat provider yang gak ngirim id → mismatch tool_call_id.)
        $callIds = [];
        foreach ($r['toolCalls'] as $i => $tc) {
            $callIds[$i] = $tc['id'] !== '' ? $tc['id'] : 'call_' . $i . '_' . uniqid();
        }

        $assistantMsg = [
            'role' => 'assistant',
            'content' => $r['content'] !== '' ? $r['content'] : null,
            'tool_calls' => array_map(function($i, $tc) use ($callIds) {
                $tcMsg = [
                    'id' => $callIds[$i],
                    'type' => 'function',
                    'function' => ['name' => $tc['name'], 'arguments' => $tc['args'] !== '' ? $tc['args'] : '{}']
                ];
                // Round-trip thought_signature (Gemini thinking models). Kalau provider
                // gak pernah ngirim signature, field ini gak ditambahin sama sekali —
                // jadi provider lain gak kena field asing.
                if (!empty($tc['sig'])) $tcMsg['extra_content'] = $tc['sig'];
                return $tcMsg;
            }, array_keys($r['toolCalls']), $r['toolCalls'])
        ];
        // Round-trip reasoning_details di tool-call turn (thinking models)
        if ($rdItems) $assistantMsg['reasoning_details'] = $rdItems;
        $chatMessages[] = $assistantMsg;

        foreach ($r['toolCalls'] as $i => $tc) {
            $callId = $callIds[$i];
            $args = json_decode($tc['args'] !== '' ? $tc['args'] : '{}', true);
            if (!is_array($args)) $args = [];

            $detail = native_tool_arg_summary($tc['name'], $args);
            emit([
                'type' => 'tool', 'phase' => 'start', 'id' => $callId,
                'name' => $tc['name'],
                'detail' => $detail
            ]);
            emit(['type' => 'terminal', 'kind' => 'tool', 'line' => '⚕️ ' . $tc['name'] . ($detail !== '' ? ' · ' . $detail : '')]);

            $endpoint = native_tool_endpoint($tc['name']);
            $t0 = microtime(true);
            if ($endpoint === null) {
                $outData = ['error' => 'tool gak dikenal: ' . $tc['name']];
                if (function_exists('applog')) applog('AGENT', 'tool unknown: ' . $tc['name'], []);
            } else {
                $approvalInfo = null;
                list($ok, $outData) = native_call_tool($endpoint, $args, $approvalInfo);
                if (!$ok && $approvalInfo !== null) {
                    // Perintah bahaya -> cek policy (always/session) dulu, baru tanya user
                    $autoMode = '';
                    if ($allowAlways) $autoMode = 'always';
                    elseif ($allowSession) $autoMode = 'session';
                    if ($autoMode !== '') {
                        emit(['type' => 'terminal', 'kind' => 'info', 'line' => '🔓 auto-approve (' . $autoMode . '): ' . native_trunc((string)($approvalInfo['command'] ?? $tc['name']), 90)]);
                        emit(['type' => 'approval_done', 'choice' => $autoMode, 'auto' => true]);
                        $args['approved'] = true;
                        list($ok2, $outData) = native_call_tool($endpoint, $args, $approvalInfo2);
                        if (!$ok2) $outData = ['error' => $outData['error'] ?? 'exec gagal setelah approval'];
                    } else {
                        emit(['type' => 'terminal', 'kind' => 'info', 'line' => '🔐 nunggu approval user: ' . native_trunc((string)($approvalInfo['command'] ?? $tc['name']), 90)]);
                        emit([
                            'type' => 'approval',
                            'run_id' => 'native_' . $callId,
                            'command' => $approvalInfo['command'] ?? '',
                            'reason' => 'Perintah berbahaya terdeteksi: ' . ($approvalInfo['reason'] ?? ''),
                            'choices' => ['once', 'session', 'always', 'deny'],
                            'tool' => $tc['name']
                        ]);
                        // tunggu approval (poll file flag yang dibikin action=approval)
                        $choice = native_wait_approval('native_' . $callId, 900);
                        emit(['type' => 'approval_done', 'choice' => $choice, 'run_id' => 'native_' . $callId]);
                        if ($choice === 'deny') {
                            $outData = ['error' => 'user menolak / tidak menjawab approval'];
                        } else {
                            if ($choice === 'session') $allowSession = true;
                            if ($choice === 'always') { $allowAlways = true; native_set_allow_all(true); }
                            $args['approved'] = true;
                            list($ok2, $outData) = native_call_tool($endpoint, $args, $approvalInfo2);
                            if (!$ok2) $outData = ['error' => $outData['error'] ?? 'exec gagal setelah approval'];
                        }
                    }
                }
            }

            $sum = native_tool_result_summary($tc['name'], $outData);
            $ms = (int)((microtime(true) - $t0) * 1000);
            $okTool = empty($outData['error']);
            emit([
                'type' => 'tool', 'phase' => 'result', 'id' => $callId,
                'name' => $tc['name'],
                'summary' => $sum
            ]);
            emit(['type' => 'terminal', 'kind' => ($okTool ? 'ok' : 'error'), 'line' => ($okTool ? '✅' : '⚠️') . ' ' . $tc['name'] . ' · ' . $sum . ' · ' . $ms . 'ms']);
            if (function_exists('applog')) applog('AGENT', 'tool done: ' . $tc['name'], ['ms' => (int)((microtime(true) - $t0) * 1000), 'ok' => empty($outData['error']), 'summary' => native_tool_result_summary($tc['name'], $outData)]);

            $chatMessages[] = [
                'role' => 'tool',
                'tool_call_id' => $callId,
                'content' => json_encode($outData, JSON_UNESCAPED_UNICODE)
            ];
        }
        // lanjut iterasi berikutnya dengan hasil tool
    }

    emit(['choices' => [['delta' => ['content' => "\n\n⚠️ **Batas iterasi agent ({$MAX_ITER}) tercapai."]]]]);
    if (function_exists('applog')) applog('AGENT', 'MAX_ITER tercapai', ['iter' => $MAX_ITER]);
    emit(['type' => 'terminal', 'kind' => 'limit', 'line' => '⚠️ MAX_ITER ' . $MAX_ITER . ' tercapai — agent distop']);
    emitDone();
}

function native_tool_arg_summary($name, $args) {
    switch ($name) {
        case 'shell': return isset($args['command']) ? native_trunc((string)$args['command'], 64) : '';
        case 'read_file': case 'write_file': case 'list_dir':
            return isset($args['path']) ? native_trunc((string)$args['path'], 64) : '';
        case 'search': return isset($args['pattern']) ? native_trunc((string)$args['pattern'], 64) : '';
        case 'http_request': return isset($args['url']) ? native_trunc((string)$args['url'], 64) : '';
        case 'download_file': return (isset($args['url']) ? native_trunc((string)$args['url'], 40) : '') . ' -> ' . (isset($args['path']) ? native_trunc((string)$args['path'], 40) : '');
        case 'db_query': return isset($args['sql']) ? native_trunc((string)$args['sql'], 64) : '';
        case 'archive': return ($args['action'] ?? '') . ' ' . ((string)($args['archive_path'] ?? ''));
        case 'process_list': return isset($args['pattern']) ? 'filter: ' . (string)$args['pattern'] : 'semua';
        case 'process_kill': return isset($args['pid']) ? ('pid ' . $args['pid']) : ('pattern ' . (string)($args['pattern'] ?? ''));
        case 'note': return ($args['action'] ?? '') . (isset($args['key']) ? ' ' . (string)$args['key'] : '');
        case 'app_install': return ($args['action'] ?? '') . (isset($args['package']) ? ' ' . (string)$args['package'] : '');
        case 'computer_use': return ($args['action'] ?? '') . (isset($args['x']) && isset($args['y']) ? ' @'.$args['x'].','.$args['y'] : (isset($args['text']) ? ' '.native_trunc((string)$args['text'], 30) : (isset($args['url']) ? ' '.native_trunc((string)$args['url'], 40) : (isset($args['key']) ? ' '.(string)$args['key'] : ''))));
        case 'browser': return ($args['command'] ?? '') . (isset($args['url']) ? ' ' . (string)$args['url'] : (isset($args['selector']) ? ' ' . (string)$args['selector'] : ''));
    }
    return '';
}
function native_trunc($s, $n) { return mb_strlen($s) > $n ? mb_substr($s, 0, $n) . '…' : $s; }

function native_tool_result_summary($name, $out) {
    if (!is_array($out)) return 'ok';
    if (isset($out['error'])) return 'error: ' . native_trunc((string)$out['error'], 60);
    if (isset($out['exit_code'])) return 'exit ' . $out['exit_code'];
    if (isset($out['total_count'])) return $out['total_count'] . ' entri';
    if (isset($out['bytes_written'])) return $out['bytes_written'] . ' bytes';
    if (isset($out['bytes'])) return $out['bytes'] . ' bytes';
    if (isset($out['truncated'])) return ($out['truncated'] ? '≥' : '') . count($out['results'] ?? []) . ' hasil';
    if (isset($out['http_code'])) return 'HTTP ' . $out['http_code'];
    if (isset($out['count'])) return $out['count'] . ' baris';
    if (isset($out['affected'])) return $out['affected'] . ' baris diubah';
    if (isset($out['killed'])) return count($out['killed']) . ' proses';
    if (isset($out['notes'])) return count($out['notes']) . ' note';
    if (isset($out['processes'])) return $out['total'] . ' proses';
    if (isset($out['base64'])) return 'screenshot ' . ($out['width'] ?? '?') . 'x' . ($out['height'] ?? '?');
    return 'ok';
}

// Allow-All persist flag: file di folder project — hidup antar request & reboot,
// shared sama web (api.php action=approval_mode) & CLI (debz-term.py /allow).
function native_allow_all_file() { return __DIR__ . '/.approval_always'; }
function native_allow_all_get() { clearstatcache(true, native_allow_all_file()); return is_file(native_allow_all_file()); }
function native_set_allow_all($on) {
    $f = native_allow_all_file();
    if ($on) { @file_put_contents($f, date('c')); clearstatcache(true, $f); return is_file($f); }
    if (is_file($f)) @unlink($f);
    clearstatcache(true, $f);
    return true;
}

// Approval wait: poll file flag di /tmp. action=approval (api.php) nulis flag berisi
// choice ASLI (once/session/always/deny) — return string choice, 'deny' kalau timeout.
function native_wait_approval($runId, $timeoutSec) {
    $flag = sys_get_temp_dir() . '/c0n73xt_appr_' . md5($runId);
    @unlink($flag);
    $t0 = time();
    while ((time() - $t0) < $timeoutSec) {
        clearstatcache(true, $flag);
        if (is_file($flag)) {
            $v = trim((string)@file_get_contents($flag));
            @unlink($flag);
            if ($v === 'once' || $v === 'session' || $v === 'always') return $v;
            return 'deny';
        }
        if (function_exists('clientIsGone') && clientIsGone()) return 'deny';
        usleep(500000);
    }
    return 'deny';
}

if (realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'] ?? '')) {
    http_response_code(403);
    exit('no direct access');
}

return true;
