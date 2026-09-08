<?php

set_time_limit(0);
try {
    ini_set('max_execution_time', '0');
} catch (Exception $e) {}

while (ob_get_level() > 0) { ob_end_clean(); }

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit(0);
}

$configFile = __DIR__ . '/.ai-config.ini';
$config = file_exists($configFile) ? parse_ini_file($configFile) : [];
$apiKey = $config['AI_API_KEY'] ?? '';
$model = $config['AI_MODEL'] ?? 'gpt-4o-mini';

// ===== LOGGER (analisis error pemakaian) =====
require_once __DIR__ . '/logger.php';
applog_rotate();
applog('BOOT', 'api.php hit', ['action' => $_GET['action'] ?? '-', 'post_keys' => array_keys($_POST)]);

// ===== MULTI-PROVIDER (Phase 1) =====
require_once __DIR__ . '/providers.php';
$PROVIDERS = providers_load();
$routing = providers_routing($PROVIDERS);
$providerId = '';
if (!empty($_POST['provider_id'])) $providerId = (string)$_POST['provider_id'];
elseif (!empty($_GET['provider_id'])) $providerId = (string)$_GET['provider_id'];
if ($providerId === '__auto__') $providerId = ''; // mode auto round-robin dari UI
// RR pick HANYA untuk panggilan LLM beneran (chat / compact) — bukan buat action UI
// (biar load daftar provider gak geser pointer rotasi).
$isLLMCall = !isset($_GET['action']) || $_GET['action'] === 'compact';
$explicitPick = $providerId !== '';
if (!$explicitPick && $isLLMCall && $routing === 'roundrobin') {
    $providerId = providers_rr_pick($PROVIDERS);
    applog('ROUTING', 'roundrobin pick', ['id' => $providerId]);
} elseif (!$explicitPick) {
    $act = (string)($PROVIDERS['active'] ?? '');
    if ($act !== '' && !empty($PROVIDERS['providers'][$act]) && ($PROVIDERS['providers'][$act]['enabled'] ?? true) !== false) {
        $providerId = $act;
    } else {
        $enIds = providers_enabled_ids($PROVIDERS);
        $providerId = $enIds ? $enIds[0] : '';
    }
}
if ($providerId === '' || empty($PROVIDERS['providers'][$providerId])) {
    $enIds = providers_enabled_ids($PROVIDERS);
    $providerId = $enIds ? $enIds[0] : '';
}
$P = isset($PROVIDERS['providers'][$providerId]) ? $PROVIDERS['providers'][$providerId] : null;
// FAILOVER CHAIN: daftar provider enabled cadangan (urutan config), dipake agent
// pas provider utama error (429/5xx) sebelum ada apa2 yang ke-stream.
$providerChain = [];
if ($routing !== 'fixed') {
    foreach (providers_enabled_ids($PROVIDERS) as $_pid) {
        if ($_pid !== $providerId) $providerChain[] = $_pid;
    }
}
if (isset($_GET['action']) && $_GET['action'] !== 'providers' && $_GET['action'] !== 'client_log') {
    applog('PROVIDER', 'selected', ['id' => $providerId, 'mode' => $P['mode'] ?? '-', 'model' => $P['model'] ?? '-', 'base' => $P['base_url'] ?? '-']);
}

// ===== CLIENT-ERROR REPORTING: browser kirim error JS/SW ke sini =====
if (isset($_GET['action']) && $_GET['action'] === 'client_log') {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['error' => 'POST aja']); exit; }
    $in = json_decode((string)file_get_contents('php://input'), true);
    $items = [];
    if (is_array($in['batch'] ?? null)) $items = $in['batch'];
    elseif (is_array($in)) $items = [$in];
    if (!$items) { http_response_code(400); echo json_encode(['error' => 'bad json']); exit; }
    foreach ($items as $it) {
        if (!is_array($it)) continue;
        $lvl = in_array(($it['level'] ?? ''), ['error', 'warn', 'info'], true) ? $it['level'] : 'info';
        applog('CLIENT.' . strtoupper($lvl), (string)($it['message'] ?? '-'), [
            'url' => (string)($it['url'] ?? '-'),
            'extra' => isset($it['extra']) ? substr(json_encode($it['extra'], JSON_UNESCAPED_UNICODE), 0, 500) : '-',
        ]);
    }
    echo json_encode(['ok' => true, 'n' => count($items)]);
    exit;
}

$responsesEndpoint = trim($config['AI_ENDPOINT_RESPONSES'] ?? '');
if ($responsesEndpoint === '') {
    $base = trim($config['AI_ENDPOINT'] ?? 'https://api.openai.com/v1/chat/completions');
    $responsesEndpoint = preg_replace('#/chat/completions$#', '/responses', $base);
    if ($responsesEndpoint === $base) {
        $responsesEndpoint = rtrim($base, '/') . '/responses';
    }
}

if (isset($_GET['action']) && $_GET['action'] === 'ka') {
    header('Content-Type: application/json');
    $rid = isset($_GET['run_id']) ? trim((string)$_GET['run_id']) : '';
    if ($rid === '') { http_response_code(400); echo json_encode(['error' => 'run_id wajib']); exit; }
    $f = sys_get_temp_dir() . '/c0n73xt_ka_' . md5($rid);
    @touch($f);
    echo json_encode(['ok' => true]);
    exit;
}

