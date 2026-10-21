<?php
// =====================================================
// CleanPro Laundry - Authentication & user management API
//   GET  auth.php?action=me
//   POST auth.php?action=login | register | logout | profile
//   POST auth.php?action=create-staff | user-status | user-password   (owner only)
// =====================================================
require_once __DIR__ . '/config.php';

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'me':            handle_me(); break;
    case 'login':         require_post(); handle_login(); break;
    case 'register':      require_post(); handle_register(); break;
    case 'logout':        require_post(); handle_logout(); break;
    case 'profile':       require_post(); handle_profile(); break;
    case 'create-staff':  require_post(); handle_create_staff(); break;
    case 'user-status':   require_post(); handle_user_status(); break;
    case 'user-password': require_post(); handle_user_password(); break;
    default:              json_error('Invalid action', 400);
}

function valid_email($e) { return filter_var($e, FILTER_VALIDATE_EMAIL) !== false && strlen($e) <= 255; }

function email_taken($email, $exceptId = null) {
    $stmt = db()->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $stmt->bind_param('s', $email);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    return $row && $row['id'] !== $exceptId;
}

function fetch_user_json($id) {
    $stmt = db()->prepare('SELECT id, first_name, last_name, email, phone, address, role, status, created_at FROM users WHERE id = ? LIMIT 1');
    $stmt->bind_param('s', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    return $row ? user_to_json($row) : null;
}

// ---------------------------------------------------
function handle_me() {
    json_out(['user' => current_user()]);
}

// ---------------------------------------------------
function handle_login() {
    $d = request_json();
    $email = strtolower(trim((string)($d['email'] ?? '')));
    $password = (string)($d['password'] ?? '');
    if ($email === '' || $password === '') json_error('Email and password are required', 400);

    // Throttle failed attempts per email
    $db = db();
    $db->query('DELETE FROM login_attempts WHERE attempted_at < (NOW() - INTERVAL 1 DAY)');
    $win = LOCKOUT_SECONDS;
    $stmt = $db->prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND attempted_at > (NOW() - INTERVAL ? SECOND)');
    $stmt->bind_param('si', $email, $win);
    $stmt->execute();
    $count = (int)$stmt->get_result()->fetch_assoc()['c'];
    if ($count >= MAX_LOGIN_ATTEMPTS) json_error('Too many failed attempts. Please try again in 15 minutes.', 429);

    $stmt = $db->prepare('SELECT id, password, status FROM users WHERE email = ? LIMIT 1');
    $stmt->bind_param('s', $email);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();

    if (!$row || !password_verify($password, $row['password'])) {
        $ins = $db->prepare('INSERT INTO login_attempts (email) VALUES (?)');
        $ins->bind_param('s', $email);
        $ins->execute();
        json_error('Invalid email or password.', 401);
    }
    if ($row['status'] !== 'active') json_error('Your account is currently disabled. Contact administration.', 403);

    $clr = $db->prepare('DELETE FROM login_attempts WHERE email = ?');
    $clr->bind_param('s', $email);
    $clr->execute();

    login_session($row['id']);
    json_out(['user' => fetch_user_json($row['id'])], 'Login successful');
}

// ---------------------------------------------------
function handle_register() {
    $d = request_json();
    $first = clean_text($d['firstName'] ?? '', 100);
    $last  = clean_text($d['lastName'] ?? '', 100);
    $email = strtolower(trim((string)($d['email'] ?? '')));
    $pass  = (string)($d['password'] ?? '');
    $phone = clean_text($d['phone'] ?? '', 40);
    $addr  = clean_text($d['address'] ?? '', 500);

    if ($first === '' || $last === '') json_error('First and last name are required', 400);
    if (!valid_email($email)) json_error('A valid email is required', 400);
    if (strlen($pass) < PASSWORD_MIN_LENGTH) json_error('Password must be at least ' . PASSWORD_MIN_LENGTH . ' characters', 400);
    if (email_taken($email)) json_error('This email is already registered. Please sign in.', 409);

    $id = new_id('usr-');
    $hash = password_hash($pass, PASSWORD_BCRYPT);
    $role = 'customer';
    $stmt = db()->prepare('INSERT INTO users (id, first_name, last_name, email, password, phone, address, role, status) VALUES (?,?,?,?,?,?,?,?,\'active\')');
    $stmt->bind_param('ssssssss', $id, $first, $last, $email, $hash, $phone, $addr, $role);
    $stmt->execute();

    login_session($id);
    json_out(['user' => fetch_user_json($id)], 'Account created', 201);
}

// ---------------------------------------------------
function handle_logout() {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 3600, $p['path'], $p['domain'] ?? '', $p['secure'], $p['httponly']);
    }
    session_destroy();
    json_out(null, 'Logged out');
}

