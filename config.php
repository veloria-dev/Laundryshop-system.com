<?php
// =====================================================
// CleanPro Laundry - Configuration & shared helpers
// Edit ONLY the 4 DB_* lines below with your InfinityFree details
// (InfinityFree panel -> MySQL Databases).
// =====================================================

define('DB_HOST', 'sql305.infinityfree.com');      // NOT "localhost" on InfinityFree
define('DB_USER', 'if0_43135859');
define('DB_PASS', 'HhRCkyZxcpW3l');
define('DB_NAME', 'if0_43135859_loundryshop');

define('APP_DEBUG', false);          // true = show real error messages (turn off when live)
define('PASSWORD_MIN_LENGTH', 6);
define('MAX_LOGIN_ATTEMPTS', 5);     // failed attempts per email ...
define('LOCKOUT_SECONDS', 900);      // ... within this window (15 min)
define('SESSION_TIMEOUT', 28800);    // 8 hours of inactivity

date_default_timezone_set('Asia/Manila');

ini_set('display_errors', APP_DEBUG ? '1' : '0');
error_reporting(E_ALL);
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

// ---------- Session (native PHP sessions) ----------
if (session_status() === PHP_SESSION_NONE) {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
          || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_name('cleanpro_sid');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => $https,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

// ---------- JSON responses ----------
function json_out($data = null, $message = 'OK', $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['status' => 'success', 'message' => $message, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function json_error($message, $code = 400, $extra = null) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['status' => 'error', 'message' => $message, 'data' => $extra], JSON_UNESCAPED_UNICODE);
    exit;
}

set_exception_handler(function ($e) {
    error_log('CleanPro: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    json_error(APP_DEBUG ? $e->getMessage() : 'Server error. Please try again.', 500);
});

// ---------- Database ----------
function db() {
    static $conn = null;
    if ($conn === null) {
        try {
            $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
            $conn->set_charset('utf8mb4');
        } catch (Throwable $e) {
            error_log('CleanPro DB connect failed: ' . $e->getMessage());
            json_error(APP_DEBUG ? 'Database connection failed: ' . $e->getMessage() : 'Database connection failed', 500);
        }
    }
    return $conn;
}

// ---------- Request helpers ----------
function request_json() {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// CSRF defence: browsers can't add custom headers on cross-site form posts.
function require_post() {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_error('Method not allowed', 405);
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'cleanpro') json_error('Invalid request', 403);
}

// ---------- Text safety ----------
// Free text is rendered with innerHTML by the front-end, so neutralise markup on the way in.
function clean_text($v, $max = 255) {
    if (!is_string($v)) $v = is_scalar($v) ? (string)$v : '';
    $v = trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', '', $v));
    if (function_exists('mb_substr')) $v = mb_substr($v, 0, $max, 'UTF-8'); else $v = substr($v, 0, $max);
    return str_replace(['<', '>', '"'], ['&lt;', '&gt;', '&quot;'], $v);
}

function clean_id($v) {
    return (is_string($v) && preg_match('/^[A-Za-z0-9._-]{1,64}$/', $v)) ? $v : null;
}

function new_id($prefix) {
    return $prefix . bin2hex(random_bytes(6));
}

// ---------- Users / auth ----------
function user_to_json(array $r) {
    return [
        'id'        => $r['id'],
        'firstName' => $r['first_name'],
        'lastName'  => $r['last_name'],
        'email'     => $r['email'],
        'phone'     => $r['phone'] ?? '',
        'address'   => $r['address'] ?? '',
        'role'      => $r['role'],
        'status'    => $r['status'],
        'createdAt' => $r['created_at'] ?? null,
    ];
}

function current_user() {
    static $cache = false;
    if ($cache !== false) return $cache;
    $cache = null;
    if (empty($_SESSION['uid'])) return null;
    if (time() - ($_SESSION['seen'] ?? 0) > SESSION_TIMEOUT) {
        $_SESSION = [];
        return null;
    }
    $stmt = db()->prepare('SELECT id, first_name, last_name, email, phone, address, role, status, created_at FROM users WHERE id = ? AND status = \'active\' LIMIT 1');
    $stmt->bind_param('s', $_SESSION['uid']);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    if (!$row) { $_SESSION = []; return null; }
    $_SESSION['seen'] = time();
    return $cache = user_to_json($row);
}

function require_login() {
    $u = current_user();
    if (!$u) json_error('Not authenticated', 401);
    return $u;
}

function require_owner() {
    $u = require_login();
    if ($u['role'] !== 'owner') json_error('Owner access required', 403);
    return $u;
}

function login_session($userId) {
    session_regenerate_id(true);
    $_SESSION['uid']  = $userId;
    $_SESSION['seen'] = time();
}
