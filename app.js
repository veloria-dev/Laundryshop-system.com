/**
 * CleanPro Laundry Management Suite - Professional Business Edition
 * Core Application Engine & State Controller
 */

console.log('CleanPro build 2026-10-12b');

// Global Error Handler
window.addEventListener('error', function(e) {
    console.warn('System notice caught:', e.message);
});

// ==========================================
// 1. DATABASE (server-backed) & API LAYER
// ==========================================
// All data now lives in MySQL on the server. `db` is just an in-memory cache
// that is filled from api/data.php and written back through saveDB().
const DEFAULT_SHOP = {
    name: 'CleanPro Laundry & Dry Cleaning',
    tagline: 'Premium Garment Care & Express Services',
    logo: 'laundry.jpg',
    phone: '',
    email: '',
    address: '',
    openingTime: '08:00',
    closingTime: '19:00',
    currency: '₱'
};
const DEFAULT_SETTINGS = { bookingWindow: 30, rescheduleWindow: 24, cancelWindow: 24, pickupMode: 'admin' };

const db = {
    users: [],
    services: [],
    timeSlots: [],
    appointments: [],
    orders: [],
    queueEntries: [],
    pickupSchedules: [],
    announcements: [],
    notifications: [],
    shop: { ...DEFAULT_SHOP },
    settings: { ...DEFAULT_SETTINGS }
};

const LIST_KEYS = ['users', 'services', 'timeSlots', 'appointments', 'orders', 'queueEntries', 'pickupSchedules', 'announcements', 'notifications'];
const SINGLE_KEYS = ['shop', 'settings'];

// Which collections each role is allowed to write (the server enforces this too)
const WRITABLE = {
    owner:    ['services', 'timeSlots', 'appointments', 'orders', 'queueEntries', 'pickupSchedules', 'announcements', 'notifications', 'shop', 'settings'],
    staff:    ['orders', 'queueEntries', 'notifications'],
    customer: ['appointments', 'orders', 'notifications']
};

// Unique id helper (prevents two users generating the same id)
function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const API = {
    async request(path, options = {}) {
        const opts = {
            method: options.method || 'GET',
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'cleanpro' }
        };
        if (options.body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(options.body);
        }
        let res;
        try {
            res = await fetch('api/' + path, opts);
        } catch (e) {
            const err = new Error('Cannot reach the server. Check your internet connection.');
            err.code = 0;
            throw err;
        }
        let json = null;
        try { json = await res.json(); } catch (e) { /* not JSON */ }
        if (!res.ok || !json || json.status !== 'success') {
            const err = new Error((json && json.message) || ('Server error (' + res.status + ')'));
            err.code = res.status;
            throw err;
        }
        return json.data;
    }
};

// Sync bookkeeping: what the server had last time we looked, plus a queue of pending saves
const sync = { snapshot: {}, queue: [], busy: false, pollTimer: null };