if (isset($_GET['action']) && $_GET['action'] === 'providers') {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $mask = providers_mask($PROVIDERS);
        echo json_encode(['success' => true, 'active' => $providerId] + $mask);
        exit;
    }
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $in = json_decode((string)file_get_contents('php://input'), true);
        if (!is_array($in)) { http_response_code(400); echo json_encode(['error' => 'bad json']); exit; }
        $op = (string)($in['op'] ?? '');
                if ($op === 'activate') {
            $id = trim((string)($in['id'] ?? ''));
            if ($id === '' || empty($PROVIDERS['providers'][$id])) { http_response_code(404); echo json_encode(['error' => 'provider gak ada']); exit; }
            $PROVIDERS['active'] = $id;
            $PROVIDERS['providers'][$id]['enabled'] = true; // Otomatis aktifkan provider yang dipilih
            providers_save($PROVIDERS);
            echo json_encode(['success' => true, 'active' => $id]); exit;
        }

        if ($op === 'save') {
            $id = trim((string)($in['id'] ?? ''));
            $name = trim((string)($in['name'] ?? ''));
            $baseUrl = trim((string)($in['base_url'] ?? ''));
            $apiKeyIn = (string)($in['api_key'] ?? '');
            $modelIn = trim((string)($in['model'] ?? ''));
            $mode = in_array(($in['mode'] ?? ''), ['agent', 'native', 'chat'], true) ? $in['mode'] : 'chat';
            if ($id === '' || $name === '' || $baseUrl === '') { http_response_code(400); echo json_encode(['error' => 'id/name/base_url wajib']); exit; }
            if (!preg_match('#^https?://#i', $baseUrl)) { http_response_code(400); echo json_encode(['error' => 'base_url harus http(s)://...']); exit; }
            $p = $PROVIDERS['providers'][$id] ?? ['enabled' => true];
            $p['name'] = $name;
            $p['base_url'] = rtrim($baseUrl, '/');
            if ($apiKeyIn !== '' && $apiKeyIn !== '____') $p['api_key'] = $apiKeyIn; // '____' = jangan ubah key
            if ($modelIn !== '') $p['model'] = $modelIn;
            $p['mode'] = $mode;
            // extra opts: {"reasoning_effort":"none","temperature":0.7,...} — dikirim apa adanya ke provider
            $extraIn = $in['extra'] ?? null;
            if (is_array($extraIn)) {
                $clean = [];
                foreach ($extraIn as $ek => $ev) {
                    if ($ev === '' || $ev === null) continue;
                    $clean[$ek] = $ev;
                }
                if ($clean) $p['extra'] = $clean; else unset($p['extra']);
            } elseif ($extraIn === 'clear') {
                unset($p['extra']);
            }
            $PROVIDERS['providers'][$id] = $p;
            providers_save($PROVIDERS);
            // [Patch auto-fetch] provider baru/diupdate aktif → langsung ambil list model otomatis.
            // Non-fatal: kalau fetch gagal, save tetep sukses (list model bisa diambil manual via 🔄).
            $afCount = 0; $afErr = '';
            if (($p['enabled'] ?? true) !== false && $p['base_url'] !== '') {
                $af = providers_refresh_models($PROVIDERS, $id);
                $afCount = count($af['models'] ?? []);
                $afErr = (string)($af['error'] ?? '');
                if ($afCount > 0) applog('PROVIDERS', 'auto-fetch save ' . $id, ['count' => $afCount]);
            }
            echo json_encode(['success' => true, 'id' => $id, 'auto_fetch' => ['count' => $afCount, 'error' => $afErr ?: '-']]); exit;
        }
        if ($op === 'delete') {
            $id = trim((string)($in['id'] ?? ''));
            if ($id === '') { http_response_code(400); echo json_encode(['error' => 'id wajib']); exit; }
            unset($PROVIDERS['providers'][$id]);
            if (($PROVIDERS['active'] ?? '') === $id && !empty($PROVIDERS['providers'])) {
                $PROVIDERS['active'] = (string)array_key_first($PROVIDERS['providers']);
            }
            providers_save($PROVIDERS);
            echo json_encode(['success' => true]); exit;
        }
        if ($op === 'test') {
            $tUrl = trim((string)($in['base_url'] ?? ''));
            $tKey = (string)($in['api_key'] ?? '');
            $tId = trim((string)($in['id'] ?? ''));
            if ($tId !== '' && $tKey === '____' && !empty($PROVIDERS['providers'][$tId]['api_key'])) {
                $tKey = (string)$PROVIDERS['providers'][$tId]['api_key'];
            }
            if (!preg_match('#^https?://#i', $tUrl)) { http_response_code(400); echo json_encode(['error' => 'base_url invalid']); exit; }
            // UA policy test koneksi — sama kayak agent.php (beberapa provider gate UA)
            $tUa = trim((string)($in['ua'] ?? ''));
            if ($tUa === '' && stripos($tUrl, 'openrouter.ai') !== false) $tUa = 'opencode/1.0 (linux; x64)';
            $tHeaders = ['Authorization: Bearer ' . $tKey];
            if ($tUa !== '') $tHeaders[] = 'User-Agent: ' . $tUa;
            $cht = curl_init(rtrim($tUrl, '/') . '/models');
            curl_setopt_array($cht, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $tHeaders, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 20, CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0, CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1]); // [patch h11]
            $rawT = curl_exec($cht); $httpT = curl_getinfo($cht, CURLINFO_RESPONSE_CODE); $errT = curl_error($cht);
            if ($rawT === false) { http_response_code(502); echo json_encode(['error' => 'unreachable: ' . $errT]); exit; }
            $decT = json_decode($rawT, true);
            $idsT = [];
            if (is_array($decT) && isset($decT['data'])) {
                foreach ($decT['data'] as $mm) { if (isset($mm['id'])) $idsT[] = $mm['id']; }
            }
            echo json_encode(['success' => $httpT >= 200 && $httpT < 300, 'http' => $httpT, 'models' => array_slice($idsT, 0, 500)]);
            exit;
        }
        if ($op === 'toggle') {
            $id = trim((string)($in['id'] ?? ''));
            if ($id === '' || empty($PROVIDERS['providers'][$id])) { http_response_code(404); echo json_encode(['error' => 'provider gak ada']); exit; }
            $to = $in['enabled'] ?? null;
            if ($to === null) $to = !(($PROVIDERS['providers'][$id]['enabled'] ?? true) !== false);
            $PROVIDERS['providers'][$id]['enabled'] = ($to === true || $to === 1 || $to === '1');
            providers_save($PROVIDERS);
            applog('PROVIDERS', 'toggle', ['id' => $id, 'enabled' => $PROVIDERS['providers'][$id]['enabled'] ? 1 : 0]);
            // [Patch auto-fetch] provider diaktifin (toggle ON) & belum punya list model → ambil otomatis
            $afCount2 = 0; $afErr2 = '';
            if ($PROVIDERS['providers'][$id]['enabled']) {
                $hasModels = !empty($PROVIDERS['providers'][$id]['models']);
                if (!$hasModels) {
                    $af2 = providers_refresh_models($PROVIDERS, $id);
                    $afCount2 = count($af2['models'] ?? []);
                    $afErr2 = (string)($af2['error'] ?? '');
                    if ($afCount2 > 0) applog('PROVIDERS', 'auto-fetch toggle-on ' . $id, ['count' => $afCount2]);
                }
            }
            echo json_encode(['success' => true, 'id' => $id, 'enabled' => $PROVIDERS['providers'][$id]['enabled'], 'auto_fetch' => ['count' => $afCount2, 'error' => $afErr2 ?: '-']]);
            exit;
        }
        if ($op === 'gensession') {
            $gUrl = trim((string)($in['base_url'] ?? ''));
            $gKey = (string)($in['api_key'] ?? '');
            $gId = trim((string)($in['id'] ?? ''));
            if ($gId !== '' && ($gKey === '' || $gKey === '____') && !empty($PROVIDERS['providers'][$gId]['api_key'])) {
                $gKey = (string)$PROVIDERS['providers'][$gId]['api_key'];
            }
            if (!preg_match('#^https?:\/\/#i', $gUrl)) { http_response_code(400); echo json_encode(['error' => 'base_url invalid']); exit; }
            $gUa = trim((string)($in['ua'] ?? ''));
            if ($gUa === '' && stripos($gUrl, 'openrouter.ai') !== false) $gUa = 'opencode\/1.0 (linux; x64)';
            $gHeaders = ['Authorization: Bearer ' . $gKey];
            if ($gUa !== '') $gHeaders[] = 'User-Agent: ' . $gUa;
            $gHeaders[] = 'Accept: application\/json';
            $foundSid = '';
            $gSource = '';
            $gErr = '';
            // Coba 1: GET {base}/models — header x-session-id biasanya muncul di sini kalau server ngasih.
            $curlM = curl_init(rtrim($gUrl, '\/') . '\/models');
            curl_setopt_array($curlM, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $gHeaders, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 20, CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0, CURLOPT_HEADER => true, CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1]);
            $rawM = curl_exec($curlM);
            if ($rawM !== false) {
                $hdrM = substr($rawM, 0, (int)curl_getinfo($curlM, CURLINFO_HEADER_SIZE));
                if (preg_match('/^x-session-id:\s*(.+)$/mi', $hdrM, $mM)) {
                    $foundSid = trim($mM[1]);
                    $gSource = 'response';
                }
            }
            curl_close($curlM);
            // Coba 2: kalau belum dapet, POST /chat/completions minimal (banyak server nyetel session id di sini).
            if ($foundSid === '') {
                $bodyC = json_encode(['model' => 'test', 'messages' => [['role' => 'user', 'content' => 'hi']], 'max_tokens' => 1]);
                $curlC = curl_init(rtrim($gUrl, '\/') . '\/chat\/completions');
                curl_setopt_array($curlC, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => array_merge($gHeaders, ['Content-Type: application\/json']), CURLOPT_POST => true, CURLOPT_POSTFIELDS => $bodyC, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 20, CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0, CURLOPT_HEADER => true, CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1]);
                $rawC = curl_exec($curlC);
                if ($rawC !== false) {
                    $hdrC = substr($rawC, 0, (int)curl_getinfo($curlC, CURLINFO_HEADER_SIZE));
                    if (preg_match('/^x-session-id:\s*(.+)$/mi', $hdrC, $mC)) {
                        $foundSid = trim($mC[1]);
                        $gSource = 'response';
                    }
                }
                curl_close($curlC);
            }
            // Kalau dua-duanya gak ngasih, generate UUID v4 (valid buat opencode zen & sejenisnya).
            if ($foundSid === '') {
                if (function_exists('random_bytes')) {
                    $b = random_bytes(16);
                    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
                    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
                    $foundSid = vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
                } else {
                    $foundSid = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                        mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000,
                        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
                }
                $gSource = 'generated';
            }
            echo json_encode(['success' => true, 'session_id' => $foundSid, 'source' => $gSource, 'error' => $gErr ?: '-']);
            exit;
        }
        // === SMART PARAMS: probe provider & deteksi parameter yang tepat per model ===
        // 1) GET /models → metadata model (OpenRouter: supported_parameters, max_completion_tokens)
        // 2) POST /chat/completions minimal → deteksi reasoning_tokens di usage
        // 3) Build extra JSON yang aman: reasoning nested HANYA buat OpenRouter thinking models.
        if ($op === 'smartparams') {
            $spUrl = trim((string)($in['base_url'] ?? ''));
            $spKey = (string)($in['api_key'] ?? '');
            $spId = trim((string)($in['id'] ?? ''));
            $spModel = trim((string)($in['model'] ?? ''));
            if ($spId !== '' && ($spKey === '' || $spKey === '____') && !empty($PROVIDERS['providers'][$spId]['api_key'])) {
                $spKey = (string)$PROVIDERS['providers'][$spId]['api_key'];
            }
            if (!preg_match('#^https?://#i', $spUrl)) { http_response_code(400); echo json_encode(['error' => 'base_url invalid']); exit; }
            if ($spModel === '') { http_response_code(400); echo json_encode(['error' => 'model kosong — isi dulu kolom model']); exit; }
            $spUa = trim((string)($in['ua'] ?? ''));
            if ($spUa === '' && stripos($spUrl, 'openrouter.ai') !== false) $spUa = 'opencode/1.0 (linux; x64)';
            $spHeaders = ['Accept: application/json'];
            if ($spKey !== '') $spHeaders[] = 'Authorization: Bearer ' . $spKey;
            if ($spUa !== '') $spHeaders[] = 'User-Agent: ' . $spUa;
            $sid = trim((string)($in['sid'] ?? ''));
            if ($sid !== '') $spHeaders[] = 'x-session-id: ' . $sid;

            $notes = [];
            $isReasoning = false;
            $maxTok = 0;
            $supportedParams = null;
            $isOpenRouter = stripos($spUrl, 'openrouter.ai') !== false;

            // --- Tahap 1: GET /models → metadata ---
            $curlM = curl_init(rtrim($spUrl, '/') . '/models');
            curl_setopt_array($curlM, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $spHeaders, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 20, CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0, CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1]);
            $rawM = curl_exec($curlM);
            $codeM = (int)curl_getinfo($curlM, CURLINFO_RESPONSE_CODE);
            curl_close($curlM);
            if ($rawM !== false && $codeM === 200) {
                $jM = json_decode($rawM, true);
                $list = [];
                if (isset($jM['data']) && is_array($jM['data'])) $list = $jM['data'];
                elseif (is_array($jM)) $list = $jM;
                foreach ($list as $mm) {
                    if (!is_array($mm)) continue;
                    if ((string)($mm['id'] ?? '') !== $spModel) continue;
                    // OpenRouter: supported_parameters & max_completion_tokens
                    if (!empty($mm['supported_parameters']) && is_array($mm['supported_parameters'])) {
                        $supportedParams = $mm['supported_parameters'];
                        if (in_array('reasoning', $supportedParams, true) || in_array('reasoning_effort', $supportedParams, true)) $isReasoning = true;
                    }
                    if (!empty($mm['max_completion_tokens'])) $maxTok = (int)$mm['max_completion_tokens'];
                    elseif (!empty($mm['top_provider']['max_completion_tokens'])) $maxTok = (int)$mm['top_provider']['max_completion_tokens'];
                    break;
                }
                if ($supportedParams !== null) $notes[] = 'metadata /models: ' . count($supportedParams) . ' param didukung';
            }

            // --- Tahap 2: POST /chat/completions minimal → deteksi reasoning_tokens ---
            $bodyP = json_encode(['model' => $spModel, 'messages' => [['role' => 'user', 'content' => 'hi']], 'max_tokens' => 300, 'stream' => false]);
            $curlP = curl_init(rtrim($spUrl, '/') . '/chat/completions');
            curl_setopt_array($curlP, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => array_merge($spHeaders, ['Content-Type: application/json']), CURLOPT_POST => true, CURLOPT_POSTFIELDS => $bodyP, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 45, CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0, CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1]);
            $rawP = curl_exec($curlP);
            $codeP = (int)curl_getinfo($curlP, CURLINFO_RESPONSE_CODE);
            curl_close($curlP);
            $probeOk = false;
            if ($rawP !== false && $codeP === 200) {
                $jP = json_decode($rawP, true);
                if (is_array($jP) && !empty($jP['choices'][0])) {
                    $probeOk = true;
                    $rt = (int)($jP['usage']['completion_tokens_details']['reasoning_tokens'] ?? 0);
                    if ($rt > 0) { $isReasoning = true; $notes[] = 'probe: reasoning_tokens=' . $rt . ' (model thinking)'; }
                    else $notes[] = 'probe: reasoning_tokens=0 (model biasa)';
                    $msgP = $jP['choices'][0]['message'] ?? [];
                    if (!empty($msgP['reasoning']) || !empty($msgP['reasoning_content'])) { $isReasoning = true; $notes[] = 'probe: ada field reasoning di response'; }
                }
            } elseif ($rawP !== false) {
                $notes[] = 'probe HTTP ' . $codeP . ' (429/limit — fallback heuristik nama model)';
            } else {
                $notes[] = 'probe gagal (network) — fallback heuristik nama model';
            }

            // --- Tahap 3: heuristik nama model (fallback kalau probe gak konklusif) ---
            if (!$isReasoning && $probeOk === false) {
                $heur = ['think', 'reason', 'r1', 'glm-5', 'glm-4.5', 'glm-4.6', 'nemotron', 'inkling', 'o1', 'o3', 'o4', 'qwq', 'deepseek-r', 'marco', 'mirai', 'gpt-5'];
                foreach ($heur as $h) { if (stripos($spModel, $h) !== false) { $isReasoning = true; $notes[] = 'heuristik: nama model mengandung "' . $h . '"'; break; } }
            }

            // --- Build parameter yang tepat ---
            $extra = [];
            if ($isReasoning) {
                // Model thinking: reasoning nested HANYA valid di OpenRouter.
                // Non-OpenRouter: cukup max_tokens gede — reasoning nested bisa bikin 400/ngaco.
                if ($isOpenRouter) { $extra['reasoning'] = ['enabled' => true]; $notes[] = 'OpenRouter thinking → reasoning:{enabled:true}'; }
                else { $notes[] = 'model thinking non-OpenRouter → TANPA reasoning nested (cukup max_tokens gede)'; }
                $extra['temperature'] = 0.6;
            } else {
                $extra['temperature'] = 0.7;
                $notes[] = 'model biasa → parameter bersih (temperature 0.7)';
            }
            if ($maxTok <= 0) $maxTok = 128000;
            $notes[] = 'max_tokens disarankan: ' . $maxTok;

            echo json_encode([
                'success' => true,
                'is_reasoning' => $isReasoning,
                'is_openrouter' => $isOpenRouter,
                'max_tokens' => $maxTok,
                'extra' => $extra,
                'extra_json' => json_encode($extra, JSON_UNESCAPED_SLASHES),
                'supported_params' => $supportedParams,
                'notes' => $notes
            ]);
            exit;
        }
        if ($op === 'routing') {
            $mode = (string)($in['routing'] ?? '');
            if (!in_array($mode, ['fixed', 'roundrobin', 'failover'], true)) { http_response_code(400); echo json_encode(['error' => 'routing harus fixed|roundrobin|failover']); exit; }
            $PROVIDERS['routing'] = $mode;
            providers_save($PROVIDERS);
            applog('PROVIDERS', 'routing mode: ' . $mode, []);
            echo json_encode(['success' => true, 'routing' => $mode]);
            exit;
        }
        if ($op === 'fetchmodels') {
            $id = trim((string)($in['id'] ?? ''));
            if ($id === '' || empty($PROVIDERS['providers'][$id])) { http_response_code(404); echo json_encode(['error' => 'provider gak ada']); exit; }
            $r = providers_refresh_models($PROVIDERS, $id);
            applog('PROVIDERS', 'fetchmodels ' . $id, ['err' => $r['error'] ?: '-', 'count' => count($r['models'])]);
            if ($r['error'] !== '') { echo json_encode(['success' => false, 'error' => $r['error'], 'models' => array_slice($r['models'], 0, 400), 'count' => count($r['models'])]); exit; }
            echo json_encode(['success' => true, 'models' => array_slice($r['models'], 0, 400), 'count' => count($r['models'])]);
            exit;
        }
        if ($op === 'setmodel') {
            $id = trim((string)($in['id'] ?? ''));
            $mIn2 = trim((string)($in['model'] ?? ''));
            if ($id === '' || empty($PROVIDERS['providers'][$id])) { http_response_code(404); echo json_encode(['error' => 'provider gak ada']); exit; }
            if ($mIn2 === '') { http_response_code(400); echo json_encode(['error' => 'model wajib']); exit; }
            $PROVIDERS['providers'][$id]['model'] = $mIn2;
            providers_save($PROVIDERS);
            echo json_encode(['success' => true, 'id' => $id, 'model' => $mIn2]);
            exit;
        }
        http_response_code(400);
        echo json_encode(['error' => 'op gak dikenal']);
        exit;
    }
}

