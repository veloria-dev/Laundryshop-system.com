<?php
// =====================================================
// CleanPro Laundry - Data API
//   GET  data.php?action=public   shop branding + settings (no login needed)
//   GET  data.php?action=load     everything the signed-in user may see
//   POST data.php?action=save     { collection, upserts:[...], deletes:[ids] }
//
// All business rules are enforced HERE on the server, per role:
//   customer : may create own bookings/orders, cancel own scheduled bookings, read own notifications
//   staff    : may check in / update orders, write queue entries and notifications
//   owner    : everything (services, slots, announcements, shop, settings ...)
// =====================================================
require_once __DIR__ . '/config.php';

const LIST_COLLECTIONS   = ['services', 'timeSlots', 'appointments', 'orders', 'queueEntries', 'pickupSchedules', 'announcements', 'notifications'];
const SINGLE_COLLECTIONS = ['shop', 'settings'];
const DELETABLE          = ['services', 'timeSlots', 'announcements', 'pickupSchedules'];
const ORDER_STATUSES     = ['pending', 'processing', 'ready-for-pickup', 'picked-up'];

$action = $_GET['action'] ?? '';
switch ($action) {
    case 'public': public_info(); break;
    case 'load':   load_all(); break;
    case 'save':   require_post(); save_changes(); break;
    default:       json_error('Invalid action', 400);
}

