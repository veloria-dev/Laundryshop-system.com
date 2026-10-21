<?php
// =====================================================
// CleanPro Laundry - ONE-TIME SETUP
// Open this page once in your browser to (1) test the database connection
// and (2) create the owner account. Then DELETE this file from the server.
// =====================================================
require_once __DIR__ . '/api/config.php';

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');

function page($title, $body) {
    echo '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
       . '<title>' . htmlspecialchars($title) . '</title><style>'
       . 'body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f1f5f9;margin:0;padding:2rem 1rem;color:#0f172a}'
       . '.box{max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:1.75rem;box-shadow:0 4px 20px rgba(0,0,0,.08)}'
       . 'h1{font-size:1.3rem;margin:0 0 1rem}label{display:block;font-weight:600;font-size:.85rem;margin:.9rem 0 .3rem}'
       . 'input{width:100%;box-sizing:border-box;padding:.65rem;border:1px solid #cbd5e1;border-radius:8px;font-size:1rem}'
       . 'button{margin-top:1.25rem;width:100%;padding:.8rem;border:0;border-radius:8px;background:#0284c7;color:#fff;font-size:1rem;font-weight:700;cursor:pointer}'
       . '.ok{background:#dcfce7;border:1px solid #86efac;padding:.8rem;border-radius:8px;margin-bottom:1rem}'
       . '.err{background:#fee2e2;border:1px solid #fca5a5;padding:.8rem;border-radius:8px;margin-bottom:1rem}'
       . '.warn{background:#fef9c3;border:1px solid #fde047;padding:.8rem;border-radius:8px;margin-top:1rem}'
       . '</style></head><body><div class="box"><h1>' . htmlspecialchars($title) . '</h1>' . $body . '</div></body></html>';
    exit;
}

// 1. Database connection test
try {
    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    $conn->set_charset('utf8mb4');
} catch (Throwable $e) {
    page('Database connection failed',
        '<div class="err"><b>Could not connect.</b><br>Check the four DB_* lines in <code>api/config.php</code> '
        . '(host, username, password, database name from the InfinityFree panel).<br><small>'
        . htmlspecialchars($e->getMessage()) . '</small></div>');
}

// 2. Tables imported?
try {
    $conn->query('SELECT 1 FROM users LIMIT 1');
    $conn->query('SELECT 1 FROM app_records LIMIT 1');
} catch (Throwable $e) {
    page('Database is empty',
        '<div class="err">Connected, but the tables are missing. Import <code>database.sql</code> in phpMyAdmin first, then reload this page.</div>');
}

// 3. Already set up?
$has = $conn->query("SELECT COUNT(*) c FROM users WHERE role = 'owner'")->fetch_assoc();
if ((int)$has['c'] > 0) {
    page('Already set up',
        '<div class="ok">An owner account already exists. Setup is finished.</div>'
        . '<div class="warn"><b>Delete <code>setup.php</code> from your server now.</b></div>');
}

// 4. Create owner
$msg = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $ok = hash_equals($_SESSION['setup_token'] ?? '', (string)($_POST['token'] ?? ''));
    $first = clean_text($_POST['first'] ?? '', 100);
    $last  = clean_text($_POST['last'] ?? '', 100);
    $email = strtolower(trim((string)($_POST['email'] ?? '')));
    $pass  = (string)($_POST['password'] ?? '');

    if (!$ok) $msg = 'Session expired. Reload the page and try again.';
    elseif ($first === '' || $last === '') $msg = 'Please enter first and last name.';
    elseif (!filter_var($email, FILTER_VALIDATE_EMAIL)) $msg = 'Please enter a valid email.';
    elseif (strlen($pass) < 8) $msg = 'Use a password of at least 8 characters for the owner account.';
    else {
        $id = new_id('usr-owner-');
        $hash = password_hash($pass, PASSWORD_BCRYPT);
        $role = 'owner'; $phone = ''; $addr = '';
        $stmt = $conn->prepare("INSERT INTO users (id, first_name, last_name, email, password, phone, address, role, status) VALUES (?,?,?,?,?,?,?,?, 'active')");
        $stmt->bind_param('ssssssss', $id, $first, $last, $email, $hash, $phone, $addr, $role);
        $stmt->execute();
        unset($_SESSION['setup_token']);
        $deleted = @unlink(__FILE__);
        page('Owner account created',
            '<div class="ok">Done! You can now sign in at the home page with <b>' . htmlspecialchars($email) . '</b>.</div>'
            . ($deleted
                ? '<div class="ok">setup.php was deleted automatically.</div>'
                : '<div class="warn"><b>Important:</b> delete <code>setup.php</code> from your server manually (File Manager / FTP).</div>')
            . '<p><a href="index.html">Go to the login page &rarr;</a></p>');
    }
}

$_SESSION['setup_token'] = bin2hex(random_bytes(16));
page('Create the owner account',
    ($msg ? '<div class="err">' . htmlspecialchars($msg) . '</div>' : '<div class="ok">Database connection OK.</div>')
    . '<form method="post" autocomplete="off">'
    . '<input type="hidden" name="token" value="' . $_SESSION['setup_token'] . '">'
    . '<label>First name</label><input name="first" required value="' . htmlspecialchars($_POST['first'] ?? '') . '">'
    . '<label>Last name</label><input name="last" required value="' . htmlspecialchars($_POST['last'] ?? '') . '">'
    . '<label>Email (used to sign in)</label><input name="email" type="email" required value="' . htmlspecialchars($_POST['email'] ?? '') . '">'
    . '<label>Password (min 8 characters)</label><input name="password" type="password" required minlength="8">'
    . '<button type="submit">Create owner account</button></form>'
    . '<div class="warn">Delete this file after use.</div>');