// ===== COMPACT CONTEXT — ringkas chat jadi summary hemat token =====
if (isset($_GET['action']) && $_GET['action'] === 'compact') {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'Method not allowed']);
        exit;
    }
    $inC = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($inC) || !is_array($inC['messages'] ?? null) || !$inC['messages']) {
        http_response_code(400);
        echo json_encode(['error' => 'messages wajib array']);
        exit;
    }
    require_once __DIR__ . '/agent.php';
    $pC = $P ?: ['base_url' => 'http://127.0.0.1:20128/v1', 'api_key' => '', 'model' => 'debz_ai'];
    $transkrip = '';
    foreach ($inC['messages'] as $mC) {
        $rC = ($mC['role'] ?? '') === 'user' ? 'LU' : 'DEBZ';
        $cC = (string)($mC['content'] ?? '');
        if (trim($cC) === '') continue;
        $transkrip .= $rC . ': ' . $cC . "\n\n";
    }
    $msgSum = [
        ['role' => 'system', 'content' => 'Lu mesin peringkas. Balas HANYA JSON: {"summary":"<ringkasan padat bahasa Indonesia>"}'],
        ['role' => 'user', 'content' => "Ringkas percakapan berikut jadi 1 paragraf padat (maks 150 kata). Pertahankan: keputusan, nama file/command penting, kesimpulan teknis, hal yang belum kelar.\n\nTRANSCRIPT:\n" . mb_substr($transkrip, 0, 30000)]
    ];
    $rC = native_chat_once($pC['base_url'], $pC['api_key'], $pC['model'], $msgSum, [], 800, (isset($pC['extra']) && is_array($pC['extra'])) ? $pC['extra'] : []);
    applog('COMPACT', $rC['error'] !== '' ? 'gagal: ' . $rC['error'] : 'ok ' . strlen((string)($rC['content'] ?? '')) . 'B', ['provider' => $pC['base_url']]);
    $outC = ['success' => false, 'error' => $rC['error'] ?: 'gak ada jawaban'];
    $txt = trim($rC['content'] ?? '');
    // model kadang bungkus {json} di code fence — bersihin
    $txt = preg_replace('/^```[a-z]*\s*/i', '', $txt);
    $txt = preg_replace('/```\s*$/', '', $txt);
    $txt = trim($txt);
    $decC = json_decode($txt, true);
    if (is_array($decC) && !empty($decC['summary'])) {
        $outC = ['success' => true, 'summary' => (string)$decC['summary']];
    } elseif ($txt !== '') {
        // fallback: pakai teks mentah
        $outC = ['success' => true, 'summary' => mb_substr($txt, 0, 1200)];
    }
    echo json_encode($outC, JSON_UNESCAPED_UNICODE);
    exit;
}

