<?php

// Fungsi inti untuk membaca .ai-config.ini dengan lebih aman dan rapi
if (!function_exists('native_config_get')) {
    function native_config_get($key, $default = '') {
        $f = __DIR__ . '/.ai-config.ini';
        if (!file_exists($f)) return $default;

        $lines = file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        foreach ($lines as $line) {
            $line = trim($line);
            
            // Lewatkan baris komentar (# atau ;)
            if ($line === '' || $line[0] === '#' || $line[0] === ';') {
                continue;
            }

            // Pisahkan berdasarkan tanda sama dengan (=)
            $parts = explode('=', $line, 2);
            if (count($parts) === 2) {
                $currentKey = trim($parts[0]);
                if ($currentKey === $key) {
                    // Bersihkan nilai dari kutip kiri/kanan jika ada (misal: "sk-xxx" jadi sk-xxx)
                    return trim($parts[1], " \t\n\r\0\x0B\"'");
                }
            }
        }
        return $default;
    }
}

// Wrapper untuk integer
if (!function_exists('native_config_int')) {
    function native_config_int($key, $default) {
        $val = native_config_get($key, '');
        if ($val !== '' && preg_match('/^\d+$/', $val)) {
            return (int)$val;
        }
        return $default;
    }
}

// Wrapper untuk string
if (!function_exists('native_config_str')) {
    function native_config_str($key, $default = '') {
        $val = native_config_get($key, null);
        return ($val !== null) ? $val : $default;
    }
}