// ==========================================
// 2. MAIN APP OBJECT
// ==========================================
const app = {
    currentUser: null,
    currentPage: null,
    selectedServiceId: null,
    selectedSlotId: null,

    // Initialize System: load public branding, then restore the server session (if any)
    async init() {
        this.bindGlobalEvents();
        this.startLiveClock();

        const authView = document.getElementById('auth-view');
        if (authView) authView.style.display = 'none';

        try {
            const info = await API.request('data.php?action=public');
            db.shop = { ...DEFAULT_SHOP, ...info.shop };
            db.settings = { ...DEFAULT_SETTINGS, ...info.settings };
        } catch (e) {
            console.warn('Could not load shop info:', e.message);
        }
        this.updateShopBranding();

        let me = null;
        try {
            me = (await API.request('auth.php?action=me')).user;
        } catch (e) { /* not signed in */ }

        if (me) {
            await this.onAuthenticated(me);
        } else {
            this.showAuthView();
        }

        // Pick up changes made by other people/devices
        window.addEventListener('focus', () => this.pollRefresh());
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.pollRefresh(); });
    },

    // ---------- server <-> client data sync ----------
    snapshotOf(key) {
        const map = {};
        if (SINGLE_KEYS.includes(key)) {
            map.main = JSON.stringify(db[key]);
        } else {
            (db[key] || []).forEach(r => { map[r.id] = JSON.stringify(r); });
        }
        return map;
    },

    applyServerData(data) {
        let changed = false;
        LIST_KEYS.forEach(k => {
            const next = data[k] || [];
            if (JSON.stringify(db[k]) !== JSON.stringify(next)) changed = true;
            db[k] = next;
        });
        const nextShop = { ...DEFAULT_SHOP, ...(data.shop || {}) };
        const nextSettings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        if (JSON.stringify(db.shop) !== JSON.stringify(nextShop) || JSON.stringify(db.settings) !== JSON.stringify(nextSettings)) changed = true;
        db.shop = nextShop;
        db.settings = nextSettings;
        if (data.me) this.currentUser = data.me;
        LIST_KEYS.concat(SINGLE_KEYS).forEach(k => { sync.snapshot[k] = this.snapshotOf(k); });
        return changed;
    },

    // Pull fresh data. Skipped while local changes are still being saved.
    async refreshData() {
        if (!this.currentUser || sync.busy || sync.queue.length) return false;
        try {
            const data = await API.request('data.php?action=load');
            if (sync.busy || sync.queue.length) return false;   // a save started meanwhile
            return this.applyServerData(data);
        } catch (e) {
            if (e.code === 401) this.handleSessionExpired();
            return false;
        }
    },

    handleSessionExpired() {
        if (!this.currentUser) return;
        this.resetLocalState();
        this.showToast('Your session expired. Please sign in again.', 'warning');
        this.showAuthView();
    },

    resetLocalState() {
        this.currentUser = null;
        this.currentPage = null;
        this.stopPolling();
        LIST_KEYS.forEach(k => { db[k] = []; });
        sync.snapshot = {};
        sync.queue = [];
    },

    startPolling() {
        this.stopPolling();
        sync.pollTimer = setInterval(() => this.pollRefresh(), 45000);
    },

    stopPolling() {
        if (sync.pollTimer) clearInterval(sync.pollTimer);
        sync.pollTimer = null;
    },

    isUserEditing() {
        const el = document.activeElement;
        const typing = el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
        const modalOpen = document.querySelector('.modal-overlay.active');
        return !!(typing || modalOpen);
    },

    async pollRefresh() {
        const changed = await this.refreshData();
        if (!changed || !this.currentUser) return;
        this.renderNotificationsDropdown();
        this.updateShopBranding();
        const skip = ['customer-booking', 'admin-settings'];
        if (this.currentPage && !skip.includes(this.currentPage) && !this.isUserEditing()) {
            this.dispatchPage(this.currentPage);
        }
    },

    // Called by saveDB(): sends only what changed since the last sync
    async flushSync() {
        if (sync.busy) return;
        sync.busy = true;
        const problems = [];

        while (sync.queue.length) {
            const key = sync.queue.shift();
            const prev = sync.snapshot[key] || {};
            const cur = this.snapshotOf(key);
            const upserts = [];
            const deletes = [];

            Object.keys(cur).forEach(id => {
                if (prev[id] !== cur[id]) {
                    const rec = JSON.parse(cur[id]);
                    if (SINGLE_KEYS.includes(key)) rec.id = 'main';
                    upserts.push(rec);
                }
            });
            Object.keys(prev).forEach(id => { if (!(id in cur)) deletes.push(id); });
            if (!upserts.length && !deletes.length) continue;

            try {
                const res = await API.request('data.php?action=save', {
                    method: 'POST',
                    body: { collection: key, upserts, deletes }
                });
                (res.rejected || []).forEach(r => problems.push(r.reason));
                sync.snapshot[key] = cur;
            } catch (e) {
                if (e.code === 401) { sync.busy = false; this.handleSessionExpired(); return; }
                problems.push(e.message);
            }
        }

        sync.busy = false;
        if (problems.length) this.showToast(problems[0], 'danger');

        // Re-read the server's truth (fixes slot counters, reverts rejected changes)
        const changed = await this.refreshData();
        if (changed) {
            this.renderNotificationsDropdown();
            const skip = ['customer-booking', 'admin-settings'];
            if (problems.length && this.currentPage && !skip.includes(this.currentPage)) this.dispatchPage(this.currentPage);
        }
    },

    bindGlobalEvents() {
        // Close modal when clicking backdrop
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.closeModal(overlay.id);
                }
            });
        });

        // Close on ESC key
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.active').forEach(m => {
                    this.closeModal(m.id);
                });
                this.closeNotifications();
            }
        });

        // Close notification dropdown if clicked outside
        window.addEventListener('click', (e) => {
            const notifWrapper = document.querySelector('.notif-wrapper');
            if (notifWrapper && !notifWrapper.contains(e.target)) {
                this.closeNotifications();
            }
        });
    },

    startLiveClock() {
        const update = () => {
            const clockEl = document.getElementById('live-clock');
            if (clockEl) {
                const now = new Date();
                const options = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
                clockEl.textContent = now.toLocaleDateString('en-US', options);
            }
        };
        update();
        setInterval(update, 1000);
    },

    // ==========================================
    // 3. AUTHENTICATION & SESSION
    // ==========================================
    showAuthView() {
        document.getElementById('auth-view').style.display = 'flex';
        document.getElementById('app-shell').style.display = 'none';
    },

    showAppShell() {
        document.getElementById('auth-view').style.display = 'none';
        document.getElementById('app-shell').style.display = 'flex';
        this.updateShopBranding();
        this.setupNavigation();
        this.updateHeaderUserInfo();
        this.renderNotificationsDropdown();

        // Direct user to role dashboard
        if (this.currentUser.role === 'customer') {
            this.navigate('customer-dashboard');
        } else if (this.currentUser.role === 'staff') {
            this.navigate('staff-dashboard');
        } else {
            this.navigate('admin-dashboard');
        }
    },

    async onAuthenticated(user) {
        this.currentUser = user;
        try {
            const data = await API.request('data.php?action=load');
            this.applyServerData(data);
        } catch (e) {
            this.showToast('Signed in, but data could not be loaded: ' + e.message, 'danger');
        }
        try {
            this.showAppShell();
        } catch (err) {
            console.error('Display error:', err);
            this.showToast('Display error: ' + err.message + ' (press F12 > Console for details)', 'warning');
        }
        this.startPolling();
    },

    async login(e) {
        if (e) e.preventDefault();
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;
        const btn = e && e.target ? e.target.querySelector('button[type="submit"]') : null;
        if (btn) btn.disabled = true;

        try {
            const data = await API.request('auth.php?action=login', { method: 'POST', body: { email, password } });
            document.getElementById('login-password').value = '';
            await this.onAuthenticated(data.user);
            this.showToast(`Welcome back, ${data.user.firstName}!`, 'success');
        } catch (err) {
            this.showToast(err.message, 'danger');
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    async register(e) {
        if (e) e.preventDefault();
        const btn = e && e.target ? e.target.querySelector('button[type="submit"]') : null;
        if (btn) btn.disabled = true;

        const body = {
            email: document.getElementById('reg-email').value.trim(),
            password: document.getElementById('reg-password').value,
            firstName: document.getElementById('reg-fname').value.trim(),
            lastName: document.getElementById('reg-lname').value.trim(),
            phone: document.getElementById('reg-phone').value.trim(),
            address: document.getElementById('reg-address').value.trim()
        };

        try {
            const data = await API.request('auth.php?action=register', { method: 'POST', body });
            document.getElementById('reg-password').value = '';
            await this.onAuthenticated(data.user);
            this.showToast('Account registered successfully!', 'success');
        } catch (err) {
            this.showToast(err.message, 'danger');
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    async logout() {
        if (!confirm('Are you sure you want to sign out?')) return;
        try { await API.request('auth.php?action=logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
        this.resetLocalState();
        this.showToast('You have been logged out securely.', 'info');
        this.showAuthView();
    },

    // ==========================================
    // 4. NAVIGATION & SHELL
    // ==========================================
    isImageLogo(logo) {
        return !!logo && (logo.startsWith('data:image/') || logo.startsWith('http') || logo.startsWith('blob:') || /\.(png|jpe?g|gif|webp|svg)$/i.test(logo));
    },

    updateShopBranding() {
        const logoDisplays = document.querySelectorAll('.shop-logo-slot');
        const isImage = this.isImageLogo(db.shop.logo);

        logoDisplays.forEach(el => {
            if (isImage) {
                el.innerHTML = `<img src="${db.shop.logo}" alt="Logo" style="width: 100%; height: 100%; object-fit: contain; border-radius: inherit; display: block;">`;
            } else {
                el.textContent = db.shop.logo || '🧺';
            }
        });

        const nameDisplays = document.querySelectorAll('.shop-name-slot');
        nameDisplays.forEach(el => el.textContent = db.shop.name);

        const taglineDisplays = document.querySelectorAll('.shop-tagline-slot');
        taglineDisplays.forEach(el => el.textContent = db.shop.tagline);

        document.title = `${db.shop.name} | Laundry & Dry Cleaning Suite`;
    },

    updateHeaderUserInfo() {
        if (!this.currentUser) return;
        const nameEl = document.getElementById('header-user-name');
        const roleEl = document.getElementById('header-user-role');
        const avatarEl = document.getElementById('header-user-avatar');
        const footerNameEl = document.getElementById('sidebar-user-name');
        const footerRoleEl = document.getElementById('sidebar-user-role');

        const fullName = `${this.currentUser.firstName} ${this.currentUser.lastName}`;
        const initials = `${this.currentUser.firstName[0]}${this.currentUser.lastName[0]}`.toUpperCase();

        const displayRole = (this.currentUser.role === 'admin' || this.currentUser.role === 'owner') 
            ? 'Owner' 
            : (this.currentUser.role.charAt(0).toUpperCase() + this.currentUser.role.slice(1));

        if (nameEl) nameEl.textContent = fullName;
        if (roleEl) roleEl.textContent = displayRole;
        if (avatarEl) avatarEl.textContent = initials;
        if (footerNameEl) footerNameEl.textContent = fullName;
        if (footerRoleEl) footerRoleEl.textContent = displayRole.toUpperCase();
    },

    setupNavigation() {
        const sidebarNav = document.getElementById('sidebar-nav-container');
        if (!sidebarNav) return;
        sidebarNav.innerHTML = '';

        const role = this.currentUser.role;
        const navStructure = {
            customer: [
                {
                    group: 'Overview',
                    items: [
                        { id: 'customer-dashboard', label: 'Dashboard', icon: 'fa-chart-pie' }
                    ]
                },
                {
                    group: 'Bookings & Orders',
                    items: [
                        { id: 'customer-booking', label: 'Book Appointment', icon: 'fa-calendar-plus' },
                        { id: 'customer-appointments', label: 'My Appointments', icon: 'fa-calendar-check' },
                        { id: 'customer-orders', label: 'My Orders & Tracking', icon: 'fa-shirt' }
                    ]
                }
            ],
            staff: [
                {
                    group: 'Overview',
                    items: [
                        { id: 'staff-dashboard', label: 'Dashboard', icon: 'fa-chart-pie' }
                    ]
                },
                {
                    group: 'Operations',
                    items: [
                        { id: 'staff-queue', label: 'Queue & Check-In', icon: 'fa-list-check' },
                        { id: 'staff-orders', label: 'Manage Orders', icon: 'fa-boxes-stacked' }
                    ]
                }
            ],
            admin: [
                {
                    group: 'Overview',
                    items: [
                        { id: 'admin-dashboard', label: 'Dashboard', icon: 'fa-chart-pie' }
                    ]
                },
                {
                    group: 'Operations',
                    items: [
                        { id: 'admin-appointments', label: 'All Appointments', icon: 'fa-calendar-days' },
                        { id: 'admin-pickups', label: 'Pickup Deliveries', icon: 'fa-truck-fast' },
                        { id: 'admin-timeslots', label: 'Time Slot Matrix', icon: 'fa-clock' }
                    ]
                },
                {
                    group: 'Management',
                    items: [
                        { id: 'admin-users', label: 'User Directory', icon: 'fa-users' },
                        { id: 'admin-services', label: 'Services & Pricing', icon: 'fa-tags' },
                        { id: 'admin-announcements', label: 'Announcements', icon: 'fa-bullhorn' }
                    ]
                },
                {
                    group: 'Analytics & Config',
                    items: [
                        { id: 'admin-reports', label: 'Revenue Reports', icon: 'fa-file-invoice-dollar' },
                        { id: 'admin-settings', label: 'Shop & System Config', icon: 'fa-sliders' }
                    ]
                }
            ]
        };

        const navKey = (role === 'owner' || role === 'admin') ? 'admin' : role;
        const groups = navStructure[navKey] || [];
        groups.forEach(grp => {
            const groupTitle = document.createElement('div');
            groupTitle.className = 'sidebar-nav-group-title';
            groupTitle.textContent = grp.group;
            sidebarNav.appendChild(groupTitle);

            const ul = document.createElement('ul');
            ul.className = 'sidebar-nav-list';

            grp.items.forEach(item => {
                const li = document.createElement('li');
                li.className = 'sidebar-nav-item';
                li.innerHTML = `
                    <a href="#" class="sidebar-nav-link" id="nav-link-${item.id}" onclick="event.preventDefault(); app.navigate('${item.id}')">
                        <i class="fa-solid ${item.icon}"></i>
                        <span>${item.label}</span>
                    </a>
                `;
                ul.appendChild(li);
            });
            sidebarNav.appendChild(ul);
        });
    },

    navigate(pageId) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.sidebar-nav-link').forEach(l => l.classList.remove('active'));

        const targetPage = document.getElementById(`page-${pageId}`);
        const targetNav = document.getElementById(`nav-link-${pageId}`);

        if (targetPage) targetPage.classList.add('active');
        if (targetNav) targetNav.classList.add('active');

        // Close mobile drawer if open
        this.closeMobileSidebar();

        this.currentPage = pageId;
        this.dispatchPage(pageId);

        // Fetch the latest data from the server; re-render if somebody else changed something
        this.refreshData().then(changed => {
            if (!changed || this.currentPage !== pageId) return;
            this.renderNotificationsDropdown();
            this.updateShopBranding();
            if (pageId !== 'customer-booking' && pageId !== 'admin-settings' && !this.isUserEditing()) {
                this.dispatchPage(pageId);
            }
        });
    },

    // Route dispatcher
    dispatchPage(pageId) {
        if (pageId.startsWith('customer-')) this.loadCustomerView(pageId);
        else if (pageId.startsWith('staff-')) this.loadStaffView(pageId);
        else if (pageId.startsWith('admin-')) this.loadAdminView(pageId);
    },

    toggleMobileSidebar() {
        const sidebar = document.getElementById('app-sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar && overlay) {
            sidebar.classList.toggle('mobile-open');
            overlay.classList.toggle('active');
        }
    },

    closeMobileSidebar() {
        const sidebar = document.getElementById('app-sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar && overlay) {
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('active');
        }
    },

    // ==========================================
    // 5. NOTIFICATION CENTER
    // ==========================================
    toggleNotifications() {
        const dropdown = document.getElementById('notif-dropdown');
        if (dropdown) dropdown.classList.toggle('active');
    },

    closeNotifications() {
        const dropdown = document.getElementById('notif-dropdown');
        if (dropdown) dropdown.classList.remove('active');
    },

    renderNotificationsDropdown() {
        const unreadBadge = document.getElementById('notif-badge');
        const listContainer = document.getElementById('notif-dropdown-list');
        if (!listContainer || !this.currentUser) return;

        const userNotifs = db.notifications
            .filter(n => n.recipientUserId === this.currentUser.id)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const unreadCount = userNotifs.filter(n => !n.isRead).length;

        if (unreadBadge) {
            if (unreadCount > 0) {
                unreadBadge.textContent = unreadCount;
                unreadBadge.style.display = 'flex';
            } else {
                unreadBadge.style.display = 'none';
            }
        }

        if (userNotifs.length === 0) {
            listContainer.innerHTML = `
                <div style="padding: 2rem; text-align: center; color: var(--slate-400);">
                    <i class="fa-regular fa-bell-slash" style="font-size: 2rem; margin-bottom: 0.5rem; display:block;"></i>
                    <p style="font-size: 0.85rem;">No notifications right now</p>
                </div>
            `;
            return;
        }

        listContainer.innerHTML = userNotifs.slice(0, 6).map(n => `
            <div class="notif-dropdown-item ${!n.isRead ? 'unread' : ''}" onclick="app.markNotificationRead('${n.id}')">
                <div class="notif-item-icon">
                    <i class="fa-solid fa-bell"></i>
                </div>
                <div class="notif-item-content">
                    <div class="notif-item-title">${n.type.replace('-', ' ').toUpperCase()}</div>
                    <div class="notif-item-message">${n.message}</div>
                    <div class="notif-item-time">${new Date(n.createdAt).toLocaleDateString()} • ${new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
            </div>
        `).join('');
    },

    markNotificationRead(notifId) {
        const notif = db.notifications.find(n => n.id === notifId);
        if (notif) {
            notif.isRead = true;
            this.saveDB('notifications');
            this.renderNotificationsDropdown();
        }
    },

    markAllNotificationsRead() {
        if (!this.currentUser) return;
        db.notifications
            .filter(n => n.recipientUserId === this.currentUser.id)
            .forEach(n => n.isRead = true);
        this.saveDB('notifications');
        this.renderNotificationsDropdown();
        this.showToast('All notifications marked as read', 'info');
    },

    addNotification(recipientId, orderId, appointmentId, type, message) {
        const notif = {
            id: uid('notif-'),
            recipientUserId: recipientId,
            orderId: orderId,
            appointmentId: appointmentId,
            type: type,
            message: message,
            isRead: false,
            createdAt: new Date().toISOString()
        };
        db.notifications.push(notif);
        this.saveDB('notifications');
        if (this.currentUser && this.currentUser.id === recipientId) {
            this.renderNotificationsDropdown();
        }
    },

    // ==========================================
    // 6. CUSTOMER VIEWS & BOOKING ENGINE
    // ==========================================
    loadCustomerView(pageId) {
        switch (pageId) {
            case 'customer-dashboard':
                this.loadCustomerDashboard();
                break;
            case 'customer-booking':
                this.loadBookingForm();
                break;
            case 'customer-appointments':
                this.loadCustomerAppointments();
                break;
            case 'customer-orders':
                this.loadCustomerOrders();
                break;
        }
    },

    loadCustomerDashboard() {
        // Render Active Announcements
        const bannerContainer = document.getElementById('customer-announcements-banner');
        if (bannerContainer) {
            const today = new Date().toISOString().split('T')[0];
            const activeBanners = db.announcements.filter(a => a.isActive && a.startDate <= today && a.endDate >= today);
            bannerContainer.innerHTML = activeBanners.map(a => `
                <div class="alert alert-info" style="margin-bottom: 1.5rem;">
                    <i class="fa-solid fa-bullhorn" style="font-size: 1.25rem;"></i>
                    <div>
                        <strong>${a.title}</strong>
                        <div style="font-size: 0.85rem; margin-top: 0.2rem;">${a.content}</div>
                    </div>
                </div>
            `).join('');
        }

        // Stats
        const myOrders = db.orders.filter(o => o.customerId === this.currentUser.id);
        const readyCount = myOrders.filter(o => o.status === 'ready-for-pickup').length;
        const inProgressCount = myOrders.filter(o => o.status === 'processing' || o.status === 'pending').length;

        document.getElementById('cust-stat-ready').textContent = readyCount;
        document.getElementById('cust-stat-progress').textContent = inProgressCount;
        document.getElementById('cust-stat-total').textContent = myOrders.length;

        // Next Appointment
        const nextApt = db.appointments
            .filter(a => a.customerId === this.currentUser.id && a.status === 'scheduled' && a.appointmentDate >= new Date().toISOString().split('T')[0])
            .sort((a, b) => new Date(a.appointmentDate) - new Date(b.appointmentDate))[0];

        const nextAptEl = document.getElementById('cust-stat-next-apt');
        if (nextAptEl) {
            if (nextApt) {
                const slot = db.timeSlots.find(s => s.id === nextApt.timeSlotId);
                nextAptEl.textContent = `${nextApt.appointmentDate} (${slot ? slot.startTime : 'Time TBD'})`;
            } else {
                nextAptEl.textContent = 'None Scheduled';
            }
        }

        // Recent Orders List
        const recentOrdersContainer = document.getElementById('cust-recent-orders-list');
        if (recentOrdersContainer) {
            const recent = myOrders.slice(-3).reverse();
            if (recent.length === 0) {
                recentOrdersContainer.innerHTML = `
                    <div style="padding: 2.5rem; text-align: center; color: var(--slate-400);">
                        <i class="fa-solid fa-basket-shopping" style="font-size: 2.5rem; margin-bottom: 0.75rem; display:block;"></i>
                        <p style="font-weight: 600; color: var(--slate-600);">No orders submitted yet.</p>
                        <button class="btn btn-primary btn-sm" style="margin-top: 1rem;" onclick="app.navigate('customer-booking')">Book Your First Order</button>
                    </div>
                `;
            } else {
                recentOrdersContainer.innerHTML = recent.map(o => {
                    const srv = db.services.find(s => s.id === o.serviceId) || { name: 'Laundry Service' };
                    return `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 1rem 0; border-bottom: 1px solid var(--border-subtle);">
                            <div>
                                <div style="font-weight: 700; font-size: 0.95rem; color: var(--slate-900);">${srv.name} • ${o.id}</div>
                                <div style="font-size: 0.8rem; color: var(--slate-500);">${o.quantity} kg • Est. Pickup: ${o.estimatedPickupDate}</div>
                            </div>
                            <div style="display: flex; align-items: center; gap: 0.75rem;">
                                <span class="badge ${this.getStatusBadgeClass(o.status)}">${o.status.replace('-', ' ')}</span>
                                <button class="btn btn-secondary btn-sm" onclick="app.printOrderSlip('${o.id}')"><i class="fa-solid fa-receipt"></i> Slip</button>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }
    },

    loadBookingForm() {
        const servicesGrid = document.getElementById('booking-service-cards');
        const dateInput = document.getElementById('booking-date-input');

        // Render Service Cards
        if (servicesGrid) {
            servicesGrid.innerHTML = db.services.filter(s => s.isActive).map(s => `
                <div class="service-pick-card ${this.selectedServiceId === s.id ? 'selected' : ''}" onclick="app.selectServiceCard('${s.id}')">
                    <div class="service-card-top">
                        <span class="service-card-title">${s.name}</span>
                        <span class="service-card-price">${db.shop.currency}${s.basePrice}<span style="font-size: 0.75rem; color: var(--slate-500); font-weight: normal;">/kg</span></span>
                    </div>
                    <div class="service-card-desc">${s.description}</div>
                    <div class="service-card-turnaround">
                        <i class="fa-regular fa-clock"></i> Est. turnaround: ${s.estimatedDays} days
                    </div>
                </div>
            `).join('');
        }

        // Set Date Limits
        if (dateInput) {
            const today = new Date().toISOString().split('T')[0];
            const maxDate = new Date();
            maxDate.setDate(maxDate.getDate() + db.settings.bookingWindow);

            dateInput.min = today;
            dateInput.max = maxDate.toISOString().split('T')[0];

            if (!dateInput.value) {
                dateInput.value = today;
            }
            this.loadAvailableSlots(dateInput.value);
        }

        this.calculateBookingEstimate();
    },

    selectServiceCard(serviceId) {
        this.selectedServiceId = serviceId;
        document.getElementById('booking-selected-service').value = serviceId;
        this.loadBookingForm();
    },

    loadAvailableSlots(dateString) {
        const slotsGrid = document.getElementById('booking-slots-grid');
        if (!slotsGrid || !dateString) return;

        const date = new Date(dateString + 'T00:00:00');
        const dayOfWeek = date.getDay();

        const available = db.timeSlots.filter(s => s.dayOfWeek === dayOfWeek && s.isActive);

        if (available.length === 0) {
            slotsGrid.innerHTML = `
                <div class="alert alert-warning" style="grid-column: 1/-1;">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <span>No time slots available for this day. Please select another date.</span>
                </div>
            `;
            return;
        }

        slotsGrid.innerHTML = available.map(slot => {
            const left = slot.maxCapacity - slot.currentBookings;
            const isFull = left <= 0;
            const isSelected = this.selectedSlotId === slot.id;

            return `
                <div class="time-slot-card ${isSelected ? 'selected' : ''} ${isFull ? 'disabled' : ''}" 
                     onclick="${isFull ? '' : `app.selectSlot('${slot.id}')`}">
                    <div class="slot-time-text">${slot.startTime} - ${slot.endTime}</div>
                    <span class="slot-capacity-pill">${isFull ? 'Full' : `${left} slots left`}</span>
                </div>
            `;
        }).join('');
    },

    selectSlot(slotId) {
        this.selectedSlotId = slotId;
        document.getElementById('booking-selected-slot').value = slotId;
        const dateVal = document.getElementById('booking-date-input').value;
        this.loadAvailableSlots(dateVal);
    },

    calculateBookingEstimate() {
        const weightInput = document.getElementById('booking-weight-input');
        const estDisplay = document.getElementById('booking-total-preview');
        if (!estDisplay) return;

        const weight = parseFloat(weightInput?.value) || 1;
        const service = db.services.find(s => s.id === this.selectedServiceId);

        if (service) {
            const total = (service.basePrice * weight).toFixed(2);
            estDisplay.textContent = `${db.shop.currency}${total}`;
        } else {
            estDisplay.textContent = `${db.shop.currency}0.00`;
        }
    },

    submitBooking(e) {
        e.preventDefault();
        const serviceId = document.getElementById('booking-selected-service').value;
        const slotId = document.getElementById('booking-selected-slot').value;
        const date = document.getElementById('booking-date-input').value;
        const weight = parseFloat(document.getElementById('booking-weight-input').value) || 1;
        const instructions = document.getElementById('booking-instructions').value.trim();

        if (!serviceId) {
            this.showToast('Please select a laundry service.', 'warning');
            return;
        }
        if (!slotId) {
            this.showToast('Please pick an available time slot.', 'warning');
            return;
        }

        const slot = db.timeSlots.find(s => s.id === slotId);
        const service = db.services.find(s => s.id === serviceId);

        if (slot.currentBookings >= slot.maxCapacity) {
            this.showToast('Selected time slot has reached maximum capacity.', 'danger');
            return;
        }

        const pickupDate = new Date(date);
        pickupDate.setDate(pickupDate.getDate() + service.estimatedDays);

        const appointment = {
            id: uid('apt-'),
            customerId: this.currentUser.id,
            appointmentDate: date,
            timeSlotId: slotId,
            status: 'scheduled',
            createdAt: new Date().toISOString()
        };

        const order = {
            id: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
            appointmentId: appointment.id,
            customerId: this.currentUser.id,
            serviceId: serviceId,
            quantity: weight,
            specialInstructions: instructions || 'Standard laundry care',
            estimatedPickupDate: pickupDate.toISOString().split('T')[0],
            status: 'pending',
            totalPrice: service.basePrice * weight,
            createdAt: new Date().toISOString(),
            completedAt: null
        };

        // Increment booking counter
        slot.currentBookings++;

        db.appointments.push(appointment);
        db.orders.push(order);
        this.saveDB('appointments');
        this.saveDB('orders');
        this.saveDB('timeSlots');

        this.addNotification(this.currentUser.id, order.id, appointment.id, 'appointment-reminder', `Drop-off booked for ${date} at ${slot.startTime}. Order ID: ${order.id}`);

        this.showToast('Appointment and Order booked successfully!', 'success');
        this.selectedServiceId = null;
        this.selectedSlotId = null;
        this.navigate('customer-orders');
    },

    loadCustomerAppointments() {
        const list = document.getElementById('cust-appointments-list');
        if (!list) return;

        const apts = db.appointments
            .filter(a => a.customerId === this.currentUser.id)
            .sort((a, b) => new Date(b.appointmentDate) - new Date(a.appointmentDate));

        if (apts.length === 0) {
            list.innerHTML = `
                <div class="card" style="text-align: center; padding: 3rem;">
                    <i class="fa-regular fa-calendar-xmark" style="font-size: 3rem; color: var(--slate-300); margin-bottom: 1rem; display:block;"></i>
                    <h3 style="font-size: 1.25rem; font-weight: 700; color: var(--slate-800);">No Appointments Scheduled</h3>
                    <p style="color: var(--slate-500); margin: 0.5rem 0 1.5rem;">Book a slot to skip queue lines at our counter.</p>
                    <button class="btn btn-primary" onclick="app.navigate('customer-booking')">Book Drop-off Now</button>
                </div>
            `;
            return;
        }

        list.innerHTML = apts.map(apt => {
            const slot = db.timeSlots.find(s => s.id === apt.timeSlotId) || { startTime: '09:00', endTime: '11:00' };
            const order = db.orders.find(o => o.appointmentId === apt.id);
            const srv = order ? (db.services.find(s => s.id === order.serviceId) || { name: 'Laundry Service' }) : { name: 'Drop-off Appointment' };

            return `
                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem;">
                        <div>
                            <div style="font-size: 1.15rem; font-weight: 800; color: var(--slate-900);">${srv.name}</div>
                            <div style="color: var(--slate-500); font-size: 0.9rem; margin-top: 0.25rem;">
                                <i class="fa-regular fa-calendar"></i> ${apt.appointmentDate} • <i class="fa-regular fa-clock"></i> ${slot.startTime} - ${slot.endTime}
                            </div>
                        </div>
                        <span class="badge ${this.getStatusBadgeClass(apt.status)}">${apt.status}</span>
                    </div>
                    <div style="margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 0.85rem; color: var(--slate-500);">Order Ref: <strong>${order ? order.id : 'N/A'}</strong></span>
                        <div>
                            ${apt.status === 'scheduled' ? `
                                <button class="btn btn-secondary btn-sm" onclick="app.cancelAppointment('${apt.id}')">
                                    <i class="fa-solid fa-ban"></i> Cancel Booking
                                </button>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    cancelAppointment(aptId) {
        if (!confirm('Are you sure you want to cancel this appointment?')) return;
        const apt = db.appointments.find(a => a.id === aptId);
        if (apt) {
            apt.status = 'cancelled';
            const slot = db.timeSlots.find(s => s.id === apt.timeSlotId);
            if (slot) slot.currentBookings = Math.max(0, slot.currentBookings - 1);

            this.saveDB('appointments');
            this.saveDB('timeSlots');
            this.showToast('Appointment successfully cancelled.', 'info');
            this.loadCustomerAppointments();
        }
    },

    loadCustomerOrders() {
        const list = document.getElementById('cust-orders-list');
        if (!list) return;

        const myOrders = db.orders
            .filter(o => o.customerId === this.currentUser.id)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (myOrders.length === 0) {
            list.innerHTML = `
                <div class="card" style="text-align: center; padding: 3rem;">
                    <i class="fa-solid fa-shirt" style="font-size: 3rem; color: var(--slate-300); margin-bottom: 1rem; display:block;"></i>
                    <h3 style="font-weight: 700; color: var(--slate-800);">No Laundry Orders Found</h3>
                    <p style="color: var(--slate-500); margin: 0.5rem 0 1.5rem;">You haven't submitted any laundry batches yet.</p>
                    <button class="btn btn-primary" onclick="app.navigate('customer-booking')">Start First Order</button>
                </div>
            `;
            return;
        }

        list.innerHTML = myOrders.map(order => {
            const srv = db.services.find(s => s.id === order.serviceId) || { name: 'Laundry Care' };
            const stages = ['pending', 'processing', 'ready-for-pickup', 'picked-up'];
            const currentIndex = stages.indexOf(order.status);

            const stepperHTML = `
                <div class="tracking-stepper">
                    <div class="step-node ${currentIndex >= 0 ? (currentIndex === 0 ? 'current' : 'completed') : ''}">
                        <div class="step-circle"><i class="fa-solid fa-receipt"></i></div>
                        <div class="step-title">Order Placed</div>
                    </div>
                    <div class="step-node ${currentIndex >= 1 ? (currentIndex === 1 ? 'current' : 'completed') : ''}">
                        <div class="step-circle"><i class="fa-solid fa-soap"></i></div>
                        <div class="step-title">In Wash / Drying</div>
                    </div>
                    <div class="step-node ${currentIndex >= 2 ? (currentIndex === 2 ? 'current' : 'completed') : ''}">
                        <div class="step-circle"><i class="fa-solid fa-box-archive"></i></div>
                        <div class="step-title">Ready for Pickup</div>
                    </div>
                    <div class="step-node ${currentIndex >= 3 ? 'completed' : ''}">
                        <div class="step-circle"><i class="fa-solid fa-circle-check"></i></div>
                        <div class="step-title">Claimed</div>
                    </div>
                </div>
            `;

            return `
                <div class="order-tracking-card">
                    <div class="order-card-top">
                        <div>
                            <div class="order-badge-id">${order.id}</div>
                            <div style="font-size: 1.1rem; font-weight: 800; color: var(--slate-900); margin-top: 0.2rem;">${srv.name}</div>
                            <div class="order-meta-info">
                                Quantity: <strong>${order.quantity} kg</strong> • Est. Pickup Date: <strong>${order.estimatedPickupDate}</strong>
                            </div>
                        </div>
                        <div class="order-cost-display">
                            <div style="font-size: 0.8rem; color: var(--slate-500); text-transform: uppercase; font-weight: 700;">Total Price</div>
                            <div class="order-total-amount">${db.shop.currency}${order.totalPrice.toFixed(2)}</div>
                            <span class="badge ${this.getStatusBadgeClass(order.status)}">${order.status.replace('-', ' ')}</span>
                        </div>
                    </div>

                    ${stepperHTML}

                    <div style="display: flex; justify-content: space-between; align-items: center; background: var(--slate-50); padding: 0.85rem 1.25rem; border-radius: var(--radius-md); margin-top: 1rem;">
                        <span style="font-size: 0.85rem; color: var(--slate-600);">
                            <i class="fa-regular fa-note-sticky"></i> Note: <em>${order.specialInstructions}</em>
                        </span>
                        <button class="btn btn-secondary btn-sm" onclick="app.printOrderSlip('${order.id}')">
                            <i class="fa-solid fa-print"></i> Claim Ticket
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    },

    // ==========================================
    // 7. STAFF OPERATIONS
    // ==========================================
    loadStaffView(pageId) {
        if (pageId === 'staff-dashboard') this.loadStaffDashboard();
        else if (pageId === 'staff-queue') this.loadStaffQueue();
        else if (pageId === 'staff-orders') this.loadStaffOrders();
    },

    loadStaffDashboard() {
        const today = new Date().toISOString().split('T')[0];
        const todayApts = db.appointments.filter(a => a.appointmentDate === today && a.status === 'scheduled');
        const pendingCheckins = todayApts.filter(a => {
            const order = db.orders.find(o => o.appointmentId === a.id);
            return order && order.status === 'pending';
        }).length;

        const readyForPickup = db.orders.filter(o => o.status === 'ready-for-pickup').length;
        const inWashing = db.orders.filter(o => o.status === 'processing').length;

        document.getElementById('staff-stat-today-apts').textContent = todayApts.length;
        document.getElementById('staff-stat-pending-checkins').textContent = pendingCheckins;
        document.getElementById('staff-stat-in-wash').textContent = inWashing;
        document.getElementById('staff-stat-ready').textContent = readyForPickup;

        // Queue preview table
        const previewContainer = document.getElementById('staff-today-queue-preview');
        if (previewContainer) {
            if (todayApts.length === 0) {
                previewContainer.innerHTML = '<p style="color: var(--slate-500); padding: 1.5rem; text-align: center;">No appointments scheduled for today.</p>';
            } else {
                previewContainer.innerHTML = todayApts.slice(0, 5).map(apt => {
                    const cust = db.users.find(u => u.id === apt.customerId) || { firstName: 'Customer', lastName: '' };
                    const slot = db.timeSlots.find(s => s.id === apt.timeSlotId) || { startTime: '09:00' };
                    const order = db.orders.find(o => o.appointmentId === apt.id);

                    return `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.9rem 1.25rem; border-bottom: 1px solid var(--border-subtle);">
                            <div>
                                <div style="font-weight: 700; color: var(--slate-900);">${cust.firstName} ${cust.lastName}</div>
                                <div style="font-size: 0.8rem; color: var(--slate-500);">Slot: ${slot.startTime} • Order: ${order ? order.id : 'N/A'}</div>
                            </div>
                            <div>
                                ${order && order.status === 'pending' ? `
                                    <button class="btn btn-primary btn-sm" onclick="app.checkInOrder('${order.id}', '${apt.id}')">Check In</button>
                                ` : `
                                    <span class="badge ${this.getStatusBadgeClass(order ? order.status : 'pending')}">${order ? order.status : 'scheduled'}</span>
                                `}
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }
    },

    loadStaffQueue() {
        const queueList = document.getElementById('staff-queue-items');
        if (!queueList) return;

        const today = new Date().toISOString().split('T')[0];
        const appointments = db.appointments.filter(a => a.appointmentDate === today && a.status === 'scheduled');

        if (appointments.length === 0) {
            queueList.innerHTML = `
                <div style="text-align: center; padding: 3rem; color: var(--slate-400);">
                    <i class="fa-solid fa-calendar-check" style="font-size: 3rem; margin-bottom: 1rem; display:block;"></i>
                    <p style="font-weight: 700; color: var(--slate-700);">All customer drop-offs for today are processed!</p>
                </div>
            `;
            return;
        }

        queueList.innerHTML = appointments.map((apt, index) => {
            const cust = db.users.find(u => u.id === apt.customerId) || { firstName: 'Guest', lastName: '', phone: '—' };
            const slot = db.timeSlots.find(s => s.id === apt.timeSlotId) || { startTime: '09:00', endTime: '11:00' };
            const order = db.orders.find(o => o.appointmentId === apt.id);
            const srv = order ? db.services.find(s => s.id === order.serviceId) : null;

            return `
                <div class="card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
                    <div style="display: flex; align-items: center; gap: 1.25rem;">
                        <div style="font-size: 1.75rem; font-weight: 900; color: var(--brand-primary); min-width: 45px;">#${index + 1}</div>
                        <div>
                            <div style="font-weight: 800; font-size: 1.1rem; color: var(--slate-900);">${cust.firstName} ${cust.lastName}</div>
                            <div style="font-size: 0.85rem; color: var(--slate-500);">
                                Slot: <strong>${slot.startTime}</strong> • Phone: <strong>${cust.phone}</strong> • ${srv ? srv.name : ''} (${order ? order.quantity : 0} kg)
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <span class="badge ${this.getStatusBadgeClass(order ? order.status : 'pending')}">${order ? order.status : 'scheduled'}</span>
                        ${order && order.status === 'pending' ? `
                            <button class="btn btn-primary btn-sm" onclick="app.checkInOrder('${order.id}', '${apt.id}')">
                                <i class="fa-solid fa-clipboard-check"></i> Check-In Order
                            </button>
                        ` : ''}
                        ${order ? `
                            <button class="btn btn-secondary btn-sm" onclick="app.printOrderSlip('${order.id}')">
                                <i class="fa-solid fa-receipt"></i> Slip
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    },

    checkInOrder(orderId, aptId) {
        const order = db.orders.find(o => o.id === orderId);
        if (!order) return;

        order.status = 'processing';
        db.queueEntries.push({
            id: uid('q-'),
            orderId: orderId,
            appointmentId: aptId,
            checkedInTime: new Date().toISOString(),
            staffId: this.currentUser.id
        });

        this.saveDB('orders');
        this.saveDB('queueEntries');
        this.addNotification(order.customerId, order.id, aptId, 'order-status', `Your laundry batch (${order.id}) has been checked in and is currently in washing.`);
        this.showToast(`Order ${order.id} checked in & set to Processing!`, 'success');

        if (document.getElementById('page-staff-queue').classList.contains('active')) {
            this.loadStaffQueue();
        } else {
            this.loadStaffDashboard();
        }
    },

    loadStaffOrders() {
        const container = document.getElementById('staff-orders-table-body');
        if (!container) return;

        const query = document.getElementById('staff-order-search-input')?.value.toLowerCase() || '';
        const filterStatus = document.getElementById('staff-order-filter-status')?.value || 'all';

        let filtered = db.orders.filter(o => {
            const cust = db.users.find(u => u.id === o.customerId) || { firstName: '', lastName: '' };
            const srv = db.services.find(s => s.id === o.serviceId) || { name: '' };
            const matchQuery = o.id.toLowerCase().includes(query) ||
                               `${cust.firstName} ${cust.lastName}`.toLowerCase().includes(query) ||
                               srv.name.toLowerCase().includes(query);

            const matchStatus = filterStatus === 'all' || o.status === filterStatus;
            return matchQuery && matchStatus;
        });

        if (filtered.length === 0) {
            container.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 2.5rem; color: var(--slate-400);">No orders found matching your filter criteria.</td></tr>`;
            return;
        }

        container.innerHTML = filtered.map(o => {
            const cust = db.users.find(u => u.id === o.customerId) || { firstName: 'Customer', lastName: '' };
            const srv = db.services.find(s => s.id === o.serviceId) || { name: 'Service' };

            return `
                <tr>
                    <td><strong>${o.id}</strong></td>
                    <td>${cust.firstName} ${cust.lastName}</td>
                    <td>${srv.name}</td>
                    <td>${o.quantity} kg</td>
                    <td><strong>${db.shop.currency}${o.totalPrice.toFixed(2)}</strong></td>
                    <td>
                        <select class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.8rem;" onchange="app.updateOrderStatus('${o.id}', this.value)">
                            <option value="pending" ${o.status === 'pending' ? 'selected' : ''}>Pending</option>
                            <option value="processing" ${o.status === 'processing' ? 'selected' : ''}>Processing</option>
                            <option value="ready-for-pickup" ${o.status === 'ready-for-pickup' ? 'selected' : ''}>Ready for Pickup</option>
                            <option value="picked-up" ${o.status === 'picked-up' ? 'selected' : ''}>Picked Up</option>
                        </select>
                    </td>
                    <td>
                        <button class="btn btn-secondary btn-sm" onclick="app.printOrderSlip('${o.id}')" title="Print Claim Stub">
                            <i class="fa-solid fa-print"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    },

    updateOrderStatus(orderId, newStatus) {
        const order = db.orders.find(o => o.id === orderId);
        if (order) {
            order.status = newStatus;
            if (newStatus === 'picked-up') {
                order.completedAt = new Date().toISOString();
            }
            this.saveDB('orders');

            // Notify Customer
            let message = `Order ${order.id} status updated to: ${newStatus.replace('-', ' ')}.`;
            if (newStatus === 'ready-for-pickup') {
                message = `Good news! Your clean garments for order ${order.id} are ready for pickup at our store!`;
            } else if (newStatus === 'picked-up') {
                message = `Thank you for trusting CleanPro! Order ${order.id} was claimed.`;
            }

            this.addNotification(order.customerId, order.id, order.appointmentId, 'order-status', message);
            this.showToast(`Order ${order.id} status updated to ${newStatus}`, 'success');

            if (document.getElementById('page-staff-orders').classList.contains('active')) {
                this.loadStaffOrders();
            }
        }
    },

    // ==========================================
    // 8. ADMIN / OWNER MANAGEMENT
    // ==========================================
    loadAdminView(pageId) {
        switch (pageId) {
            case 'admin-dashboard':
                this.loadAdminDashboard();
                break;
            case 'admin-appointments':
                this.loadAdminAppointments();
                break;
            case 'admin-timeslots':
                this.loadAdminTimeSlots();
                break;
            case 'admin-users':
                this.loadAdminUsers();
                break;
            case 'admin-services':
                this.loadAdminServices();
                break;
            case 'admin-pickups':
                this.loadAdminPickups();
                break;
            case 'admin-announcements':
                this.loadAdminAnnouncements();
                break;
            case 'admin-reports':
                this.generateReport('monthly');
                break;
            case 'admin-settings':
                this.loadAdminSettings();
                break;
        }
    },

    loadAdminDashboard() {
        const customersCount = db.users.filter(u => u.role === 'customer').length;
        const staffCount = db.users.filter(u => u.role === 'staff').length;
        const today = new Date().toISOString().split('T')[0];
        const todayApts = db.appointments.filter(a => a.appointmentDate === today).length;
        const activeOrders = db.orders.filter(o => o.status !== 'picked-up').length;

        const currentMonth = today.slice(0, 7);
        const revenue = db.orders
            .filter(o => o.status === 'picked-up' && (o.completedAt || o.createdAt).slice(0, 7) === currentMonth)
            .reduce((sum, o) => sum + o.totalPrice, 0);

        document.getElementById('admin-stat-customers').textContent = customersCount;
        const staffStat = document.getElementById('admin-stat-staff');
        if (staffStat) staffStat.textContent = staffCount;
        document.getElementById('admin-stat-today-apts').textContent = todayApts;
        document.getElementById('admin-stat-active-orders').textContent = activeOrders;
        document.getElementById('admin-stat-revenue').textContent = `${db.shop.currency}${revenue.toLocaleString()}`;

        // Recent orders table
        const recentBody = document.getElementById('admin-recent-orders-table');
        if (recentBody) {
            recentBody.innerHTML = db.orders.slice(-5).reverse().map(o => {
                const cust = db.users.find(u => u.id === o.customerId) || { firstName: 'Customer', lastName: '' };
                const srv = db.services.find(s => s.id === o.serviceId) || { name: 'Service' };
                return `
                    <tr>
                        <td><strong>${o.id}</strong></td>
                        <td>${cust.firstName} ${cust.lastName}</td>
                        <td>${srv.name}</td>
                        <td>${db.shop.currency}${o.totalPrice.toFixed(2)}</td>
                        <td><span class="badge ${this.getStatusBadgeClass(o.status)}">${o.status}</span></td>
                    </tr>
                `;
            }).join('');
        }
    },

    loadAdminUsers(filteredUsers = null) {
        const tbody = document.getElementById('admin-users-table-body');
        if (!tbody) return;

        const usersToShow = filteredUsers || db.users;

        tbody.innerHTML = usersToShow.map(u => `
            <tr>
                <td><strong>${u.firstName} ${u.lastName}</strong></td>
                <td>${u.email}</td>
                <td><span class="badge badge-slate">${(u.role === 'admin' || u.role === 'owner') ? 'owner' : u.role}</span></td>
                <td>${u.phone || '—'}</td>
                <td><span class="badge ${u.status === 'active' ? 'badge-success' : 'badge-danger'}">${u.status}</span></td>
                <td>
                    ${u.id !== this.currentUser.id ? `
                        <button class="btn btn-secondary btn-sm" onclick="app.toggleUserStatus('${u.id}')">
                            ${u.status === 'active' ? 'Deactivate' : 'Activate'}
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="app.resetUserPassword('${u.id}')">
                            <i class="fa-solid fa-key"></i> Reset Password
                        </button>
                    ` : '<span style="color: var(--slate-400); font-size: 0.8rem;">Current Account</span>'}
                </td>
            </tr>
        `).join('');
    },

    async addStaff(e) {
        e.preventDefault();
        const body = {
            email: document.getElementById('new-staff-email').value.trim(),
            password: document.getElementById('new-staff-password').value,
            firstName: document.getElementById('new-staff-fname').value.trim(),
            lastName: document.getElementById('new-staff-lname').value.trim(),
            phone: document.getElementById('new-staff-phone').value.trim()
        };
        try {
            await API.request('auth.php?action=create-staff', { method: 'POST', body });
            await this.refreshData();
            this.showToast('New staff member added!', 'success');
            this.closeModal('modal-add-staff');
            this.loadAdminUsers();
        } catch (err) {
            this.showToast(err.message, 'danger');
        }
    },

    async toggleUserStatus(userId) {
        const user = db.users.find(u => u.id === userId);
        if (!user) return;
        const next = user.status === 'active' ? 'inactive' : 'active';
        try {
            await API.request('auth.php?action=user-status', { method: 'POST', body: { id: userId, status: next } });
            await this.refreshData();
            this.showToast(`User status changed to ${next}`, 'info');
            this.loadAdminUsers();
        } catch (err) {
            this.showToast(err.message, 'danger');
        }
    },

    async resetUserPassword(userId) {
        const user = db.users.find(u => u.id === userId);
        if (!user) return;
        const pw = prompt(`Set a new password for ${user.firstName} ${user.lastName} (min 6 characters):`);
        if (pw === null) return;
        try {
            await API.request('auth.php?action=user-password', { method: 'POST', body: { id: userId, password: pw } });
            this.showToast('Password updated. Share the new password with the user securely.', 'success');
        } catch (err) {
            this.showToast(err.message, 'danger');
        }
    },

    loadAdminTimeSlots() {
        const container = document.getElementById('admin-timeslots-grid');
        if (!container) return;

        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        container.innerHTML = db.timeSlots.map(slot => `
            <div class="card" style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-weight: 800; font-size: 1.05rem; color: var(--slate-900);">${days[slot.dayOfWeek]}</div>
                    <div style="color: var(--slate-600); font-size: 0.9rem; margin-top: 0.2rem;">
                        <i class="fa-regular fa-clock"></i> ${slot.startTime} - ${slot.endTime}
                    </div>
                    <div style="font-size: 0.8rem; color: var(--slate-500); margin-top: 0.25rem;">
                        Max Capacity: <strong>${slot.maxCapacity} orders</strong>
                    </div>
                </div>
                <button class="btn btn-danger btn-sm" onclick="app.deleteTimeSlot('${slot.id}')">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
        `).join('');
    },

    addTimeSlot(e) {
        e.preventDefault();
        const newSlot = {
            id: uid('slot-'),
            dayOfWeek: parseInt(document.getElementById('new-slot-day').value),
            startTime: document.getElementById('new-slot-start').value,
            endTime: document.getElementById('new-slot-end').value,
            maxCapacity: parseInt(document.getElementById('new-slot-capacity').value) || 5,
            currentBookings: 0,
            isActive: true
        };

        db.timeSlots.push(newSlot);
        this.saveDB('timeSlots');
        this.showToast('Time slot configured successfully.', 'success');
        this.closeModal('modal-add-slot');
        this.loadAdminTimeSlots();
    },

    deleteTimeSlot(slotId) {
        if (!confirm('Are you sure you want to remove this time slot?')) return;
        db.timeSlots = db.timeSlots.filter(s => s.id !== slotId);
        this.saveDB('timeSlots');
        this.showToast('Time slot removed.', 'info');
        this.loadAdminTimeSlots();
    },

    loadAdminAppointments(filteredApts = null) {
        const tbody = document.getElementById('admin-appointments-table-body');
        if (!tbody) return;

        const appointmentsToShow = filteredApts || db.appointments;

        tbody.innerHTML = appointmentsToShow.map(apt => {
            const cust = db.users.find(u => u.id === apt.customerId) || { firstName: 'Customer', lastName: '' };
            const slot = db.timeSlots.find(s => s.id === apt.timeSlotId) || { startTime: '09:00' };
            const order = db.orders.find(o => o.appointmentId === apt.id);

            return `
                <tr>
                    <td><strong>${apt.id}</strong></td>
                    <td>${apt.appointmentDate}</td>
                    <td>${slot.startTime}</td>
                    <td>${cust.firstName} ${cust.lastName}</td>
                    <td>${order ? order.id : '—'}</td>
                    <td><span class="badge ${this.getStatusBadgeClass(apt.status)}">${apt.status}</span></td>
                </tr>
            `;
        }).join('');
    },

    loadAdminServices() {
        const grid = document.getElementById('admin-services-grid');
        if (!grid) return;

        grid.innerHTML = db.services.map(s => `
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem;">
                    <div style="font-size: 1.15rem; font-weight: 800; color: var(--slate-900);">${s.name}</div>
                    <span class="badge badge-success">${db.shop.currency}${s.basePrice} / kg</span>
                </div>
                <p style="font-size: 0.85rem; color: var(--slate-600); margin-bottom: 1rem; line-height: 1.5;">${s.description}</p>
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 0.75rem;">
                    <span style="font-size: 0.8rem; color: var(--slate-500);"><i class="fa-regular fa-clock"></i> ${s.estimatedDays} days turnaround</span>
                    <button class="btn btn-danger btn-sm" onclick="app.deleteService('${s.id}')">
                        <i class="fa-solid fa-trash"></i> Delete
                    </button>
                </div>
            </div>
        `).join('');
    },

    addService(e) {
        e.preventDefault();
        const service = {
            id: uid('srv-'),
            name: document.getElementById('new-srv-name').value.trim(),
            description: document.getElementById('new-srv-desc').value.trim(),
            basePrice: parseFloat(document.getElementById('new-srv-price').value),
            estimatedDays: parseInt(document.getElementById('new-srv-days').value) || 2,
            isActive: true
        };

        db.services.push(service);
        this.saveDB('services');
        this.showToast('New laundry service added.', 'success');
        this.closeModal('modal-add-service');
        this.loadAdminServices();
    },

    deleteService(serviceId) {
        if (!confirm('Are you sure you want to remove this service?')) return;
        db.services = db.services.filter(s => s.id !== serviceId);
        this.saveDB('services');
        this.showToast('Service removed.', 'info');
        this.loadAdminServices();
    },

    loadAdminPickups() {
        const container = document.getElementById('admin-pickups-list');
        if (!container) return;

        const readyOrders = db.orders.filter(o => o.status === 'ready-for-pickup');

        if (readyOrders.length === 0) {
            container.innerHTML = '<p style="color: var(--slate-500); text-align: center; padding: 2.5rem;">No orders are currently waiting for dispatch or pickup.</p>';
            return;
        }

        container.innerHTML = readyOrders.map(order => {
            const cust = db.users.find(u => u.id === order.customerId) || { firstName: 'Customer', lastName: '', phone: '', address: '' };
            const srv = db.services.find(s => s.id === order.serviceId) || { name: 'Service' };

            return `
                <div class="card" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
                    <div>
                        <div style="font-weight: 800; font-size: 1.1rem; color: var(--slate-900);">${order.id} • ${cust.firstName} ${cust.lastName}</div>
                        <div style="font-size: 0.85rem; color: var(--slate-600); margin-top: 0.2rem;">
                            ${srv.name} (${order.quantity} kg) • <strong>Delivery Address:</strong> ${cust.address}
                        </div>
                    </div>
                    <div style="display: flex; gap: 0.5rem;">
                        <button class="btn btn-success btn-sm" onclick="app.updateOrderStatus('${order.id}', 'picked-up')">
                            <i class="fa-solid fa-check"></i> Mark as Handed Over
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="app.printOrderSlip('${order.id}')">
                            <i class="fa-solid fa-print"></i> Slip
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    },

    loadAdminAnnouncements() {
        const list = document.getElementById('admin-announcements-list');
        if (!list) return;

        list.innerHTML = db.announcements.map(a => `
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
                    <h3 style="font-size: 1.1rem; font-weight: 800; color: var(--slate-900);">${a.title}</h3>
                    <span class="badge ${a.isActive ? 'badge-success' : 'badge-danger'}">${a.isActive ? 'Active' : 'Inactive'}</span>
                </div>
                <p style="font-size: 0.9rem; color: var(--slate-600); margin-bottom: 0.75rem;">${a.content}</p>
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 0.75rem;">
                    <span style="font-size: 0.8rem; color: var(--slate-400);">Display: ${a.startDate} to ${a.endDate}</span>
                    <button class="btn btn-danger btn-sm" onclick="app.deleteAnnouncement('${a.id}')">
                        <i class="fa-solid fa-trash"></i> Delete
                    </button>
                </div>
            </div>
        `).join('');
    },

    addAnnouncement(e) {
        e.preventDefault();
        const anc = {
            id: uid('anc-'),
            title: document.getElementById('new-anc-title').value.trim(),
            content: document.getElementById('new-anc-content').value.trim(),
            type: document.getElementById('new-anc-type').value,
            startDate: document.getElementById('new-anc-start').value,
            endDate: document.getElementById('new-anc-end').value,
            isActive: true,
            notify: document.getElementById('new-anc-notify')?.checked !== false,
            createdAt: new Date().toISOString()
        };

        db.announcements.push(anc);
        this.saveDB('announcements');
        this.showToast(anc.notify ? 'Announcement posted and sent to all customers and staff!' : 'Announcement posted (no notification sent).', 'success');
        this.closeModal('modal-add-announcement');
        this.loadAdminAnnouncements();
    },

    deleteAnnouncement(ancId) {
        if (!confirm('Delete this announcement?')) return;
        db.announcements = db.announcements.filter(a => a.id !== ancId);
        this.saveDB('announcements');
        this.showToast('Announcement deleted.', 'info');
        this.loadAdminAnnouncements();
    },

    generateReport(type) {
        const resultsEl = document.getElementById('admin-report-container');
        if (!resultsEl) return;

        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        let relevantOrders = [];
        let title = '';

        if (type === 'daily') {
            title = `Daily Revenue & Operations Summary (${todayStr})`;
            relevantOrders = db.orders.filter(o => o.createdAt.slice(0, 10) === todayStr);
        } else if (type === 'weekly') {
            title = 'Last 7 Days Rolling Performance Report';
            const weekAgo = new Date(today.getTime() - 7 * 86400000);
            relevantOrders = db.orders.filter(o => new Date(o.createdAt) >= weekAgo);
        } else if (type === 'monthly') {
            const thisMonth = todayStr.slice(0, 7);
            title = `Monthly Business Report (${thisMonth})`;
            relevantOrders = db.orders.filter(o => o.createdAt.slice(0, 7) === thisMonth);
        } else if (type === 'services') {
            title = 'Service Performance Report';
            relevantOrders = db.orders;
        } else if (type === 'customers') {
            title = 'Top Customers Report';
            relevantOrders = db.orders;
        }

        const totalRevenue = relevantOrders.reduce((sum, o) => sum + o.totalPrice, 0);
        const completedCount = relevantOrders.filter(o => o.status === 'picked-up').length;
        const avgOrder = relevantOrders.length ? (totalRevenue / relevantOrders.length).toFixed(2) : 0;

        let reportHTML = `
            <div style="margin-bottom: 1.5rem;">
                <h3 style="font-size: 1.25rem; font-weight: 800; color: var(--slate-900);">${title}</h3>
                <p style="font-size: 0.85rem; color: var(--slate-500);">Generated on ${today.toLocaleString()}</p>
            </div>
            <div class="stats-grid">
                <div class="stat-card emerald">
                    <div class="stat-content">
                        <div class="stat-label">Total Revenue</div>
                        <div class="stat-value">${db.shop.currency}${totalRevenue.toLocaleString()}</div>
                    </div>
                    <div class="stat-icon-box"><i class="fa-solid fa-peso-sign"></i></div>
                </div>
                <div class="stat-card sky">
                    <div class="stat-content">
                        <div class="stat-label">Total Orders Logged</div>
                        <div class="stat-value">${relevantOrders.length}</div>
                    </div>
                    <div class="stat-icon-box"><i class="fa-solid fa-receipt"></i></div>
                </div>
                <div class="stat-card">
                    <div class="stat-content">
                        <div class="stat-label">Claimed & Completed</div>
                        <div class="stat-value">${completedCount}</div>
                    </div>
                    <div class="stat-icon-box"><i class="fa-solid fa-circle-check"></i></div>
                </div>
                <div class="stat-card amber">
                    <div class="stat-content">
                        <div class="stat-label">Avg. Order Value</div>
                        <div class="stat-value">${db.shop.currency}${avgOrder}</div>
                    </div>
                    <div class="stat-icon-box"><i class="fa-solid fa-calculator"></i></div>
                </div>
            </div>
        `;

        // Add service-specific data if requested
        if (type === 'services') {
            reportHTML += '<h4 style="margin-top: 2rem; margin-bottom: 1rem; font-weight: 700;">Revenue by Service:</h4>';
            const serviceStats = {};
            relevantOrders.forEach(o => {
                if (!serviceStats[o.serviceId]) serviceStats[o.serviceId] = { count: 0, revenue: 0 };
                serviceStats[o.serviceId].count++;
                serviceStats[o.serviceId].revenue += o.totalPrice;
            });
            
            Object.entries(serviceStats).forEach(([serviceId, stats]) => {
                const service = db.services.find(s => s.id === serviceId);
                const serviceName = service ? service.name : 'Unknown Service';
                reportHTML += `
                    <div style="padding: 0.75rem; border-bottom: 1px solid #e5e7eb;">
                        <div style="display: flex; justify-content: space-between;">
                            <span>${serviceName}</span>
                            <span style="font-weight: 700;">${db.shop.currency}${stats.revenue.toLocaleString()} (${stats.count} orders)</span>
                        </div>
                    </div>
                `;
            });
        }

        // Add customer-specific data if requested
        if (type === 'customers') {
            reportHTML += '<h4 style="margin-top: 2rem; margin-bottom: 1rem; font-weight: 700;">Top 10 Customers:</h4>';
            const customerStats = {};
            relevantOrders.forEach(o => {
                if (!customerStats[o.customerId]) customerStats[o.customerId] = { count: 0, revenue: 0 };
                customerStats[o.customerId].count++;
                customerStats[o.customerId].revenue += o.totalPrice;
            });
            
            const sortedCustomers = Object.entries(customerStats)
                .sort((a, b) => b[1].revenue - a[1].revenue)
                .slice(0, 10);

            sortedCustomers.forEach(([customerId, stats]) => {
                const customer = db.users.find(u => u.id === customerId);
                const customerName = customer ? `${customer.firstName} ${customer.lastName}` : 'Unknown';
                reportHTML += `
                    <div style="padding: 0.75rem; border-bottom: 1px solid #e5e7eb;">
                        <div style="display: flex; justify-content: space-between;">
                            <span>${customerName}</span>
                            <span style="font-weight: 700;">${db.shop.currency}${stats.revenue.toLocaleString()} (${stats.count} orders)</span>
                        </div>
                    </div>
                `;
            });
        }

        resultsEl.innerHTML = reportHTML;
    },

    // Password recovery function
    resetPassword(event) {
        event.preventDefault();
        this.closeModal('modal-forgot-password');
        this.showToast('Please contact the shop. The owner can set a new password for you.', 'info');
    },

    // Filter appointments by search query
    filterAppointments(query) {
        const lowerQuery = query.toLowerCase();
        const filteredApts = db.appointments.filter(apt => {
            const customer = db.users.find(u => u.id === apt.customerId);
            return (
                apt.appointmentDate.includes(query) ||
                apt.status.toLowerCase().includes(lowerQuery) ||
                (customer && customer.firstName.toLowerCase().includes(lowerQuery)) ||
                (customer && customer.lastName.toLowerCase().includes(lowerQuery)) ||
                (customer && customer.email.toLowerCase().includes(lowerQuery))
            );
        });
        this.loadAdminAppointments(filteredApts);
    },

    // Filter users by search query
    filterUsers(query) {
        const lowerQuery = query.toLowerCase();
        const filteredUsers = db.users.filter(user =>
            user.firstName.toLowerCase().includes(lowerQuery) ||
            user.lastName.toLowerCase().includes(lowerQuery) ||
            user.email.toLowerCase().includes(lowerQuery) ||
            (user.phone && user.phone.includes(query)) ||
            user.role.toLowerCase().includes(lowerQuery)
        );
        this.loadAdminUsers(filteredUsers);
    },

    // Filter report data
    filterReportData(query) {
        // This function provides basic filtering for report search
        if (!query) return;
        const container = document.getElementById('admin-report-container');
        if (container) {
            const text = container.innerText;
            if (!text.toLowerCase().includes(query.toLowerCase())) {
                alert('No matching data found in report.');
            }
        }
    },

    loadAdminSettings() {
        // Load Owner Personal Account Info
        if (this.currentUser) {
            const ownerFname = document.getElementById('owner-cfg-fname');
            const ownerLname = document.getElementById('owner-cfg-lname');
            const ownerEmail = document.getElementById('owner-cfg-email');
            const ownerPhone = document.getElementById('owner-cfg-phone');
            const ownerPass = document.getElementById('owner-cfg-password');

            if (ownerFname) {
                ownerFname.value = this.currentUser.firstName || '';
                ownerFname.onchange = () => this.autoSaveOwnerField('firstName', ownerFname.value);
            }
            if (ownerLname) {
                ownerLname.value = this.currentUser.lastName || '';
                ownerLname.onchange = () => this.autoSaveOwnerField('lastName', ownerLname.value);
            }
            if (ownerEmail) {
                ownerEmail.value = this.currentUser.email || '';
                ownerEmail.onchange = () => this.autoSaveOwnerField('email', ownerEmail.value);
            }
            if (ownerPhone) {
                ownerPhone.value = this.currentUser.phone || '';
                ownerPhone.onchange = () => this.autoSaveOwnerField('phone', ownerPhone.value);
            }
            if (ownerPass) {
                ownerPass.value = '';
                ownerPass.onchange = () => this.autoSaveOwnerField('password', ownerPass.value);
            }
        }

        // Load Shop & Policy Configuration with auto-save
        const shopName = document.getElementById('shop-cfg-name');
        const shopTagline = document.getElementById('shop-cfg-tagline');
        const shopPhone = document.getElementById('shop-cfg-phone');
        const shopEmail = document.getElementById('shop-cfg-email');
        const shopAddress = document.getElementById('shop-cfg-address');
        const shopOpen = document.getElementById('shop-cfg-open');
        const shopClose = document.getElementById('shop-cfg-close');
        const bookWindow = document.getElementById('sys-cfg-book-window');
        const cancelWindow = document.getElementById('sys-cfg-cancel-window');

        if (shopName) {
            shopName.value = db.shop.name;
            shopName.onchange = () => this.autoSaveShopField('name', shopName.value);
        }
        if (shopTagline) {
            shopTagline.value = db.shop.tagline;
            shopTagline.onchange = () => this.autoSaveShopField('tagline', shopTagline.value);
        }
        if (shopPhone) {
            shopPhone.value = db.shop.phone;
            shopPhone.onchange = () => this.autoSaveShopField('phone', shopPhone.value);
        }
        if (shopEmail) {
            shopEmail.value = db.shop.email;
            shopEmail.onchange = () => this.autoSaveShopField('email', shopEmail.value);
        }
        if (shopAddress) {
            shopAddress.value = db.shop.address;
            shopAddress.onchange = () => this.autoSaveShopField('address', shopAddress.value);
        }
        if (shopOpen) {
            shopOpen.value = db.shop.openingTime;
            shopOpen.onchange = () => this.autoSaveShopField('openingTime', shopOpen.value);
        }
        if (shopClose) {
            shopClose.value = db.shop.closingTime;
            shopClose.onchange = () => this.autoSaveShopField('closingTime', shopClose.value);
        }
        if (bookWindow) {
            bookWindow.value = db.settings.bookingWindow;
            bookWindow.onchange = () => this.autoSaveSettingsField('bookingWindow', parseInt(bookWindow.value));
        }
        if (cancelWindow) {
            cancelWindow.value = db.settings.cancelWindow;
            cancelWindow.onchange = () => this.autoSaveSettingsField('cancelWindow', parseInt(cancelWindow.value));
        }

        // Refresh logo preview box
        this.refreshLogoPreviewBox();
    },

    // ==========================================
    // AUTO-SAVE FUNCTIONS
    // ==========================================

    /**
     * Auto-save owner field changes immediately
     */
    async autoSaveOwnerField(field, value) {
        if (!this.currentUser) return;

        if (field === 'password') {
            if (!value) return;
            if (value.length < 6) {
                this.showToast('Password must be at least 6 characters.', 'warning');
                return;
            }
        } else if (typeof value === 'string') {
            value = value.trim();
            if (value === '' && field !== 'phone') return;
        }

        try {
            const res = await API.request('auth.php?action=profile', { method: 'POST', body: { [field]: value } });
            this.currentUser = res.user;
            const idx = db.users.findIndex(u => u.id === res.user.id);
            if (idx >= 0) db.users[idx] = res.user;
            this.updateHeaderUserInfo();
            if (field === 'password') {
                const pf = document.getElementById('owner-cfg-password');
                if (pf) pf.value = '';
            }
            this.showToast(`Owner ${field} updated automatically`, 'success');
        } catch (err) {
            this.showToast(err.message, 'danger');
        }
    },

    /**
     * Auto-save shop field changes immediately
     */
    autoSaveShopField(field, value) {
        if (!value || value.trim() === '') return;

        db.shop[field] = value.trim();
        this.saveDB('shop');
        this.updateShopBranding();

        // Show save indicator
        this.showToast(`Shop ${field} saved automatically`, 'success');
    },

    /**
     * Auto-save settings field changes immediately
     */
    autoSaveSettingsField(field, value) {
        if (value === undefined || value === null) return;

        db.settings[field] = value;
        this.saveDB('settings');

        // Show save indicator
        this.showToast(`Setting "${field}" saved automatically`, 'success');
    },

    async saveSettings(e) {
        if (e) e.preventDefault();

        // Note: Most fields auto-save on change event
        // This function provides a manual override and confirmation

        let changeCount = 0;

        // 1. Check and save Owner Personal Profile if changed
        const newFname = document.getElementById('owner-cfg-fname')?.value.trim();
        const newLname = document.getElementById('owner-cfg-lname')?.value.trim();
        const newEmail = document.getElementById('owner-cfg-email')?.value.trim();
        const newPhone = document.getElementById('owner-cfg-phone')?.value.trim();
        const newPass = document.getElementById('owner-cfg-password')?.value;

        if (this.currentUser && (this.currentUser.role === 'admin' || this.currentUser.role === 'owner')) {
            const profile = {};
            if (newFname && newFname !== this.currentUser.firstName) profile.firstName = newFname;
            if (newLname && newLname !== this.currentUser.lastName) profile.lastName = newLname;
            if (newEmail && newEmail !== this.currentUser.email) profile.email = newEmail;
            if (newPhone && newPhone !== this.currentUser.phone) profile.phone = newPhone;
            if (newPass && newPass.length >= 6) profile.password = newPass;

            if (Object.keys(profile).length) {
                try {
                    const res = await API.request('auth.php?action=profile', { method: 'POST', body: profile });
                    this.currentUser = res.user;
                    changeCount += Object.keys(profile).length;
                    this.updateHeaderUserInfo();
                } catch (err) {
                    this.showToast(err.message, 'danger');
                    return;
                }
            }

            // Clear password field after save
            const passField = document.getElementById('owner-cfg-password');
            if (passField) passField.value = '';
        }

        // 2. Check and save Store Profile & Branding
        const currentName = db.shop.name;
        const currentTagline = db.shop.tagline;
        const currentPhone = db.shop.phone;
        const currentEmail = db.shop.email;
        const currentAddress = db.shop.address;
        const currentOpen = db.shop.openingTime;
        const currentClose = db.shop.closingTime;

        const shopName = document.getElementById('shop-cfg-name').value.trim();
        const shopTagline = document.getElementById('shop-cfg-tagline').value.trim();
        const shopPhone = document.getElementById('shop-cfg-phone').value.trim();
        const shopEmail = document.getElementById('shop-cfg-email').value.trim();
        const shopAddress = document.getElementById('shop-cfg-address').value.trim();
        const shopOpen = document.getElementById('shop-cfg-open').value;
        const shopClose = document.getElementById('shop-cfg-close').value;

        if (shopName && shopName !== currentName) {
            db.shop.name = shopName;
            changeCount++;
        }
        if (shopTagline && shopTagline !== currentTagline) {
            db.shop.tagline = shopTagline;
            changeCount++;
        }
        if (shopPhone && shopPhone !== currentPhone) {
            db.shop.phone = shopPhone;
            changeCount++;
        }
        if (shopEmail && shopEmail !== currentEmail) {
            db.shop.email = shopEmail;
            changeCount++;
        }
        if (shopAddress && shopAddress !== currentAddress) {
            db.shop.address = shopAddress;
            changeCount++;
        }
        if (shopOpen && shopOpen !== currentOpen) {
            db.shop.openingTime = shopOpen;
            changeCount++;
        }
        if (shopClose && shopClose !== currentClose) {
            db.shop.closingTime = shopClose;
            changeCount++;
        }

        // 3. Check and save Policy Configuration
        const newBookWindow = parseInt(document.getElementById('sys-cfg-book-window').value);
        const newCancelWindow = parseInt(document.getElementById('sys-cfg-cancel-window').value);

        if (newBookWindow !== db.settings.bookingWindow) {
            db.settings.bookingWindow = newBookWindow || 30;
            changeCount++;
        }
        if (newCancelWindow !== db.settings.cancelWindow) {
            db.settings.cancelWindow = newCancelWindow || 24;
            changeCount++;
        }

        if (changeCount > 0) {
            this.saveDB('shop');
            this.saveDB('settings');
            this.updateShopBranding();
            this.showToast(`✓ All settings verified and saved! (${changeCount} changes detected)`, 'success');
        } else {
            this.showToast('✓ All settings are current - no changes detected. Auto-save is working!', 'info');
        }
    },

    // ==========================================
    // 9. LOGO FILE UPLOAD HANDLER
    // ==========================================

    /**
     * Reads the selected file and converts it to a base64 data URL,
     * immediately updating all logo slots across the page and
     * persisting the result to localStorage (AUTO-SAVE).
     */
    handleLogoFileUpload(event) {
        const file = event.target.files?.[0];
        if (!file) return;

        // Validate it is an image type
        if (!file.type.startsWith('image/')) {
            this.showToast('Please select a valid image file (PNG, JPG, SVG, WebP).', 'danger');
            event.target.value = '';
            return;
        }

        // Validate max 2 MB for logo
        const maxBytes = 2 * 1024 * 1024;
        if (file.size > maxBytes) {
            this.showToast('Image file is too large. Please use an image under 2 MB.', 'warning');
            event.target.value = '';
            return;
        }

        // Show uploading indicator
        this.showToast('Uploading and saving logo...', 'info');

        const finish = (finalUrl) => {
            db.shop.logo = finalUrl;
            this.saveDB('shop');
            this.updateShopBranding();
            this.refreshLogoPreviewBox();
            this.showToast('✓ Shop logo updated and saved!', 'success');
        };

        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            if (file.type === 'image/svg+xml') { finish(dataUrl); return; }

            // Shrink large images (max 512px) so the logo stays small and fast to load
            const img = new Image();
            img.onload = () => {
                const MAX = 512;
                const scale = Math.min(1, MAX / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                finish(file.type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.88) : canvas.toDataURL('image/png'));
            };
            img.onerror = () => this.showToast('That image could not be read. Try a PNG or JPG.', 'danger');
            img.src = dataUrl;
        };
        reader.readAsDataURL(file);
    },

    /** Updates the preview box inside the settings card */
    refreshLogoPreviewBox() {
        const previewBox = document.getElementById('shop-logo-preview-box');
        if (!previewBox) return;

        const isImage = this.isImageLogo(db.shop.logo);

        if (isImage) {
            previewBox.innerHTML = `<img src="${db.shop.logo}" alt="Logo preview" style="width: 100%; height: 100%; object-fit: contain; display: block;">`;
        } else {
            previewBox.innerHTML = db.shop.logo || '🧺';
        }
    },

    /** Resets the logo back to the default laundry basket emoji (AUTO-SAVE) */
    resetLogoToDefault() {
        db.shop.logo = 'laundry.jpg';
        this.saveDB('shop');
        this.updateShopBranding();
        this.refreshLogoPreviewBox();
        const fileInput = document.getElementById('shop-cfg-logo-file');
        if (fileInput) fileInput.value = '';
        this.showToast('✓ Logo reset to default and auto-saved!', 'success');
    },

    // ==========================================
    // 10. PRINTABLE CLAIM TICKET GENERATOR
    // ==========================================
    printOrderSlip(orderId) {
        const order = db.orders.find(o => o.id === orderId);
        if (!order) return;

        const cust = db.users.find(u => u.id === order.customerId) || { firstName: 'Valued Customer', lastName: '', phone: '—' };
        const srv = db.services.find(s => s.id === order.serviceId) || { name: 'Laundry Service', basePrice: 0 };
        const apt = db.appointments.find(a => a.id === order.appointmentId);

        const slipContainer = document.getElementById('claim-receipt-content');
        if (!slipContainer) return;

        // Build logo HTML for receipt
        const isImage = this.isImageLogo(db.shop.logo);
        const receiptLogoHTML = isImage
            ? `<img src="${db.shop.logo}" alt="${db.shop.name} logo">`
            : db.shop.logo || '🧺';

        slipContainer.innerHTML = `
            <div class="receipt-header">
                <div class="receipt-shop-logo">${receiptLogoHTML}</div>
                <div class="receipt-shop-name">${db.shop.name}</div>
                <div class="receipt-shop-info">
                    ${db.shop.address}<br>
                    Tel: ${db.shop.phone} • Email: ${db.shop.email}<br>
                    Hours: ${db.shop.openingTime} - ${db.shop.closingTime}
                </div>
            </div>

            <div class="receipt-meta-grid">
                <div><span>Claim Ticket:</span> <strong>#${order.id}</strong></div>
                <div><span>Date:</span> ${new Date(order.createdAt).toLocaleDateString()}</div>
                <div><span>Customer:</span> ${cust.firstName} ${cust.lastName}</div>
                <div><span>Contact:</span> ${cust.phone}</div>
                <div><span>Est. Pickup:</span> <strong>${order.estimatedPickupDate}</strong></div>
                <div><span>Status:</span> <span class="badge ${this.getStatusBadgeClass(order.status)}">${order.status}</span></div>
            </div>

            <table class="receipt-table">
                <thead>
                    <tr>
                        <th>Service Description</th>
                        <th style="text-align: right;">Weight/Qty</th>
                        <th style="text-align: right;">Rate</th>
                        <th style="text-align: right;">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><strong>${srv.name}</strong></td>
                        <td style="text-align: right;">${order.quantity} kg</td>
                        <td style="text-align: right;">${db.shop.currency}${srv.basePrice}</td>
                        <td style="text-align: right;">${db.shop.currency}${order.totalPrice.toFixed(2)}</td>
                    </tr>
                </tbody>
            </table>

            <div class="receipt-total-row">
                <span>TOTAL DUE</span>
                <span>${db.shop.currency}${order.totalPrice.toFixed(2)}</span>
            </div>

            <div style="background: var(--slate-50); padding: 0.75rem; border-radius: var(--radius-sm); font-size: 0.8rem; margin-bottom: 1rem;">
                <strong>Special Care Instructions:</strong><br>
                ${order.specialInstructions || 'Standard hygiene washing protocol'}
            </div>

            <div class="receipt-barcode">
                <!-- Simulated Clean Vector Barcode -->
                <svg class="barcode-svg" viewBox="0 0 100 20">
                    <rect x="0" y="0" width="2" height="20" fill="#0f172a"/>
                    <rect x="4" y="0" width="1" height="20" fill="#0f172a"/>
                    <rect x="7" y="0" width="3" height="20" fill="#0f172a"/>
                    <rect x="12" y="0" width="2" height="20" fill="#0f172a"/>
                    <rect x="16" y="0" width="1" height="20" fill="#0f172a"/>
                    <rect x="19" y="0" width="4" height="20" fill="#0f172a"/>
                    <rect x="25" y="0" width="2" height="20" fill="#0f172a"/>
                    <rect x="29" y="0" width="1" height="20" fill="#0f172a"/>
                    <rect x="32" y="0" width="3" height="20" fill="#0f172a"/>
                    <rect x="37" y="0" width="2" height="20" fill="#0f172a"/>
                    <rect x="41" y="0" width="1" height="20" fill="#0f172a"/>
                    <rect x="44" y="0" width="3" height="20" fill="#0f172a"/>
                    <rect x="49" y="0" width="2" height="20" fill="#0f172a"/>
                    <rect x="53" y="0" width="4" height="20" fill="#0f172a"/>
                    <rect x="59" y="0" width="1" height="20" fill="#0f172a"/>
                    <rect x="62" y="0" width="2" height="20" fill="#0f172a"/>
                    <rect x="66" y="0" width="3" height="20" fill="#0f172a"/>
                    <rect x="71" y="0" width="1" height="20" fill="#0f172a"/>
                    <rect x="74" y="0" width="2" height="20" fill="#0f172a"/>
                    <rect x="78" y="0" width="3" height="20" fill="#0f172a"/>
                    <rect x="83" y="0" width="1" height="20" fill="#0f172a"/>
                    <rect x="86" y="0" width="2" height="20" fill="#0f172a"/>
                    <rect x="90" y="0" width="4" height="20" fill="#0f172a"/>
                    <rect x="96" y="0" width="2" height="20" fill="#0f172a"/>
                </svg>
                <div style="font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 0.1em; color: var(--slate-600); margin-top: 0.25rem;">
                    *${order.id}*
                </div>
            </div>

            <div class="receipt-footer-note">
                Please present this slip when claiming your garments.<br>
                Items not claimed within 30 days will be donated or disposed of.<br>
                Thank you for choosing ${db.shop.name}!
            </div>
        `;

        this.openModal('modal-claim-receipt');
    },

    // ==========================================
    // 10. UTILITIES & MODAL HELPERS
    // ==========================================
    openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.add('active');
    },

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('active');
    },

    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const iconMap = {
            success: 'fa-circle-check',
            danger: 'fa-triangle-exclamation',
            warning: 'fa-circle-exclamation',
            info: 'fa-circle-info'
        };

        toast.innerHTML = `
            <i class="fa-solid ${iconMap[type] || 'fa-circle-info'}" style="font-size: 1.15rem;"></i>
            <span>${message}</span>
        `;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(40px)';
            toast.style.transition = 'all 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    },

    getStatusBadgeClass(status) {
        switch (status) {
            case 'completed':
            case 'picked-up':
                return 'badge-success';
            case 'processing':
                return 'badge-warning';
            case 'ready-for-pickup':
                return 'badge-info';
            case 'cancelled':
                return 'badge-danger';
            default:
                return 'badge-slate';
        }
    },

    // Queue a collection for saving to the server (sends only the records that changed)
    saveDB(key) {
        if (!this.currentUser) return;
        const role = (this.currentUser.role === 'admin') ? 'owner' : this.currentUser.role;
        if (!(WRITABLE[role] || []).includes(key)) return;   // server-managed (e.g. slot counters, users)
        if (!sync.queue.includes(key)) sync.queue.push(key);
        this.flushSync();
    }
};

// ==========================================
// 11. TAB CONTROLLERS
// ==========================================
function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.auth-tab-pane').forEach(p => p.style.display = 'none');

    const activeBtn = document.getElementById(`tab-btn-${tab}`);
    const activePane = document.getElementById(`tab-pane-${tab}`);

    if (activeBtn) activeBtn.classList.add('active');
    if (activePane) activePane.style.display = 'block';
}

// Bootstrap on DOM Ready
window.addEventListener('DOMContentLoaded', () => {
    app.init();
});