if (isset($_GET['action']) && $_GET['action'] === 'run_status') {
    header('Content-Type: application/json');
    $rid = isset($_GET['run_id']) ? trim((string)$_GET['run_id']) : '';
    if ($rid === '') { http_response_code(400); echo json_encode(['error' => 'run_id wajib']); exit; }
    $baseEndpointS = rtrim(trim($config['AI_ENDPOINT'] ?? 'http://127.0.0.1:20128/v1/chat/completions'), '/');
    $baseApiS = preg_replace('#/chat/completions$#', '', $baseEndpointS);
    if ($baseApiS === $baseEndpointS) $baseApiS = preg_replace('#/responses$#', '', $baseEndpointS);
    $baseApiS = rtrim($baseApiS, '/');
    $chs = curl_init($baseApiS . '/runs/' . rawurlencode($rid));
    curl_setopt($chs, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($chs, CURLOPT_HTTPHEADER, ['Authorization: Bearer ' . $apiKey]);
    curl_setopt($chs, CURLOPT_CONNECTTIMEOUT, 10);
    curl_setopt($chs, CURLOPT_TIMEOUT, 30);
    curl_setopt($chs, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($chs, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1); // [patch h11] HTTP/2 putus → force 1.1
    curl_setopt($chs, CURLOPT_SSL_VERIFYHOST, 0);
    $respS = curl_exec($chs);
    $httpS = curl_getinfo($chs, CURLINFO_RESPONSE_CODE);
    $errS = curl_error($chs);

    http_response_code($respS === false ? 502 : (int)$httpS);
    echo ($respS === false) ? json_encode(['error' => 'gateway unreachable: ' . $errS]) : $respS;
    exit;
}

if (isset($_GET['action']) && $_GET['action'] === 'approval') {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'Method not allowed']);
        exit;
    }
    $body = json_decode(file_get_contents('php://input'), true);
    $approvalRunId = isset($body['run_id']) ? trim((string)$body['run_id']) : '';
    $approvalChoice = isset($body['choice']) ? trim((string)$body['choice']) : '';
    if ($approvalRunId === '' || !in_array($approvalChoice, ['once', 'session', 'always', 'deny'], true)) {
        http_response_code(400);
        echo json_encode(['error' => 'run_id dan choice (once/session/always/deny) wajib']);
        exit;
    }

    // Native mode: run_id = native_<callid> -> tulis flag /tmp buat agent loop
    if (strpos($approvalRunId, 'native_') === 0) {
        $flag = sys_get_temp_dir() . '/c0n73xt_appr_' . md5($approvalRunId);
        $w = file_put_contents($flag, $approvalChoice); // choice asli — agent yang interpretasi
        applog('APPROVAL', 'native answered: ' . $approvalChoice, ['run_id' => $approvalRunId]);
        echo json_encode([
            'success' => ($w !== false),
            'mode' => 'native',
            'resolved' => ($w !== false) ? 1 : 0,
            'choice' => $approvalChoice
        ]);
        exit;
    }
    $baseEndpoint0 = rtrim(trim($config['AI_ENDPOINT'] ?? 'http://127.0.0.1:20128/v1/chat/completions'), '/');
    $baseApi0 = preg_replace('#/chat/completions$#', '', $baseEndpoint0);
    if ($baseApi0 === $baseEndpoint0) $baseApi0 = preg_replace('#/responses$#', '', $baseEndpoint0);
    $baseApi0 = rtrim($baseApi0, '/');

    $ch0 = curl_init($baseApi0 . '/runs/' . rawurlencode($approvalRunId) . '/approval');
    curl_setopt($ch0, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch0, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json'
    ]);
    curl_setopt($ch0, CURLOPT_POST, true);
    curl_setopt($ch0, CURLOPT_POSTFIELDS, json_encode(['choice' => $approvalChoice]));
    curl_setopt($ch0, CURLOPT_CONNECTTIMEOUT, 30);
    curl_setopt($ch0, CURLOPT_TIMEOUT, 300);
    curl_setopt($ch0, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch0, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1); // [patch h11] HTTP/2 putus → force 1.1
    curl_setopt($ch0, CURLOPT_SSL_VERIFYHOST, 0);
    $resp0 = curl_exec($ch0);
    $http0 = curl_getinfo($ch0, CURLINFO_RESPONSE_CODE);
    $err0 = curl_error($ch0);
    curl_close($ch0);
    http_response_code($resp0 === false ? 502 : (int)$http0);
    echo ($resp0 === false) ? json_encode(['error' => 'gateway unreachable: ' . $err0]) : $resp0;
    exit;
}