// ---------------------------------------------------
// Low-level record store
// ---------------------------------------------------
function rec_get($col, $id, $forUpdate = false) {
    if (!$id) return null;
    $sql = 'SELECT body FROM app_records WHERE collection = ? AND record_id = ?' . ($forUpdate ? ' FOR UPDATE' : '');
    $stmt = db()->prepare($sql);
    $stmt->bind_param('ss', $col, $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    return $row ? json_decode($row['body'], true) : null;
}

function rec_put($col, $id, $ownerId, array $body) {
    $json = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    $stmt = db()->prepare('INSERT INTO app_records (collection, record_id, owner_id, body) VALUES (?,?,?,?)
                           ON DUPLICATE KEY UPDATE owner_id = VALUES(owner_id), body = VALUES(body)');
    $stmt->bind_param('ssss', $col, $id, $ownerId, $json);
    $stmt->execute();
}

// Insert only if it does not exist yet (never overwrites, e.g. a notification already marked read)
function rec_insert_ignore($col, $id, $ownerId, array $body) {
    $json = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    $stmt = db()->prepare('INSERT IGNORE INTO app_records (collection, record_id, owner_id, body) VALUES (?,?,?,?)');
    $stmt->bind_param('ssss', $col, $id, $ownerId, $json);
    $stmt->execute();
}

function rec_delete($col, $id) {
    $stmt = db()->prepare('DELETE FROM app_records WHERE collection = ? AND record_id = ?');
    $stmt->bind_param('ss', $col, $id);
    $stmt->execute();
}

function rec_list($col, $ownerId = null) {
    if ($ownerId === null) {
        $stmt = db()->prepare('SELECT body FROM app_records WHERE collection = ? ORDER BY seq');
        $stmt->bind_param('s', $col);
    } else {
        $stmt = db()->prepare('SELECT body FROM app_records WHERE collection = ? AND owner_id = ? ORDER BY seq');
        $stmt->bind_param('ss', $col, $ownerId);
    }
    $stmt->execute();
    $res = $stmt->get_result();
    $out = [];
    while ($row = $res->fetch_assoc()) {
        $d = json_decode($row['body'], true);
        if (is_array($d)) $out[] = $d;
    }
    return $out;
}

function shop_defaults() {
    return ['name' => 'CleanPro Laundry', 'tagline' => '', 'logo' => 'laundry.jpg', 'phone' => '', 'email' => '', 'address' => '',
            'openingTime' => '08:00', 'closingTime' => '19:00', 'currency' => '₱'];
}
function settings_defaults() {
    return ['bookingWindow' => 30, 'rescheduleWindow' => 24, 'cancelWindow' => 24, 'pickupMode' => 'admin'];
}

function strip_id($rec) { if (is_array($rec)) unset($rec['id']); return $rec; }

// ---------------------------------------------------
// Reads
// ---------------------------------------------------
function public_info() {
    $shop = rec_get('shop', 'main') ?: [];
    $settings = rec_get('settings', 'main') ?: [];
    json_out([
        'shop'     => array_merge(shop_defaults(), strip_id($shop)),
        'settings' => array_merge(settings_defaults(), strip_id($settings)),
    ]);
}

function load_all() {
    $u = require_login();
    $priv = in_array($u['role'], ['owner', 'staff'], true);
    $db = db();

    // Anyone who joined (or whose announcement just started) while it is still running gets its notification now
    if ($u['role'] !== 'owner') ensure_announcement_notifications($u['id']);

    if ($priv) {
        $users = [];
        $res = $db->query('SELECT id, first_name, last_name, email, phone, address, role, status, created_at FROM users ORDER BY created_at');
        while ($r = $res->fetch_assoc()) $users[] = user_to_json($r);
    } else {
        $users = [$u];
    }

    $shop = rec_get('shop', 'main') ?: [];
    $settings = rec_get('settings', 'main') ?: [];

    json_out([
        'me'              => $u,
        'users'           => $users,
        'services'        => rec_list('services'),
        'timeSlots'       => rec_list('timeSlots'),
        'announcements'   => rec_list('announcements'),
        'appointments'    => $priv ? rec_list('appointments') : rec_list('appointments', $u['id']),
        'orders'          => $priv ? rec_list('orders')       : rec_list('orders', $u['id']),
        'notifications'   => rec_list('notifications', $u['id']),
        'queueEntries'    => $priv ? rec_list('queueEntries')    : [],
        'pickupSchedules' => $priv ? rec_list('pickupSchedules') : [],
        'shop'            => array_merge(shop_defaults(), strip_id($shop)),
        'settings'        => array_merge(settings_defaults(), strip_id($settings)),
    ]);
}

// ---------------------------------------------------
// Writes
// ---------------------------------------------------
function save_changes() {
    $u = require_login();
    $d = request_json();
    $col = $d['collection'] ?? '';
    $ups = (isset($d['upserts']) && is_array($d['upserts'])) ? $d['upserts'] : [];
    $dels = (isset($d['deletes']) && is_array($d['deletes'])) ? $d['deletes'] : [];

    $isSingle = in_array($col, SINGLE_COLLECTIONS, true);
    if (!$isSingle && !in_array($col, LIST_COLLECTIONS, true)) json_error('Unknown collection', 400);
    if (count($ups) > 200 || count($dels) > 200) json_error('Too many changes in one request', 413);

    $rejected = [];
    $db = db();
    $db->begin_transaction();

    foreach ($ups as $rec) {
        if (!is_array($rec)) continue;
        $rid = $isSingle ? 'main' : clean_id($rec['id'] ?? null);
        if (!$rid) { $rejected[] = ['id' => null, 'reason' => 'Invalid record id']; continue; }
        $existing = rec_get($col, $rid, true);
        $err = apply_upsert($col, $rid, $rec, $existing, $u);
        if ($err !== true) $rejected[] = ['id' => $rid, 'reason' => $err];
    }

    foreach ($dels as $id) {
        $id = clean_id($id);
        if (!$id) continue;
        if ($u['role'] !== 'owner' || !in_array($col, DELETABLE, true)) {
            $rejected[] = ['id' => $id, 'reason' => 'You are not allowed to delete this item'];
            continue;
        }
        rec_delete($col, $id);
    }

    $db->commit();
    json_out(['rejected' => $rejected], $rejected ? 'Some changes were rejected' : 'Saved');
}

function apply_upsert($col, $id, array $rec, $existing, array $u) {
    switch ($col) {
        case 'services':        return up_service($id, $rec, $u);
        case 'timeSlots':       return up_slot($id, $rec, $existing, $u);
        case 'announcements':   return up_announcement($id, $rec, $existing, $u);
        case 'pickupSchedules': return up_generic_owner($col, $id, $rec, $u);
        case 'appointments':    return up_appointment($id, $rec, $existing, $u);
        case 'orders':          return up_order($id, $rec, $existing, $u);
        case 'queueEntries':    return up_queue($id, $rec, $u);
        case 'notifications':   return up_notification($id, $rec, $existing, $u);
        case 'shop':            return up_shop($rec, $u);
        case 'settings':        return up_settings($rec, $u);
    }
    return 'Unknown collection';
}

function owner_only(array $u) { return $u['role'] === 'owner' ? true : 'Only the owner can change this.'; }

function valid_date($s) {
    if (!is_string($s)) return false;
    $dt = DateTime::createFromFormat('!Y-m-d', $s);
    return $dt && $dt->format('Y-m-d') === $s;
}
function valid_hhmm($s) { return is_string($s) && preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $s); }

// ----- services -----
function up_service($id, $rec, $u) {
    if (($e = owner_only($u)) !== true) return $e;
    $name = clean_text($rec['name'] ?? '', 120);
    if ($name === '') return 'Service name is required.';
    rec_put('services', $id, null, [
        'id' => $id,
        'name' => $name,
        'description' => clean_text($rec['description'] ?? '', 500),
        'basePrice' => max(0, round((float)($rec['basePrice'] ?? 0), 2)),
        'estimatedDays' => max(0, min(60, (int)($rec['estimatedDays'] ?? 1))),
        'isActive' => !empty($rec['isActive']),
    ]);
    return true;
}

// ----- time slots (currentBookings is server-managed) -----
function up_slot($id, $rec, $existing, $u) {
    if (($e = owner_only($u)) !== true) return $e;
    $start = $rec['startTime'] ?? ''; $end = $rec['endTime'] ?? '';
    if (!valid_hhmm($start) || !valid_hhmm($end)) return 'Invalid time format.';
    rec_put('timeSlots', $id, null, [
        'id' => $id,
        'dayOfWeek' => max(0, min(6, (int)($rec['dayOfWeek'] ?? 0))),
        'startTime' => $start,
        'endTime' => $end,
        'maxCapacity' => max(1, min(1000, (int)($rec['maxCapacity'] ?? 5))),
        'currentBookings' => $existing ? (int)($existing['currentBookings'] ?? 0) : 0,
        'isActive' => !empty($rec['isActive']),
    ]);
    return true;
}

// ----- announcements -----
// An announcement is "ongoing" while it is active and today is within its start/end dates.
// Every customer/staff member gets ONE notification per ongoing announcement:
//   - right away when the owner posts it,
//   - or later (when they sign in) if they joined / the start date arrived while it is still ongoing.
// Once the end date has passed, nobody new is notified.
function announcement_is_ongoing(array $a) {
    if (empty($a['isActive'])) return false;
    if (array_key_exists('notify', $a) && !$a['notify']) return false;   // owner chose not to send a notification
    $today = date('Y-m-d');
    $start = $a['startDate'] ?? '';
    $end = $a['endDate'] ?? '';
    if (valid_date($start) && $start > $today) return false;
    if (valid_date($end) && $end < $today) return false;
    return true;
}

function push_announcement_notification(array $a, $userId) {
    $nid = 'ann-' . substr(md5($a['id'] . '|' . $userId), 0, 24);   // same id every time => never duplicated
    $title = (string)($a['title'] ?? '');
    $content = (string)($a['content'] ?? '');
    $msg = '📢 ' . $title;
    if ($content !== '') {
        $short = function_exists('mb_substr') ? mb_substr($content, 0, 140, 'UTF-8') : substr($content, 0, 140);
        $msg .= ' — ' . $short . ($short !== $content ? '…' : '');
    }
    rec_insert_ignore('notifications', $nid, $userId, [
        'id' => $nid,
        'recipientUserId' => $userId,
        'orderId' => null,
        'appointmentId' => null,
        'announcementId' => $a['id'],
        'type' => 'announcement',
        'message' => $msg,
        'isRead' => false,
        'createdAt' => date('c'),
    ]);
}

function ensure_announcement_notifications($userId) {
    foreach (rec_list('announcements') as $a) {
        if (announcement_is_ongoing($a)) push_announcement_notification($a, $userId);
    }
}

function up_announcement($id, $rec, $existing, $u) {
    if (($e = owner_only($u)) !== true) return $e;
    $title = clean_text($rec['title'] ?? '', 200);
    if ($title === '') return 'Announcement title is required.';
    $body = [
        'id' => $id,
        'title' => $title,
        'content' => clean_text($rec['content'] ?? '', 2000),
        'type' => clean_text($rec['type'] ?? 'general', 30),
        'startDate' => clean_text($rec['startDate'] ?? '', 10),
        'endDate' => clean_text($rec['endDate'] ?? '', 10),
        'isActive' => !empty($rec['isActive']),
        'notify' => !array_key_exists('notify', $rec) || !empty($rec['notify']),
        'createdAt' => clean_text($rec['createdAt'] ?? date('c'), 40),
    ];
    rec_put('announcements', $id, null, $body);

    // New and already running: notify every current customer & staff member immediately
    if ($existing === null && announcement_is_ongoing($body)) {
        $res = db()->query("SELECT id FROM users WHERE status = 'active' AND role IN ('customer','staff')");
        while ($row = $res->fetch_assoc()) push_announcement_notification($body, $row['id']);
    }
    return true;
}

function sanitize_generic($v, $depth = 0) {
    if ($depth > 4) return null;
    if (is_string($v)) return clean_text($v, 1000);
    if (is_int($v) || is_float($v) || is_bool($v) || $v === null) return $v;
    if (is_array($v)) { $o = []; foreach ($v as $k => $x) $o[clean_text((string)$k, 60)] = sanitize_generic($x, $depth + 1); return $o; }
    return null;
}
function up_generic_owner($col, $id, $rec, $u) {
    if (($e = owner_only($u)) !== true) return $e;
    $rec = sanitize_generic($rec); $rec['id'] = $id;
    rec_put($col, $id, null, $rec);
    return true;
}

// ----- appointments -----
function up_appointment($id, $rec, $existing, $u) {
    $role = $u['role'];
    if ($role === 'staff') return 'Staff cannot modify appointments.';

    if ($existing === null) {                       // ---- create
        $cust = ($role === 'customer') ? $u['id'] : clean_id($rec['customerId'] ?? null);
        if (!$cust) return 'Invalid customer.';
        $date = $rec['appointmentDate'] ?? '';
        if (!valid_date($date)) return 'Invalid appointment date.';
        $dt = DateTime::createFromFormat('!Y-m-d', $date);
        if ($dt < new DateTime('today')) return 'Please choose today or a later date.';
        $slotId = clean_id($rec['timeSlotId'] ?? null);
        $slot = $slotId ? rec_get('timeSlots', $slotId, true) : null;
        if (!$slot || empty($slot['isActive'])) return 'That time slot is no longer available.';
        if ((int)$dt->format('w') !== (int)$slot['dayOfWeek']) return 'That time slot is not offered on the selected day.';
        if ((int)$slot['currentBookings'] >= (int)$slot['maxCapacity']) return 'Selected time slot has reached maximum capacity.';
        $slot['currentBookings'] = (int)$slot['currentBookings'] + 1;
        rec_put('timeSlots', $slotId, null, $slot);
        rec_put('appointments', $id, $cust, [
            'id' => $id, 'customerId' => $cust, 'appointmentDate' => $date, 'timeSlotId' => $slotId,
            'status' => 'scheduled', 'createdAt' => date('c'),
        ]);
        return true;
    }

    // ---- update (only the status may change)
    if ($role === 'customer' && ($existing['customerId'] ?? '') !== $u['id']) return 'Not allowed.';
    $old = $existing['status'] ?? 'scheduled';
    $new = $rec['status'] ?? $old;
    if (!in_array($new, ['scheduled', 'completed', 'cancelled'], true)) return 'Invalid status.';
    if ($new === $old) return true;
    if ($role === 'customer' && !($old === 'scheduled' && $new === 'cancelled')) return 'This appointment can no longer be changed.';
    if ($old === 'cancelled') return 'Cancelled appointments cannot be reactivated.';
    if ($old === 'scheduled' && $new === 'cancelled') {
        $slot = rec_get('timeSlots', clean_id($existing['timeSlotId'] ?? null), true);
        if ($slot) {
            $slot['currentBookings'] = max(0, (int)$slot['currentBookings'] - 1);
            rec_put('timeSlots', $slot['id'], null, $slot);
        }
    }
    $existing['status'] = $new;
    rec_put('appointments', $id, $existing['customerId'], $existing);
    return true;
}

// ----- orders -----
function up_order($id, $rec, $existing, $u) {
    $role = $u['role'];

    if ($existing === null) {                       // ---- create (price & status are computed here, never trusted)
        if ($role === 'staff') return 'Staff cannot create orders.';
        $cust = ($role === 'customer') ? $u['id'] : clean_id($rec['customerId'] ?? null);
        $apt = rec_get('appointments', clean_id($rec['appointmentId'] ?? null));
        if (!$cust || !$apt || ($apt['customerId'] ?? '') !== $cust) return 'Appointment not found for this order.';
        $srv = rec_get('services', clean_id($rec['serviceId'] ?? null));
        if (!$srv || empty($srv['isActive'])) return 'That service is not available.';
        $qty = round((float)($rec['quantity'] ?? 0), 2);
        if ($qty <= 0 || $qty > 500) return 'Invalid quantity.';
        $pickup = date('Y-m-d', strtotime($apt['appointmentDate'] . ' +' . (int)$srv['estimatedDays'] . ' days'));
        rec_put('orders', $id, $cust, [
            'id' => $id,
            'appointmentId' => $apt['id'],
            'customerId' => $cust,
            'serviceId' => $srv['id'],
            'quantity' => $qty,
            'specialInstructions' => clean_text($rec['specialInstructions'] ?? '', 500) ?: 'Standard laundry care',
            'estimatedPickupDate' => $pickup,
            'status' => 'pending',
            'totalPrice' => round((float)$srv['basePrice'] * $qty, 2),
            'createdAt' => date('c'),
            'completedAt' => null,
        ]);
        return true;
    }

    // ---- update (status only, staff/owner)
    if ($role === 'customer') return 'Orders can only be updated by staff.';
    $new = $rec['status'] ?? ($existing['status'] ?? 'pending');
    if (!in_array($new, ORDER_STATUSES, true)) return 'Invalid order status.';
    $existing['status'] = $new;
    if ($new === 'picked-up' && empty($existing['completedAt'])) $existing['completedAt'] = date('c');
    rec_put('orders', $id, $existing['customerId'] ?? null, $existing);
    return true;
}

// ----- queue -----
function up_queue($id, $rec, $u) {
    if (!in_array($u['role'], ['owner', 'staff'], true)) return 'Not allowed.';
    rec_put('queueEntries', $id, null, [
        'id' => $id,
        'orderId' => clean_id($rec['orderId'] ?? null),
        'appointmentId' => clean_id($rec['appointmentId'] ?? null),
        'checkedInTime' => clean_text($rec['checkedInTime'] ?? date('c'), 40),
        'staffId' => $u['id'],
    ]);
    return true;
}

// ----- notifications -----
function up_notification($id, $rec, $existing, $u) {
    if ($existing === null) {
        if ($u['role'] === 'customer') $recipient = $u['id'];
        else $recipient = clean_id($rec['recipientUserId'] ?? null);
        if (!$recipient) return 'Invalid recipient.';
        if ($u['role'] === 'customer' && clean_id($rec['recipientUserId'] ?? null) !== $u['id']) return 'Not allowed.';
        rec_put('notifications', $id, $recipient, [
            'id' => $id,
            'recipientUserId' => $recipient,
            'orderId' => clean_id($rec['orderId'] ?? null),
            'appointmentId' => clean_id($rec['appointmentId'] ?? null),
            'type' => clean_text($rec['type'] ?? 'info', 40),
            'message' => clean_text($rec['message'] ?? '', 400),
            'isRead' => !empty($rec['isRead']),
            'createdAt' => date('c'),
        ]);
        return true;
    }
    // existing: only the recipient may mark it as read
    if (($existing['recipientUserId'] ?? '') !== $u['id']) return 'Not allowed.';
    $existing['isRead'] = !empty($rec['isRead']) || !empty($existing['isRead']);
    rec_put('notifications', $id, $u['id'], $existing);
    return true;
}

// ----- shop -----
function clean_logo($v) {
    if (!is_string($v) || $v === '') return 'laundry.jpg';
    if (strlen($v) > 1500000) return null;
    if (strncmp($v, 'data:image/', 11) === 0) {
        foreach (['png', 'jpeg', 'webp', 'gif', 'svg+xml'] as $t) {
            $prefix = 'data:image/' . $t . ';base64,';
            if (strncmp($v, $prefix, strlen($prefix)) === 0) {
                $rest = substr($v, strlen($prefix));
                return (strspn($rest, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') === strlen($rest)) ? $v : null;
            }
        }
        return null;
    }
    if (preg_match('#^[A-Za-z0-9_./-]{1,100}\.(png|jpe?g|gif|webp|svg)$#i', $v) && strpos($v, '..') === false) return $v;
    if (function_exists('mb_strlen') ? mb_strlen($v, 'UTF-8') <= 8 : strlen($v) <= 8) return clean_text($v, 8);   // emoji
    return null;
}

function up_shop($rec, $u) {
    if (($e = owner_only($u)) !== true) return $e;
    $cur = array_merge(shop_defaults(), strip_id(rec_get('shop', 'main') ?: []));
    $name = clean_text($rec['name'] ?? '', 120);
    if ($name === '') return 'Shop name is required.';
    $logo = clean_logo($rec['logo'] ?? $cur['logo']);
    if ($logo === null) return 'Logo image is invalid or too large.';
    $open = $rec['openingTime'] ?? $cur['openingTime'];
    $close = $rec['closingTime'] ?? $cur['closingTime'];
    rec_put('shop', 'main', null, [
        'id' => 'main',
        'name' => $name,
        'tagline' => clean_text($rec['tagline'] ?? '', 200),
        'logo' => $logo,
        'phone' => clean_text($rec['phone'] ?? '', 40),
        'email' => clean_text($rec['email'] ?? '', 255),
        'address' => clean_text($rec['address'] ?? '', 300),
        'openingTime' => valid_hhmm($open) ? $open : $cur['openingTime'],
        'closingTime' => valid_hhmm($close) ? $close : $cur['closingTime'],
        'currency' => clean_text($rec['currency'] ?? $cur['currency'], 10) ?: '₱',
    ]);
    return true;
}

function up_settings($rec, $u) {
    if (($e = owner_only($u)) !== true) return $e;
    rec_put('settings', 'main', null, [
        'id' => 'main',
        'bookingWindow' => max(1, min(365, (int)($rec['bookingWindow'] ?? 30))),
        'rescheduleWindow' => max(0, min(720, (int)($rec['rescheduleWindow'] ?? 24))),
        'cancelWindow' => max(0, min(720, (int)($rec['cancelWindow'] ?? 24))),
        'pickupMode' => clean_text($rec['pickupMode'] ?? 'admin', 20),
    ]);
    return true;
}