// ---------------------------------------------------
// Update the signed-in user's own profile (any subset of fields)
function handle_profile() {
    $me = require_login();
    $d = request_json();
    $sets = []; $vals = []; $types = '';

    if (array_key_exists('firstName', $d)) {
        $v = clean_text($d['firstName'], 100);
        if ($v === '') json_error('First name cannot be empty', 400);
        $sets[] = 'first_name = ?'; $vals[] = $v; $types .= 's';
    }
    if (array_key_exists('lastName', $d)) {
        $v = clean_text($d['lastName'], 100);
        if ($v === '') json_error('Last name cannot be empty', 400);
        $sets[] = 'last_name = ?'; $vals[] = $v; $types .= 's';
    }
    if (array_key_exists('email', $d)) {
        $v = strtolower(trim((string)$d['email']));
        if (!valid_email($v)) json_error('A valid email is required', 400);
        if (email_taken($v, $me['id'])) json_error('That email is already in use', 409);
        $sets[] = 'email = ?'; $vals[] = $v; $types .= 's';
    }
    if (array_key_exists('phone', $d)) {
        $sets[] = 'phone = ?'; $vals[] = clean_text($d['phone'], 40); $types .= 's';
    }
    if (array_key_exists('address', $d)) {
        $sets[] = 'address = ?'; $vals[] = clean_text($d['address'], 500); $types .= 's';
    }
    if (array_key_exists('password', $d) && $d['password'] !== '') {
        $p = (string)$d['password'];
        if (strlen($p) < PASSWORD_MIN_LENGTH) json_error('Password must be at least ' . PASSWORD_MIN_LENGTH . ' characters', 400);
        $sets[] = 'password = ?'; $vals[] = password_hash($p, PASSWORD_BCRYPT); $types .= 's';
    }
    if (!$sets) json_error('Nothing to update', 400);

    $vals[] = $me['id']; $types .= 's';
    $stmt = db()->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?');
    $stmt->bind_param($types, ...$vals);
    $stmt->execute();

    json_out(['user' => fetch_user_json($me['id'])], 'Profile updated');
}

// ---------------------------------------------------
function handle_create_staff() {
    require_owner();
    $d = request_json();
    $first = clean_text($d['firstName'] ?? '', 100);
    $last  = clean_text($d['lastName'] ?? '', 100);
    $email = strtolower(trim((string)($d['email'] ?? '')));
    $pass  = (string)($d['password'] ?? '');
    $phone = clean_text($d['phone'] ?? '', 40);

    if ($first === '' || $last === '') json_error('First and last name are required', 400);
    if (!valid_email($email)) json_error('A valid email is required', 400);
    if (strlen($pass) < PASSWORD_MIN_LENGTH) json_error('Password must be at least ' . PASSWORD_MIN_LENGTH . ' characters', 400);
    if (email_taken($email)) json_error('This email is already in use.', 409);

    $id = new_id('usr-staff-');
    $hash = password_hash($pass, PASSWORD_BCRYPT);
    $addr = '';
    $role = 'staff';
    $stmt = db()->prepare('INSERT INTO users (id, first_name, last_name, email, password, phone, address, role, status) VALUES (?,?,?,?,?,?,?,?,\'active\')');
    $stmt->bind_param('ssssssss', $id, $first, $last, $email, $hash, $phone, $addr, $role);
    $stmt->execute();

    json_out(['user' => fetch_user_json($id)], 'Staff member added', 201);
}

// ---------------------------------------------------
function handle_user_status() {
    $me = require_owner();
    $d = request_json();
    $id = clean_id($d['id'] ?? null);
    $status = $d['status'] ?? '';
    if (!$id || !in_array($status, ['active', 'inactive'], true)) json_error('Invalid request', 400);
    if ($id === $me['id']) json_error('You cannot change your own status', 400);

    $stmt = db()->prepare('UPDATE users SET status = ? WHERE id = ?');
    $stmt->bind_param('ss', $status, $id);
    $stmt->execute();
    if ($stmt->affected_rows === 0 && !fetch_user_json($id)) json_error('User not found', 404);
    json_out(['user' => fetch_user_json($id)], 'Status updated');
}

// ---------------------------------------------------
function handle_user_password() {
    require_owner();
    $d = request_json();
    $id = clean_id($d['id'] ?? null);
    $pass = (string)($d['password'] ?? '');
    if (!$id) json_error('Invalid request', 400);
    if (strlen($pass) < PASSWORD_MIN_LENGTH) json_error('Password must be at least ' . PASSWORD_MIN_LENGTH . ' characters', 400);
    if (!fetch_user_json($id)) json_error('User not found', 404);

    $hash = password_hash($pass, PASSWORD_BCRYPT);
    $stmt = db()->prepare('UPDATE users SET password = ? WHERE id = ?');
    $stmt->bind_param('ss', $hash, $id);
    $stmt->execute();
    json_out(null, 'Password reset');
}