// Approval mode: status & toggle Allow-All (persist) — dipakai toggle 🔓 di sidebar UI
if (isset($_GET['action']) && $_GET['action'] === 'approval_mode') {
    header('Content-Type: application/json');
    $alwaysFile = __DIR__ . '/.approval_always';
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $bodyM = json_decode(file_get_contents('php://input'), true);
        $on = !empty($bodyM['always']);
        if ($on) $okM = @file_put_contents($alwaysFile, date('c')) !== false;
        else { if (is_file($alwaysFile)) @unlink($alwaysFile); $okM = true; }
        clearstatcache(true, $alwaysFile);
        applog('APPROVAL', 'allow-all ' . ($on ? 'ON' : 'OFF'));
        echo json_encode(['success' => $okM, 'always' => $on && is_file($alwaysFile)]);
        exit;
    }
    clearstatcache(true, $alwaysFile);
    echo json_encode(['always' => is_file($alwaysFile)]);
    exit;
}

if (isset($_GET['action']) && $_GET['action'] === 'model') {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        echo json_encode(['model' => $model]);
        exit;
    }
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $inputData = json_decode(file_get_contents('php://input'), true);
        $newModel = $inputData['model'] ?? '';
        if (empty($newModel)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'error' => 'Model tidak boleh kosong']);
            exit;
        }
        if (file_exists($configFile)) {
            $content = file_get_contents($configFile);
            $content = preg_replace('/^AI_MODEL\s*=.*$/m', 'AI_MODEL = ' . $newModel, $content);
            if (strpos($content, 'AI_MODEL') === false) {
                $content = rtrim($content) . "\nAI_MODEL = " . $newModel . "\n";
            }
            file_put_contents($configFile, $content);
        } else {
            file_put_contents($configFile, "AI_MODEL = " . $newModel . "\n");
        }
        echo json_encode(['success' => true, 'model' => $newModel]);
        exit;
    }
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// Kalau provider aktif punya api_key sendiri, pakai itu (independen dari .ini lama)
if ($P && !empty($P['api_key'])) $apiKey = $P['api_key'];
if ($P && !empty($P['model'])) $model = $P['model'];

// FIX: provider FREE tanpa api_key (spt opencode zen) harus tetap jalan.
// Cek key cuma buat provider default lama (tanpa config provider custom).
if (!$P && (empty($apiKey) || $apiKey === 'YOUR_API_KEY_HERE')) {
    header('Content-Type: application/json');
    http_response_code(500);
    echo json_encode(['error' => 'AI_API_KEY not configured. Edit .ai-config.ini.']);
    exit;
}

$messages = [];
if (!empty($_POST['messages'])) {
    $messages = json_decode($_POST['messages'], true);
}
if (empty($messages)) {
    $inputRaw = file_get_contents('php://input');
    $input = json_decode($inputRaw, true);
    if (!empty($input['messages'])) $messages = $input['messages'];
}
if (empty($messages) || !is_array($messages)) {
    header('Content-Type: application/json');
    http_response_code(400);
    echo json_encode(['error' => 'Invalid request / messages empty']);
    exit;
}

header('Content-Type: text/event-stream; charset=utf-8');
header('Cache-Control: no-cache, no-transform');
header('Connection: keep-alive');
header('X-Accel-Buffering: no');

// ===== DISPATCH MODE: native / chat (Debz_AI mandiri — gak perlu gateway) =====
require_once __DIR__ . '/agent.php';
if ($P && in_array(($P['mode'] ?? 'chat'), ['native', 'chat'], true)) {
    $messagesIn = [];
    foreach ($messages as $m) {
        if (!is_array($m) || empty($m['role'])) continue;
        $row = ['role' => $m['role'], 'content' => isset($m['content']) && is_string($m['content']) ? $m['content'] : ''];
        // Round-trip reasoning_details (assistant msg thinking models)
        if (($m['role'] ?? '') === 'assistant' && !empty($m['reasoning_details']) && is_array($m['reasoning_details'])) {
            $row['reasoning_details'] = $m['reasoning_details'];
        }
        $messagesIn[] = $row;
    }
    $userText = '';
    // Ambil user terakhir sebagai $userText DAN buang dari messagesIn
    // (native_agent_run bakal nambahin userText sendiri — tanpa ini dobel!)
    for ($i = count($messagesIn) - 1; $i >= 0; $i--) {
        if ($messagesIn[$i]['role'] === 'user') {
            $userText = $messagesIn[$i]['content'];
            array_splice($messagesIn, $i, 1);
            break;
        }
    }
    $maxTok = (int)($_POST['max_tokens'] ?? 0);
    // Cap max_tokens dibaca dari config (AI_MAX_TOKEN) — default 128000.
    // UI ngirim nilai gede (10jt) buat "unlimited" — clamp ke cap, 0 = biarkan provider default.
    $maxTokCap = (int)($config['AI_MAX_TOKEN'] ?? 128000);
    if ($maxTokCap <= 0) $maxTokCap = 128000;
    if ($maxTok > $maxTokCap) $maxTok = $maxTokCap;
    if ($maxTok < 0) $maxTok = 0;
    $toolsOn = ($_POST['tools'] ?? '1') !== '0';
    $allowSessionIn = (($_POST['approval_session'] ?? '0') === '1');

    emit(['type' => 'status', 'phase' => 'thinking']);
    if ($routing !== 'fixed') {
        $chainNames = [];
        foreach ($providerChain as $pcid) { $chainNames[] = (string)($PROVIDERS['providers'][$pcid]['name'] ?? $pcid); }
        emit(['type' => 'terminal', 'kind' => 'info', 'line' => '🔀 routing: ' . $routing . ' · aktif: ' . ($P['name'] ?? $providerId) . (count($chainNames) ? ' · cadangan: ' . implode(', ', $chainNames) : ' (gak ada cadangan)')]);
    }
    if (($P['mode'] ?? '') === 'native') {
        applog('CHAT', 'native agent start', ['provider' => $providerId, 'routing' => $routing, 'chain' => count($providerChain), 'tools' => $toolsOn ? 1 : 0, 'msgs' => count($messagesIn), 'user_len' => strlen($userText)]);
        native_agent_run($P, $messagesIn, $maxTok, $userText, $toolsOn, $providerChain, $PROVIDERS, $allowSessionIn);
        exit; // native_agent_run udah emitDone() sendiri
    } else {
        // mode chat: single-pass tanpa tools
        $sysChat = [['role' => 'system', 'content' => 'Lu adalah Debz AI asisten virtual santai. Bahasa gaul Indonesia. Format markdown rapih.']];
        $histChat = $sysChat;
        foreach ($messagesIn as $m) {
            if ($m['role'] === 'system') { $histChat[0]['content'] .= "\n" . $m['content']; continue; }
            if ($m['content'] === '') continue;
            $histChat[] = ['role' => $m['role'] === 'assistant' ? 'assistant' : 'user', 'content' => $m['content']];
        }
        $r = native_chat_once($P['base_url'], $P['api_key'] ?? '', $P['model'], $histChat, [], $maxTok, (isset($P['extra']) && is_array($P['extra'])) ? $P['extra'] : []);
        // FAILOVER (mode chat): provider utama error & belum ada konten → coba cadangan
        if ($r['error'] !== '' && $r['content'] === '' && !empty($providerChain)) {
            foreach ($providerChain as $fcid) {
                $fp = $PROVIDERS['providers'][$fcid] ?? null;
                if (!$fp) continue;
                emit(['type' => 'terminal', 'kind' => 'info', 'line' => '🔄 FAILOVER: ' . trunc((string)$r['error'], 60) . ' → pindah ke "' . (string)($fp['name'] ?? $fcid) . '"']);
                applog('CHAT', 'failover → ' . $fcid, ['err' => substr((string)$r['error'], 0, 200)]);
                $r = native_chat_once($fp['base_url'], $fp['api_key'] ?? '', $fp['model'], $histChat, [], $maxTok, (isset($fp['extra']) && is_array($fp['extra'])) ? $fp['extra'] : []);
                if ($r['error'] === '') { $providerId = $fcid; break; }
            }
        }
        applog('CHAT', 'chat mode done', ['provider' => $providerId, 'routing' => $routing, 'err' => $r['error'] ?: '-', 'content_len' => strlen($r['content'] ?? ''), 'finish' => $r['finish_reason'] ?: '-', 'usage' => $r['usage'] ?? null]);
        if ($r['error'] !== '') {
            emit(['choices' => [['delta' => ['content' => '⚠️ **Provider error:** ' . $r['error']]]]]);
        } else {
            if ($r['content'] !== '') emit(['choices' => [['delta' => ['content' => $r['content']]]]]);
            if (!empty($r['usage'])) {
                $u = $r['usage'];
                emit(['type' => 'usage', 'input_tokens' => $u['prompt_tokens'] ?? 0, 'output_tokens' => $u['completion_tokens'] ?? 0, 'total_tokens' => $u['total_tokens'] ?? 0]);
            }
        }
    }
    // [DEBZ PATCH] Safety net: kalau sampai sini gak ada apa-apa yang ke-emit
    global $emittedAnything, $doneSent;
    if (!isset($doneSent) || !$doneSent) {
        if (empty($emittedAnything)) {
            if (function_exists('applog')) applog('API', 'EMPTY_STREAM safety net triggered', ['reason' => 'no content emitted before emitDone']);
            $fallbackMsg = "\n\n⚠️ **Stream kosong**: provider tidak mengirim konten apapun. Coba ulangi atau ganti model.\n";
            emit(['choices' => [['delta' => ['content' => $fallbackMsg]]]]);
        }
    }
    emitDone();
    exit;
}

@ini_set('output_buffering', 'off');
@ini_set('zlib.output_compression', 'Off');
@ini_set('implicit_flush', true);
if (function_exists('apache_setenv')) {
    @apache_setenv('no-gzip', '1');
}
while (ob_get_level() > 0) { @ob_end_flush(); }
flush();

set_time_limit(0);

function emit($obj) {
    echo 'data: ' . json_encode($obj, JSON_UNESCAPED_UNICODE) . "\n\n";
    flush();
}
function emitDone() {
    echo "data: [DONE]\n\n";
    flush();
}
function trunc($s, $n) {
    $s = (string)$s;
    if (function_exists('mb_substr')) return mb_substr($s, 0, $n);
    return substr($s, 0, $n);
}
function toolDetailFromArgs($argsRaw) {
    $a = json_decode((string)$argsRaw, true);
    if (!is_array($a)) return '';
    foreach (['path', 'file', 'query', 'command', 'pattern', 'url', 'name', 'skill', 'search'] as $k) {
        if (!empty($a[$k]) && is_string($a[$k])) return trunc($a[$k], 64);
    }
    foreach ($a as $v) {
        if (is_string($v) && $v !== '') return trunc($v, 64);
    }
    return '';
}
function summarizeToolOutput($textRaw) {
    $t = json_decode((string)$textRaw, true);
    if (is_array($t)) {
        if (isset($t['total_lines'])) return $t['total_lines'] . ' baris';
        if (isset($t['total_count'])) return $t['total_count'] . ' hasil';
        if (isset($t['bytes_written'])) return $t['bytes_written'] . ' bytes';
        if (isset($t['exit_code'])) return 'exit ' . $t['exit_code'];
        if (isset($t['status']) && is_string($t['status'])) return $t['status'];
    }
    $flat = trim(preg_replace('/\s+/', ' ', (string)$textRaw));
    return $flat === '' ? 'ok' : trunc($flat, 64);
}

$baseEndpoint = rtrim(trim($config['AI_ENDPOINT'] ?? 'http://127.0.0.1:20128/v1/chat/completions'), '/');
$baseApi = preg_replace('#/chat/completions$#', '', $baseEndpoint);
if ($baseApi === $baseEndpoint) $baseApi = preg_replace('#/responses$#', '', $baseEndpoint);
$baseApi = rtrim($baseApi, '/');

$hasImages = false;
if (!empty($_FILES['images']) && is_array($_FILES['images']['name'])) {
    foreach ($_FILES['images']['name'] as $idx => $name) {
        if ($_FILES['images']['error'][$idx] === UPLOAD_ERR_OK) { $hasImages = true; break; }
    }
}

$instructions = '';
$conversation_history = [];
$userMessage = '';
$lastUserText = '';
foreach ($messages as $m) {
    if (!is_array($m) || empty($m['role'])) continue;
    $role = $m['role'];
    $content = isset($m['content']) && is_string($m['content']) ? $m['content'] : '';
    if ($role === 'system') {
        $instructions .= ($instructions !== '' ? "\n" : '') . $content;
        continue;
    }
    $content = preg_replace('/<div style="display: flex; gap: 6px;[\s\S]*<\/div>\s*$/u', '', $content);
    $content = trim($content);
    if ($content === '') continue;
    if ($role === 'user') $lastUserText = $content;
    $conversation_history[] = ['role' => $role, 'content' => $content];
}
if ($lastUserText !== '') {
    $userMessage = $lastUserText;
    array_pop($conversation_history);
}

if (!$hasImages && $userMessage !== '') {
    $runsPayload = [
        'input' => $userMessage,
        'conversation_history' => $conversation_history,
    ];
    if ($instructions !== '') $runsPayload['instructions'] = $instructions;

    $ch = curl_init($baseApi . '/runs');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json'
    ]);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($runsPayload, JSON_UNESCAPED_UNICODE));
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 30);
    curl_setopt($ch, CURLOPT_TIMEOUT, 300);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1); // [patch h11] HTTP/2 putus → force 1.1
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
    $runsJson = curl_exec($ch);
    $runsHttp = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $runsErr = curl_error($ch);


    if ($runsJson === false || $runsHttp >= 400) {
        $errMsg = $runsErr !== '' ? $runsErr : 'HTTP ' . $runsHttp;
        if ($runsJson !== false) {
            $dec = json_decode($runsJson, true);
            if (isset($dec['error']['message'])) $errMsg = $dec['error']['message'];
        }
        $hasImages = true;
        $runId = null;
    } else {
        $runsDec = json_decode($runsJson, true);
        $runId = is_array($runsDec) && isset($runsDec['run_id']) ? $runsDec['run_id'] : null;
        if ($runId === null) {
            $hasImages = true;
        }
    }

    if ($runId !== null) {
        $kaFile = sys_get_temp_dir() . '/c0n73xt_ka_' . md5((string)($_POST['ka_id'] ?? $runId));
        @touch($kaFile);

        // Kasih tahu client run_id-nya SEGERA biar bisa resume kalau koneksi beneran putus
        emit(['type' => 'run_started', 'run_id' => $runId, 'ka_id' => (string)($_POST['ka_id'] ?? '')]);

        $ch = curl_init($baseApi . '/runs/' . rawurlencode($runId) . '/events');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Authorization: Bearer ' . $apiKey,
            'Accept: text/event-stream'
        ]);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 30);
        curl_setopt($ch, CURLOPT_TIMEOUT, 0);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1); // [patch h11] HTTP/2 putus → force 1.1
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);

        $buffer = '';
        $emittedAnything = false;
        $doneSent = false;
        $textStarted = false;
        $approvalPendingSince = 0;
        $runStartedAt = time();

        ignore_user_abort(false);
        function clientIsGone() {
            global $kaFile;
            if ($kaFile !== null) {
                // WAJIB clearstatcache: stat cache PHP menyimpan hasil is_file()/filemtime()
                // PERTAMA selama request stream ini hidup. Beacon dari worker lain
                // (PHP_CLI_SERVER_WORKERS) menyentuh file ini tiap 10 detik, tapi tanpa
                // clearstatcache mtime-nya gak pernah kebaca → stream dibunuh palsu di ~150s.
                clearstatcache(true, $kaFile);
                if (is_file($kaFile)) {
                    return (time() - (int)@filemtime($kaFile)) > 150;
                }
            }
            return connection_aborted() === 1;
        }
        function finishRunStream($ch, $mh, $reason = '') {
            global $kaFile, $doneSent;
            if ($kaFile !== null && is_file($kaFile)) @unlink($kaFile);
            if ($reason !== '') {
                emit(['choices' => [['delta' => ['content' => "\n\n⚠️ " . $reason]]]]);
            }
            if (!$doneSent) emitDone();
            curl_multi_remove_handle($mh, $ch);

            curl_multi_close($mh);
            exit;
        }

        function translateRunEvent($obj) {
            global $emittedAnything, $doneSent, $textStarted, $approvalPendingSince;
            $emittedAnything = true;
            $ev = isset($obj['event']) ? $obj['event'] : '';

            if ($ev === 'tool.started') {
                emit(['type' => 'tool', 'phase' => 'start', 'id' => 'run_tool_' . (isset($obj['timestamp']) ? (string)$obj['timestamp'] : uniqid()), 'name' => isset($obj['tool']) ? $obj['tool'] : 'tool', 'detail' => isset($obj['preview']) ? trunc($obj['preview'], 64) : '']);
            }
            elseif ($ev === 'tool.completed') {
                $dur = isset($obj['duration']) ? $obj['duration'] : 0;
                emit(['type' => 'tool', 'phase' => 'result', 'id' => 'run_tool_done', 'name' => isset($obj['tool']) ? $obj['tool'] : 'tool', 'summary' => (isset($obj['error']) && $obj['error'] ? 'error' : 'ok') . ' · ' . $dur . 's']);
            }
            elseif ($ev === 'reasoning.available') {
                emit(['type' => 'status', 'phase' => 'thinking']);
            }
            elseif ($ev === 'message.delta') {
                if (!$textStarted) { $textStarted = true; emit(['type' => 'status', 'phase' => 'writing']); }
                $d = isset($obj['delta']) ? $obj['delta'] : '';
                if ($d !== '') emit(['choices' => [['delta' => ['content' => $d]]]]);
            }
            elseif ($ev === 'approval.request') {
                $approvalPendingSince = time();
                emit([
                    'type' => 'approval',
                    'run_id' => isset($obj['run_id']) ? $obj['run_id'] : '',
                    'command' => isset($obj['command']) ? $obj['command'] : '',
                    'reason' => isset($obj['reason']) ? $obj['reason'] : (isset($obj['description']) ? $obj['description'] : ''),
                    'choices' => isset($obj['choices']) && is_array($obj['choices']) ? $obj['choices'] : ['once', 'session', 'always', 'deny'],
                    'tool' => isset($obj['tool']) ? $obj['tool'] : ''
                ]);
            }
            elseif ($ev === 'approval.responded') {
                $approvalPendingSince = 0;
                emit(['type' => 'approval_done', 'choice' => isset($obj['choice']) ? $obj['choice'] : '']);
            }
            elseif ($ev === 'run.completed') {
                $usage = isset($obj['usage']) && is_array($obj['usage']) ? $obj['usage'] : [];
                emit([
                    'type' => 'usage',
                    'input_tokens' => isset($usage['input_tokens']) ? $usage['input_tokens'] : 0,
                    'output_tokens' => isset($usage['output_tokens']) ? $usage['output_tokens'] : 0,
                    'total_tokens' => isset($usage['total_tokens']) ? $usage['total_tokens'] : 0
                ]);
                $doneSent = true;
                emitDone();
            }
            elseif ($ev === 'run.failed') {
                emit(['choices' => [['delta' => ['content' => '⚠️ Run gagal: ' . (isset($obj['error']) ? $obj['error'] : 'unknown')]]]]);
                $doneSent = true;
                emitDone();
            }
            elseif ($ev === 'run.cancelled') {
                emit(['choices' => [['delta' => ['content' => '⚠️ Run dibatalkan.']]]]);
                $doneSent = true;
                emitDone();
            }
        }

        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function($curl, $data) {
            global $buffer;
            $buffer .= $data;
            while (($pos = strpos($buffer, "\n\n")) !== false) {
                $block = substr($buffer, 0, $pos);
                $buffer = substr($buffer, $pos + 2);
                $dataJson = '';
                foreach (explode("\n", $block) as $ln) {
                    $ln = rtrim($ln, "\r");
                    if (strncmp($ln, 'data:', 5) === 0) $dataJson .= trim(substr($ln, 5));
                }
                if ($dataJson === '' || $dataJson === '[DONE]') continue;
                $obj = json_decode($dataJson, true);
                if (is_array($obj)) translateRunEvent($obj);
            }
            return strlen($data);
        });

        $mh = curl_multi_init();
        curl_multi_add_handle($mh, $ch);
        $lastKa = time();
        $running = 0;
        do {
            curl_multi_exec($mh, $running);
            if ($running > 0) {
                $sel = @curl_multi_select($mh, 1);
                if ($sel === -1) usleep(100000);
            }
            if (clientIsGone()) {
                finishRunStream($ch, $mh);
            }
            if ($approvalPendingSince > 0 && (time() - $approvalPendingSince) > 900) {
                finishRunStream($ch, $mh, 'Approval gak dijawab 15 menit — run dibatalkan.');
            }
            if ((time() - $runStartedAt) > 1800) {
                finishRunStream($ch, $mh, 'Run melebihi 30 menit — dibatalkan biar server tetep sehat.');
            }
            if ($running > 0 && !$doneSent && (time() - $lastKa) >= 15) {
                $lastKa = time();
                echo ": ka\n\n";
                flush();
            }
        } while ($running > 0);

        $curlErrno = curl_errno($ch);
        $curlError = curl_error($ch);
        curl_multi_remove_handle($mh, $ch);

        curl_multi_close($mh);

        $rest = trim($buffer);
        if ($rest !== '') {
            foreach (explode("\n", $rest) as $ln) {
                $ln = trim($ln);
                if (strncmp($ln, 'data:', 5) === 0) {
                    $obj = json_decode(trim(substr($ln, 5)), true);
                    if (is_array($obj)) translateRunEvent($obj);
                }
            }
        }

        if (isset($kaFile) && is_file($kaFile)) @unlink($kaFile);

        if ($curlErrno !== 0) {
            emit(['choices' => [['delta' => ['content' => '⚠️ **System Error:** stream run gagal - ' . $curlError]]]]);
        }
        if (!$doneSent) emitDone();
        exit;
    }
}

$input = [];
foreach ($conversation_history as $hm) {
    $input[] = [
        'type' => 'message',
        'role' => $hm['role'],
        'content' => [($hm['role'] === 'user' ? ['type' => 'input_text', 'text' => $hm['content']] : ['type' => 'output_text', 'text' => $hm['content']])]
    ];
}
if ($userMessage !== '') {
    $input[] = [
        'type' => 'message',
        'role' => 'user',
        'content' => [['type' => 'input_text', 'text' => $userMessage]]
    ];
}

if (!empty($_FILES['images']) && is_array($_FILES['images']['name'])) {
    $lastUserIdx = -1;
    foreach ($input as $i => $item) {
        if (isset($item['role']) && $item['role'] === 'user') $lastUserIdx = $i;
    }
    if ($lastUserIdx === -1) {
        $input[] = ['type' => 'message', 'role' => 'user', 'content' => []];
        $lastUserIdx = count($input) - 1;
    }
    foreach ($_FILES['images']['name'] as $idx => $name) {
        if ($_FILES['images']['error'][$idx] !== UPLOAD_ERR_OK) continue;
        $tmpName = $_FILES['images']['tmp_name'][$idx];
        $fileType = mime_content_type($tmpName);
        if (strpos($fileType, 'image/') === 0) {
            $imgData = base64_encode(file_get_contents($tmpName));
            $input[$lastUserIdx]['content'][] = [
                'type' => 'input_image',
                'image_url' => 'data:' . $fileType . ';base64,' . $imgData
            ];
        }
    }
}

if (empty($input)) {
    emit(['choices' => [['delta' => ['content' => '⚠️ Tidak ada pesan yang bisa diproses.']]]]);
    emitDone();
    exit;
}

$payload = [
    'model' => $model,
    'input' => $input,
    'stream' => true
];
if ($instructions !== '') $payload['instructions'] = $instructions;

$buffer = '';
$emittedAnything = false;
$doneSent = false;
$endedCalls = [];
$resultsSent = [];

function processUpstreamBlock($block) {
    global $emittedAnything, $doneSent, $endedCalls, $resultsSent;

    $dataJson = '';
    $lines = explode("\n", $block);
    foreach ($lines as $ln) {
        $ln = rtrim($ln, "\r");
        if (strncmp($ln, 'data:', 5) === 0) {
            $dataJson .= trim(substr($ln, 5));
        } elseif ($ln !== '' && $ln[0] === ':') {
            echo ": ka\n\n";
            flush();
        }
    }
    if ($dataJson === '' || $dataJson === '[DONE]') return;

    $obj = json_decode($dataJson, true);
    if (!is_array($obj)) return;

    $emittedAnything = true;
    $type = isset($obj['type']) ? $obj['type'] : '';
    $item = isset($obj['item']) && is_array($obj['item']) ? $obj['item'] : null;

    if ($type === 'response.created') {
        emit(['type' => 'status', 'phase' => 'thinking']);
    }
    elseif ($type === 'response.output_item.added' && $item) {
        $itype = isset($item['type']) ? $item['type'] : '';
        if ($itype === 'function_call') {
            $callId = isset($item['call_id']) ? $item['call_id'] : 'idx_' . (isset($obj['output_index']) ? $obj['output_index'] : rand());
            emit([
                'type' => 'tool',
                'phase' => 'start',
                'id' => $callId,
                'name' => isset($item['name']) ? $item['name'] : 'tool',
                'detail' => toolDetailFromArgs(isset($item['arguments']) ? $item['arguments'] : '')
            ]);
        }
        elseif ($itype === 'function_call_output') {
            $callId = isset($item['call_id']) ? $item['call_id'] : '';
            if ($callId === '' || !in_array($callId, $resultsSent)) {
                if ($callId !== '') $resultsSent[] = $callId;
                $txt = '';
                if (isset($item['output']) && is_array($item['output'])) {
                    foreach ($item['output'] as $op) {
                        if (isset($op['text'])) $txt .= $op['text'];
                    }
                }
                emit([
                    'type' => 'tool',
                    'phase' => 'result',
                    'id' => $callId,
                    'summary' => summarizeToolOutput($txt)
                ]);
            }
        }
        elseif ($itype === 'reasoning') {
            emit(['type' => 'status', 'phase' => 'thinking']);
        }
        elseif ($itype === 'message') {
            emit(['type' => 'status', 'phase' => 'writing']);
        }
    }
    elseif ($type === 'response.output_item.done' && $item) {
        $itype = isset($item['type']) ? $item['type'] : '';
        if ($itype === 'function_call') {
            $callId = isset($item['call_id']) ? $item['call_id'] : '';
            if ($callId !== '' && !in_array($callId, $endedCalls)) {
                $endedCalls[] = $callId;
                emit([
                    'type' => 'tool',
                    'phase' => 'end',
                    'id' => $callId,
                    'name' => isset($item['name']) ? $item['name'] : 'tool'
                ]);
            }
        }
        elseif ($itype === 'function_call_output') {
            $callId = isset($item['call_id']) ? $item['call_id'] : '';
            if ($callId !== '' && !in_array($callId, $resultsSent)) {
                $resultsSent[] = $callId;
                $txt = '';
                if (isset($item['output']) && is_array($item['output'])) {
                    foreach ($item['output'] as $op) {
                        if (isset($op['text'])) $txt .= $op['text'];
                    }
                }
                emit([
                    'type' => 'tool',
                    'phase' => 'result',
                    'id' => $callId,
                    'summary' => summarizeToolOutput($txt)
                ]);
            }
        }
    }
    elseif ($type === 'response.output_text.delta') {
        $d = isset($obj['delta']) ? $obj['delta'] : '';
        if ($d !== '') {
            emit(['choices' => [['delta' => ['content' => $d]]]]);
        }
    }
    elseif ($type === 'response.completed') {
        $usage = isset($obj['response']['usage']) && is_array($obj['response']['usage']) ? $obj['response']['usage'] : [];
        emit([
            'type' => 'usage',
            'input_tokens' => isset($usage['input_tokens']) ? $usage['input_tokens'] : 0,
            'output_tokens' => isset($usage['output_tokens']) ? $usage['output_tokens'] : 0,
            'total_tokens' => isset($usage['total_tokens']) ? $usage['total_tokens'] : 0
        ]);
        $doneSent = true;
        emitDone();
    }
    elseif ($type === 'response.failed' || $type === 'response.incomplete' || $type === 'error') {
        $msg = '⚠️ Response gagal.';
        if (isset($obj['response']['error']['message'])) $msg = '⚠️ ' . $obj['response']['error']['message'];
        elseif (isset($obj['message'])) $msg = '⚠️ ' . $obj['message'];
        emit(['choices' => [['delta' => ['content' => $msg]]]]);
        $doneSent = true;
        emitDone();
    }
}

$ch = curl_init($responsesEndpoint);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $apiKey,
    'Content-Type: application/json',
    'Accept: text/event-stream'
]);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE));
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 30);
curl_setopt($ch, CURLOPT_TIMEOUT, 0);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1); // [patch h11] HTTP/2 putus → force 1.1
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);

curl_setopt($ch, CURLOPT_WRITEFUNCTION, function($curl, $data) {
    global $buffer, $emittedAnything;

    if (!$emittedAnything) {
        $trimmed = ltrim((string)$data);
        if ($trimmed !== '' && $trimmed[0] === '{' && strpos($trimmed, '"error"') !== false) {
            $decoded = json_decode($trimmed, true);
            $msg = isset($decoded['error']['message']) ? $decoded['error']['message'] : $trimmed;
            emit(['choices' => [['delta' => ['content' => '⚠️ Gateway error: ' . $msg]]]]);
            $emittedAnything = true;
            return strlen($data);
        }
    }

    $buffer .= $data;
    while (($pos = strpos($buffer, "\n\n")) !== false) {
        $block = substr($buffer, 0, $pos);
        $buffer = substr($buffer, $pos + 2);
        processUpstreamBlock($block);
    }
    return strlen($data);
});

$mh = curl_multi_init();
curl_multi_add_handle($mh, $ch);

$kaFile = sys_get_temp_dir() . '/c0n73xt_ka_' . md5((string)($_POST['ka_id'] ?? 'fallback'));
if (!empty($_POST['ka_id'])) @touch($kaFile); else $kaFile = null;

$lastKa = time();
$runStartedAt = time();
$running = 0;

function finishFallbackStream($ch, $mh, $reason = '') {
    global $kaFile, $doneSent;
    if ($kaFile !== null && is_file($kaFile)) {
        clearstatcache(true, $kaFile);
        @unlink($kaFile);
    }
    if ($reason !== '') {
        emit(['choices' => [['delta' => ['content' => "\n\n⚠️ " . $reason]]]]);
    }
    if (!$doneSent) emitDone();
    curl_multi_remove_handle($mh, $ch);

    curl_multi_close($mh);
    exit;
}

function fallbackClientIsGone() {
    global $kaFile;
    if ($kaFile !== null) {
        clearstatcache(true, $kaFile);
        if (is_file($kaFile)) {
            return (time() - (int)@filemtime($kaFile)) > 150;
        }
    }
    return connection_aborted() === 1;
}

do {
    curl_multi_exec($mh, $running);
    if ($running > 0) {
        $sel = @curl_multi_select($mh, 1);
        if ($sel === -1) usleep(100000);
    }
    ignore_user_abort(false);
    if (fallbackClientIsGone()) {
        finishFallbackStream($ch, $mh);
    }
    if ((time() - $runStartedAt) > 1800) {
        finishFallbackStream($ch, $mh, 'Run melebihi 30 menit — dibatalkan biar server tetep sehat.');
    }
    if ($running > 0 && !$doneSent && (time() - $lastKa) >= 15) {
        $lastKa = time();
        echo ": ka\n\n";
        flush();
    }
} while ($running > 0);

$curlErrno = curl_errno($ch);
$curlError = curl_error($ch);
curl_multi_remove_handle($mh, $ch);

curl_multi_close($mh);

if ($kaFile !== null && is_file($kaFile)) {
    clearstatcache(true, $kaFile);
    @unlink($kaFile);
}

$rest = trim($buffer);
if ($rest !== '') {
    processUpstreamBlock($rest);
}

if ($curlErrno !== 0) {
    emit(['choices' => [['delta' => ['content' => '⚠️ **System Error:** cURL gagal - ' . $curlError]]]]);
}

if (!$doneSent) {
    emitDone();
}
