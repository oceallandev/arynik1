import { VALID_ROLES, permissionsForRole } from '../auth/permissions';

// Demo mode is meant for showcasing the app without connecting to live APIs
// or exposing real operational data. Everything below is localStorage-backed.

const DEMO_LOGS_KEY = 'arynik_demo_logs_v1';
const DEMO_SHIPMENTS_KEY = 'arynik_demo_shipments_v1';
const DEMO_USERS_KEY = 'arynik_demo_users_v1';
const DEMO_NOTIFICATIONS_KEY = 'arynik_demo_notifications_v1';

const STATUS_OPTIONS = [
    { event_id: '1', label: 'Expediere preluata de Curier', description: 'Expediere preluata de Curier' },
    { event_id: '2', label: 'Expeditie Livrata', description: 'Expeditie Livrata' },
    { event_id: '3', label: 'Refuzare colet', description: 'Refuzare colet' },
    { event_id: '4', label: 'Expeditie returnata', description: 'Expeditie returnata' },
    { event_id: '5', label: 'Expeditie anulata', description: 'Expeditie anulata' },
    { event_id: '6', label: 'Intrare in depozit', description: 'Intrare in depozit' },
    { event_id: '7', label: 'Livrare reprogramata', description: 'Livrare reprogramata' },
    { event_id: 'R3', label: 'Ramburs transferat', description: 'Ramburs transferat' }
];

const EVENT_LABELS = STATUS_OPTIONS.reduce((acc, option) => {
    acc[option.event_id] = option.label;
    return acc;
}, {});

const EVENT_TO_STATUS = {
    '1': 'In Transit',
    '2': 'Delivered',
    '3': 'Refused',
    '4': 'Returned',
    '5': 'Cancelled',
    '6': 'In Depot',
    '7': 'Rescheduled',
    'R3': 'COD'
};

const hoursAgoIso = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const normalizeAwb = (awb) => String(awb || '').trim().toUpperCase();

const normalizePhone = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    let digits = raw.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('00') && digits.length > 2) digits = digits.slice(2);
    if (digits.length === 10 && digits.startsWith('0')) digits = `40${digits.slice(1)}`;
    else if (digits.length === 9 && digits.startsWith('7')) digits = `40${digits}`;
    return digits || null;
};

const safeParse = (raw, fallbackValue) => {
    try {
        const parsed = JSON.parse(raw);
        return parsed ?? fallbackValue;
    } catch {
        return fallbackValue;
    }
};

const loadJson = (key, fallbackFactory) => {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) {
            const seeded = fallbackFactory();
            localStorage.setItem(key, JSON.stringify(seeded));
            return seeded;
        }
        return safeParse(raw, fallbackFactory());
    } catch {
        return fallbackFactory();
    }
};

const saveJson = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { }
};

const makeId = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

const apiError = (detail) => {
    const error = new Error(detail);
    error.response = { data: { detail } };
    return error;
};

const toBase64Url = (value) => {
    const bytes = new TextEncoder().encode(String(value));
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
};

const buildDemoToken = (payload) => {
    const header = { alg: 'none', typ: 'JWT' };
    return `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}.demo`;
};

const decodeJwtPayload = (token) => {
    try {
        const base64Url = String(token || '').split('.')[1];
        if (!base64Url) return null;
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => (
            `%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`
        )).join(''));
        return JSON.parse(jsonPayload);
    } catch {
        return null;
    }
};

const currentAuth = () => {
    try {
        const token = localStorage.getItem('token');
        const payload = decodeJwtPayload(token);
        return { token, payload: payload || null };
    } catch {
        return { token: null, payload: null };
    }
};

const roleForUsername = (username) => {
    const normalized = String(username || '').trim().toLowerCase();
    if (normalized.includes('admin')) return 'Admin';
    if (normalized.includes('manager')) return 'Manager';
    if (normalized.includes('dispatch')) return 'Dispatcher';
    return 'Driver';
};

const initialUsers = () => ([
    {
        id: 1,
        driver_id: 'D001',
        name: 'Demo Admin',
        username: 'admin',
        role: 'Admin',
        active: true,
        last_login: null,
        truck_plate: null,
        truck_phone: null,
        helper_name: null
    },
    {
        id: 2,
        driver_id: 'D002',
        name: 'Demo Driver',
        username: 'driver',
        role: 'Driver',
        active: true,
        last_login: null,
        truck_plate: 'B-123-DEMO',
        truck_phone: '+40 700 000 000',
        helper_name: 'Helper Demo'
    },
    {
        id: 3,
        driver_id: 'D003',
        name: 'Demo Manager',
        username: 'manager',
        role: 'Manager',
        active: true,
        last_login: null,
        truck_plate: null,
        truck_phone: null,
        helper_name: null
    }
]);

const initialNotifications = () => ([]);

const initialShipments = () => ([
    {
        awb: 'AWB1000001',
        recipient_name: 'Maria Popescu',
        recipient_phone: '+40 712 000 001',
        delivery_address: 'Bucharest, Sector 1',
        locality: 'Bucuresti',
        county: 'Bucuresti',
        weight: 1.2,
        status: 'In Transit',
        cod_amount: 0,
        currency: 'RON',
        shipping_cost: 20.5,
        payment_amount: 20.5,
        driver_id: 'D002',
        created_date: hoursAgoIso(48),
        awb_status_date: hoursAgoIso(8),
        last_updated: hoursAgoIso(2),
        tracking_history: [
            { eventDescription: 'Expediere preluata de Curier', eventDate: hoursAgoIso(18), localityName: 'Bucuresti' },
            { eventDescription: 'In tranzit', eventDate: hoursAgoIso(8), localityName: 'Bucuresti' }
        ],
        raw_data: {
            recipientLocation: { locality: 'Bucuresti', county: 'Bucuresti' },
            senderLocation: { name: 'Demo Shop', locality: 'Bucuresti' }
        }
    },
    {
        awb: 'AWB1000002',
        recipient_name: 'Andrei Ionescu',
        recipient_phone: '+40 712 000 002',
        delivery_address: 'Cluj-Napoca, Str. Memorandumului 5',
        locality: 'Cluj-Napoca',
        county: 'Cluj',
        weight: 0.8,
        status: 'Rescheduled',
        cod_amount: 50,
        currency: 'RON',
        shipping_cost: 18.0,
        payment_amount: 18.0,
        driver_id: 'D002',
        created_date: hoursAgoIso(72),
        awb_status_date: hoursAgoIso(6),
        last_updated: hoursAgoIso(1),
        tracking_history: [
            { eventDescription: 'Livrare reprogramata', eventDate: hoursAgoIso(6), localityName: 'Cluj-Napoca' }
        ],
        raw_data: {
            recipientLocation: { locality: 'Cluj-Napoca', county: 'Cluj' },
            senderLocation: { name: 'Demo Electronics', locality: 'Cluj-Napoca' }
        }
    },
    {
        awb: 'AWB1000003',
        recipient_name: 'Elena Stan',
        recipient_phone: '+40 712 000 003',
        delivery_address: 'Iasi, Bulevardul Stefan cel Mare 10',
        locality: 'Iasi',
        county: 'Iasi',
        weight: 2.5,
        status: 'Delivered',
        cod_amount: 0,
        currency: 'RON',
        shipping_cost: 27.3,
        payment_amount: 27.3,
        driver_id: 'D002',
        created_date: hoursAgoIso(24),
        awb_status_date: hoursAgoIso(3),
        last_updated: hoursAgoIso(3),
        tracking_history: [
            { eventDescription: 'Expeditie Livrata', eventDate: hoursAgoIso(3), localityName: 'Iasi' }
        ],
        raw_data: {
            recipientLocation: { locality: 'Iasi', county: 'Iasi' },
            senderLocation: { name: 'Demo Fashion', locality: 'Iasi' }
        }
    },
    {
        awb: 'AWB1000004',
        recipient_name: 'Radu Dumitrescu',
        recipient_phone: '+40 712 000 004',
        delivery_address: 'Timisoara, Str. Take Ionescu 1',
        locality: 'Timisoara',
        county: 'Timis',
        weight: 4.0,
        status: 'In Depot',
        cod_amount: 0,
        currency: 'RON',
        shipping_cost: 33.0,
        payment_amount: 33.0,
        driver_id: 'D002',
        created_date: hoursAgoIso(12),
        awb_status_date: hoursAgoIso(12),
        last_updated: hoursAgoIso(12),
        tracking_history: [
            { eventDescription: 'Intrare in depozit', eventDate: hoursAgoIso(12), localityName: 'Timisoara' }
        ],
        raw_data: {
            recipientLocation: { locality: 'Timisoara', county: 'Timis' },
            senderLocation: { name: 'Demo Furniture', locality: 'Timisoara' }
        }
    }
]);

const getUsersStore = () => {
    const users = loadJson(DEMO_USERS_KEY, initialUsers);
    return Array.isArray(users) ? users : initialUsers();
};

const setUsersStore = (users) => saveJson(DEMO_USERS_KEY, Array.isArray(users) ? users : []);

const getShipmentsStore = () => {
    const shipments = loadJson(DEMO_SHIPMENTS_KEY, initialShipments);
    return Array.isArray(shipments) ? shipments : initialShipments();
};

const setShipmentsStore = (shipments) => saveJson(DEMO_SHIPMENTS_KEY, Array.isArray(shipments) ? shipments : []);

const getLogsStore = () => {
    const logs = loadJson(DEMO_LOGS_KEY, () => []);
    return Array.isArray(logs) ? logs : [];
};

const setLogsStore = (logs) => saveJson(DEMO_LOGS_KEY, Array.isArray(logs) ? logs : []);

const getNotificationsStore = () => {
    const items = loadJson(DEMO_NOTIFICATIONS_KEY, initialNotifications);
    return Array.isArray(items) ? items : initialNotifications();
};

const setNotificationsStore = (items) => saveJson(DEMO_NOTIFICATIONS_KEY, Array.isArray(items) ? items : []);

const isRoleAllowedAllLogs = (role) => {
    const perms = new Set(permissionsForRole(role));
    return perms.has('logs:read:all');
};

const shipmentBucket = (status) => {
    const s = String(status || '').trim().toLowerCase();
    if (!s) return 'unknown';
    if (s.includes('deliver') || s.includes('livrat')) return 'delivered';
    if (s.includes('return')) return 'returned';
    if (s.includes('cancel') || s.includes('anulat')) return 'cancelled';
    if (s.includes('refuz') || s.includes('refus')) return 'refused';
    return 'active';
};

const withDateFilters = (logs, params = {}) => {
    const startDate = params?.start_date;
    const endDate = params?.end_date;
    const awb = normalizeAwb(params?.awb);

    return (Array.isArray(logs) ? logs : []).filter((log) => {
        const ts = new Date(log?.timestamp);
        if (Number.isNaN(ts.getTime())) return false;
        if (awb && normalizeAwb(log?.awb) !== awb) return false;
        if (startDate && ts < new Date(startDate)) return false;
        if (endDate && ts > new Date(endDate)) return false;
        return true;
    });
};

const updateShipmentFromEvent = (shipments, awb, eventId, timestamp, localityName) => {
    const identifier = normalizeAwb(awb);
    if (!identifier) return shipments;

    const statusText = EVENT_TO_STATUS[eventId] || 'Updated';
    const eventDescription = EVENT_LABELS[eventId] || `Status ${eventId}`;

    const list = Array.isArray(shipments) ? shipments.slice() : [];
    const idx = list.findIndex((s) => normalizeAwb(s?.awb) === identifier);

    const nextEvent = {
        eventDescription,
        eventDate: timestamp,
        localityName: localityName || 'Demo City'
    };

    if (idx === -1) {
        list.unshift({
            awb: identifier,
            recipient_name: 'Demo Recipient',
            delivery_address: 'Demo Address',
            weight: 1,
            status: statusText,
            tracking_history: [nextEvent]
        });
        return list;
    }

    const prev = list[idx];
    const tracking = Array.isArray(prev?.tracking_history) ? prev.tracking_history : [];
    list[idx] = {
        ...prev,
        status: statusText,
        awb_status_date: timestamp,
        last_updated: new Date().toISOString(),
        tracking_history: [nextEvent, ...tracking]
    };

    return list;
};

export async function demoLogin(username, password) {
    const u = String(username || '').trim();
    const p = String(password || '');

    if (!u || !p) {
        throw apiError('Username and password are required.');
    }

    if (p !== 'demo' && p !== 'admin') {
        throw apiError('Demo mode: use password "demo".');
    }

    const users = getUsersStore();
    const found = users.find((x) => String(x?.username || '').toLowerCase() === u.toLowerCase());

    const role = String(found?.role || '').trim() || roleForUsername(u);
    let driver_id = String(found?.driver_id || '').trim();
    // Keep demo UX simple: the login screen advertises "demo / demo", so unknown usernames
    // should still land on a populated account with example shipments.
    if (!driver_id) {
        if (role === 'Admin') driver_id = 'D001';
        else if (role === 'Manager') driver_id = 'D003';
        else driver_id = 'D002';
    }

    const payload = {
        sub: u,
        driver_id,
        role,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    };

    return {
        access_token: buildDemoToken(payload),
        token_type: 'bearer',
        role
    };
}

export async function demoGetMe(token) {
    const payload = decodeJwtPayload(token) || {};
    const username = String(payload.sub || '').trim() || 'demo';
    const role = String(payload.role || '').trim() || roleForUsername(username);
    const driver_id = String(payload.driver_id || '').trim() || 'D002';

    const users = getUsersStore();
    const found = users.find((x) => String(x?.driver_id || '').trim() === driver_id) || null;

    const fallbackTruck = role === 'Driver'
        ? { truck_plate: 'B-123-DEMO', truck_phone: '+40 700 000 000', helper_name: 'Helper Demo' }
        : { truck_plate: null, truck_phone: null, helper_name: null };

    return {
        driver_id,
        name: found?.name || username,
        username,
        role,
        active: found ? Boolean(found.active) : true,
        truck_plate: found?.truck_plate || fallbackTruck.truck_plate,
        truck_phone: found?.truck_phone || fallbackTruck.truck_phone,
        helper_name: found?.helper_name || fallbackTruck.helper_name,
        last_login: found?.last_login || null,
        permissions: permissionsForRole(role)
    };
}

export async function demoGetRoles() {
    return (Array.isArray(VALID_ROLES) ? VALID_ROLES : []).map((role) => ({
        role,
        description: null,
        permissions: permissionsForRole(role),
        aliases: []
    }));
}

export async function demoListUsers() {
    return getUsersStore().slice().sort((a, b) => String(a?.driver_id || '').localeCompare(String(b?.driver_id || '')));
}

export async function demoCreateUser(payload) {
    const driver_id = String(payload?.driver_id || '').trim();
    const name = String(payload?.name || '').trim();
    const username = String(payload?.username || '').trim();
    const role = String(payload?.role || '').trim() || 'Driver';
    const active = payload?.active !== false;

    if (!driver_id || !name || !username) {
        throw apiError('driver_id, name and username are required.');
    }

    const users = getUsersStore();
    if (users.some((u) => String(u?.driver_id || '').toUpperCase() === driver_id.toUpperCase())) {
        throw apiError('driver_id already exists');
    }
    if (users.some((u) => String(u?.username || '').toLowerCase() === username.toLowerCase())) {
        throw apiError('username already exists');
    }

    const nextId = users.reduce((acc, u) => Math.max(acc, Number(u?.id || 0)), 0) + 1;
    const created = {
        id: nextId,
        driver_id,
        name,
        username,
        role,
        active,
        last_login: null,
        truck_plate: null,
        truck_phone: null,
        helper_name: null
    };

    users.push(created);
    setUsersStore(users);
    return created;
}

export async function demoUpdateUser(driverId, patch) {
    const identifier = String(driverId || '').trim();
    if (!identifier) {
        throw apiError('driver_id is required.');
    }

    const users = getUsersStore();
    const idx = users.findIndex((u) => String(u?.driver_id || '').toUpperCase() === identifier.toUpperCase());
    if (idx === -1) {
        throw apiError('User not found.');
    }

    const next = { ...users[idx] };

    if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) next.name = patch.name;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'username')) next.username = patch.username;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'role')) next.role = patch.role;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'active')) next.active = patch.active;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'last_login')) next.last_login = patch.last_login;

    users[idx] = next;
    setUsersStore(users);
    return next;
}

export async function demoSyncDrivers() {
    return { status: 'synced' };
}

export async function demoGetStatusOptions() {
    return STATUS_OPTIONS;
}

export async function demoUpdateAwb(request) {
    const awb = normalizeAwb(request?.awb);
    const eventId = String(request?.event_id || '').trim();

    if (!awb || !eventId) {
        throw apiError('AWB and event_id are required.');
    }

    const { payload } = currentAuth();
    const driver_id = String(payload?.driver_id || '').trim() || 'D002';

    const timestamp = request?.timestamp || new Date().toISOString();

    const shipments = getShipmentsStore();
    const updatedShipments = updateShipmentFromEvent(
        shipments,
        awb,
        eventId,
        timestamp,
        request?.payload?.locality
    );
    setShipmentsStore(updatedShipments);

    const logs = getLogsStore();
    logs.push({
        id: makeId('log'),
        driver_id,
        awb,
        event_id: eventId,
        timestamp,
        outcome: 'SUCCESS',
        error_message: null,
        postis_reference: makeId('DEMO')
    });
    setLogsStore(logs);

    return {
        status: 'ok',
        outcome: 'SUCCESS',
        reference: makeId('DEMO')
    };
}

export async function demoGetLogs(params = {}) {
    const { payload } = currentAuth();
    const role = String(payload?.role || '').trim() || 'Driver';
    const driver_id = String(payload?.driver_id || '').trim() || 'D002';

    const canAll = isRoleAllowedAllLogs(role);
    const logs = getLogsStore();

    const filtered = withDateFilters(
        canAll ? logs : logs.filter((l) => String(l?.driver_id || '') === driver_id),
        params
    );

    let limitN = Number(params?.limit) || 100;
    limitN = Math.max(1, Math.min(limitN, 2000));

    return filtered
        .slice()
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, limitN);
}

export async function demoGetShipments() {
    const { payload } = currentAuth();
    const role = String(payload?.role || '').trim() || 'Driver';
    const driver_id = String(payload?.driver_id || '').trim() || 'D002';

    const list = getShipmentsStore().slice().sort((a, b) => String(a?.awb || '').localeCompare(String(b?.awb || '')));
    if (String(role) === 'Driver') {
        const mine = list.filter((s) => String(s?.driver_id || '') === driver_id);
        return mine.length > 0 ? mine : list;
    } else if (String(role) === 'Recipient') {
        const phoneNorm = normalizePhone(payload?.sub || '');
        if (!phoneNorm) return [];
        return list.filter((s) => normalizePhone(s?.recipient_phone) === phoneNorm);
    }

    return list;
}

export async function demoGetShipment(awb) {
    const identifier = normalizeAwb(awb);
    if (!identifier) {
        throw apiError('AWB is required.');
    }

    const shipments = getShipmentsStore();
    const found = shipments.find((item) => normalizeAwb(item?.awb) === identifier);
    if (!found) {
        throw apiError('Shipment not found.');
    }
    return found;
}

export async function demoRecipientSignup(payload) {
    const awb = normalizeAwb(payload?.awb);
    const phoneNorm = normalizePhone(payload?.phone);
    const name = String(payload?.name || '').trim();

    if (!awb) throw apiError('AWB is required.');
    if (!phoneNorm) throw apiError('Phone is required.');
    if (!String(payload?.password || '').trim()) throw apiError('Password is required.');

    const shipments = getShipmentsStore();
    const ship = shipments.find((s) => normalizeAwb(s?.awb) === awb) || null;
    if (!ship) throw apiError('Shipment not found.');

    if (normalizePhone(ship?.recipient_phone) !== phoneNorm) {
        throw apiError('Phone number does not match the shipment recipient.');
    }

    const users = getUsersStore();
    const existing = users.find((u) => String(u?.username || '') === phoneNorm) || null;
    if (existing && String(existing?.role || '') !== 'Recipient') {
        throw apiError('An account already exists for this username.');
    }

    let user = existing;
    if (!user) {
        const nextId = users.reduce((acc, u) => Math.max(acc, Number(u?.id || 0)), 0) + 1;
        user = {
            id: nextId,
            driver_id: `R${phoneNorm}`,
            name: name || ship?.recipient_name || 'Recipient',
            username: phoneNorm,
            role: 'Recipient',
            active: true,
            last_login: new Date().toISOString(),
            truck_plate: null,
            truck_phone: null,
            helper_name: null,
            phone_number: payload?.phone || ship?.recipient_phone || null,
            phone_norm: phoneNorm
        };
        users.push(user);
        setUsersStore(users);
    } else {
        user.role = 'Recipient';
        user.active = true;
        user.last_login = new Date().toISOString();
        user.phone_number = user.phone_number || payload?.phone || ship?.recipient_phone || null;
        user.phone_norm = phoneNorm;
        if (name) user.name = name;
        setUsersStore(users);
    }

    const tokenPayload = {
        sub: phoneNorm,
        driver_id: user.driver_id,
        role: 'Recipient',
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    };

    return {
        access_token: buildDemoToken(tokenPayload),
        token_type: 'bearer',
        role: 'Recipient'
    };
}

export async function demoGetNotifications({ limit = 50, unread_only = false } = {}) {
    const { payload } = currentAuth();
    const driver_id = String(payload?.driver_id || '').trim();
    if (!driver_id) return [];

    let limitN = Number(limit) || 50;
    limitN = Math.max(1, Math.min(limitN, 200));

    const list = getNotificationsStore().filter((n) => String(n?.user_id || '') === driver_id);
    const filtered = unread_only
        ? list.filter((n) => !n?.read_at)
        : list;

    return filtered
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limitN);
}

export async function demoMarkNotificationRead(notificationId) {
    const idStr = String(notificationId);
    const items = getNotificationsStore();
    const idx = items.findIndex((n) => String(n?.id) === idStr);
    if (idx < 0) throw apiError('Notification not found.');

    items[idx] = { ...items[idx], read_at: items[idx].read_at || new Date().toISOString() };
    setNotificationsStore(items);
    return items[idx];
}

export async function demoAllocateShipment({ awb, driver_id } = {}) {
    const identifier = normalizeAwb(awb);
    const target = String(driver_id || '').trim().toUpperCase();
    if (!identifier) throw apiError('AWB is required.');
    if (!target) throw apiError('driver_id is required.');

    const shipments = getShipmentsStore();
    const idx = shipments.findIndex((s) => normalizeAwb(s?.awb) === identifier);
    if (idx < 0) throw apiError('Shipment not found.');

    const prev = shipments[idx];
    shipments[idx] = { ...prev, driver_id: target, last_updated: new Date().toISOString() };
    setShipmentsStore(shipments);

    const phoneNorm = normalizePhone(prev?.recipient_phone);
    let recipientUser = null;
    let tempPassword = null;

    if (phoneNorm) {
        const users = getUsersStore();
        recipientUser = users.find((u) => String(u?.role || '') === 'Recipient' && String(u?.phone_norm || '') === phoneNorm) || null;
        if (!recipientUser) {
            const nextId = users.reduce((acc, u) => Math.max(acc, Number(u?.id || 0)), 0) + 1;
            tempPassword = `${Math.floor(100000 + Math.random() * 900000)}`;
            recipientUser = {
                id: nextId,
                driver_id: `R${phoneNorm}`,
                name: prev?.recipient_name || 'Recipient',
                username: phoneNorm,
                role: 'Recipient',
                active: true,
                last_login: null,
                truck_plate: null,
                truck_phone: null,
                helper_name: null,
                phone_number: prev?.recipient_phone || null,
                phone_norm: phoneNorm
            };
            users.push(recipientUser);
            setUsersStore(users);
        }

        // In-app notification
        const items = getNotificationsStore();
        const nextNid = items.reduce((acc, n) => Math.max(acc, Number(n?.id || 0)), 0) + 1;
        items.push({
            id: nextNid,
            user_id: recipientUser.driver_id,
            created_at: new Date().toISOString(),
            read_at: null,
            title: 'Delivery allocated',
            body: `AWB ${identifier} was allocated to truck/driver ${target}.`,
            awb: identifier,
            data: { awb: identifier, driver_id: target }
        });
        setNotificationsStore(items);
    }

    return {
        status: 'ok',
        awb: identifier,
        previous_driver_id: prev?.driver_id || null,
        allocated_driver_id: target,
        recipient_user_id: recipientUser?.driver_id || null,
        recipient_username: recipientUser?.username || null,
        recipient_temp_password: tempPassword
    };
}

export async function demoGetStats() {
    const { payload } = currentAuth();
    const driver_id = String(payload?.driver_id || '').trim() || 'D002';
    const username = String(payload?.sub || '').trim() || 'demo';

    const logs = getLogsStore().filter((l) => String(l?.driver_id || '') === driver_id);
    const successLogs = logs.filter((l) => String(l?.outcome || '').toUpperCase() === 'SUCCESS');

    const todayStamp = new Date().toDateString();
    const todayCount = successLogs.filter((log) => new Date(log.timestamp).toDateString() === todayStamp).length;

    const found = getUsersStore().find((x) => String(x?.driver_id || '').trim() === driver_id) || null;

    return {
        today_count: todayCount,
        total_count: successLogs.length,
        driver_name: found?.name || username,
        last_sync: new Date().toISOString()
    };
}

export async function demoGetAnalytics({ scope = 'self', awb_limit = 200 } = {}) {
    const { payload } = currentAuth();
    const role = String(payload?.role || '').trim() || 'Driver';
    const driver_id = String(payload?.driver_id || '').trim() || 'D002';

    const scopeNorm = String(scope || 'self').trim().toLowerCase() === 'all' && isRoleAllowedAllLogs(role)
        ? 'all'
        : 'self';

    let awbLimitN = Number(awb_limit) || 200;
    awbLimitN = Math.max(10, Math.min(awbLimitN, 2000));

    const users = getUsersStore();
    const shipments = getShipmentsStore();
    const logs = getLogsStore();

    const driversInScope = scopeNorm === 'all'
        ? users.filter((u) => u && u.driver_id)
        : users.filter((u) => String(u?.driver_id || '') === driver_id);

    const driverStats = {};
    driversInScope.forEach((u) => {
        driverStats[u.driver_id] = {
            driver_id: u.driver_id,
            name: u.name,
            username: u.username,
            role: u.role,
            active: Boolean(u.active),
            last_login: u.last_login || null,
            truck_plate: u.truck_plate || null,
            truck_phone: u.truck_phone || null,
            helper_name: u.helper_name || null,
            updates_total: 0,
            updates_success: 0,
            updates_failed: 0,
            last_update: null,
            shipments_total: 0,
            shipments_by_status: {},
            shipments_by_bucket: {
                active: 0,
                delivered: 0,
                returned: 0,
                cancelled: 0,
                refused: 0,
                unknown: 0
            }
        };
    });

    const awbStats = {};
    const totals = {
        shipments_total: 0,
        updates_total: 0,
        updates_success: 0,
        updates_failed: 0,
        unique_awbs: 0
    };

    shipments.forEach((s) => {
        const awb = normalizeAwb(s?.awb);
        if (!awb) return;
        const did = String(s?.driver_id || '').trim() || null;
        const status = String(s?.status || '').trim() || 'Unknown';
        const bucket = shipmentBucket(status);

        if (scopeNorm === 'self' && did && did !== driver_id) return;

        totals.shipments_total += 1;

        awbStats[awb] = awbStats[awb] || {
            awb,
            status,
            driver_id: did,
            updates_total: 0,
            updates_success: 0,
            updates_failed: 0,
            last_update: null,
            last_event_id: null,
            last_outcome: null
        };
        awbStats[awb].status = status;
        if (did && !awbStats[awb].driver_id) awbStats[awb].driver_id = did;

        const ds = did && driverStats[did];
        if (ds) {
            ds.shipments_total += 1;
            ds.shipments_by_status[status] = (ds.shipments_by_status[status] || 0) + 1;
            ds.shipments_by_bucket[bucket] = (ds.shipments_by_bucket[bucket] || 0) + 1;
        }
    });

    const eventMap = {};
    logs.forEach((l) => {
        const did = String(l?.driver_id || '').trim() || null;
        if (scopeNorm === 'self' && did && did !== driver_id) return;

        const awb = normalizeAwb(l?.awb);
        const eid = String(l?.event_id || '').trim() || 'Unknown';
        const out = String(l?.outcome || '').toUpperCase() || 'UNKNOWN';
        const ts = String(l?.timestamp || '').trim() || null;

        totals.updates_total += 1;
        if (out === 'SUCCESS') totals.updates_success += 1;
        else totals.updates_failed += 1;

        const ds = did && driverStats[did];
        if (ds) {
            ds.updates_total += 1;
            if (out === 'SUCCESS') ds.updates_success += 1;
            else ds.updates_failed += 1;
            if (ts && (!ds.last_update || new Date(ts) > new Date(ds.last_update))) ds.last_update = ts;
        }

        if (awb) {
            awbStats[awb] = awbStats[awb] || {
                awb,
                status: null,
                driver_id: did,
                updates_total: 0,
                updates_success: 0,
                updates_failed: 0,
                last_update: null,
                last_event_id: null,
                last_outcome: null
            };
            awbStats[awb].updates_total += 1;
            if (out === 'SUCCESS') awbStats[awb].updates_success += 1;
            else awbStats[awb].updates_failed += 1;
            if (ts && (!awbStats[awb].last_update || new Date(ts) > new Date(awbStats[awb].last_update))) {
                awbStats[awb].last_update = ts;
                awbStats[awb].last_event_id = eid;
                awbStats[awb].last_outcome = out;
            }
        }

        eventMap[eid] = eventMap[eid] || {
            event_id: eid,
            label: EVENT_LABELS[eid] || null,
            description: EVENT_LABELS[eid] || null,
            total: 0,
            success: 0,
            failed: 0
        };
        eventMap[eid].total += 1;
        if (out === 'SUCCESS') eventMap[eid].success += 1;
        else eventMap[eid].failed += 1;
    });

    const driversOut = Object.values(driverStats)
        .map((d) => ({ ...d }))
        .sort((a, b) => String(a?.driver_id || '').localeCompare(String(b?.driver_id || '')));

    const trucksMap = {};
    driversOut.forEach((d) => {
        const plateKey = String(d?.truck_plate || '').trim().toUpperCase() || 'UNASSIGNED';
        trucksMap[plateKey] = trucksMap[plateKey] || {
            truck_plate: plateKey === 'UNASSIGNED' ? null : plateKey,
            truck_phone: d?.truck_phone || null,
            drivers: [],
            shipments_total: 0,
            shipments_by_bucket: {
                active: 0,
                delivered: 0,
                returned: 0,
                cancelled: 0,
                refused: 0,
                unknown: 0
            },
            updates_total: 0,
            updates_success: 0,
            updates_failed: 0,
            last_update: null
        };

        const t = trucksMap[plateKey];
        t.drivers.push({ driver_id: d.driver_id, name: d.name, role: d.role });
        t.shipments_total += Number(d.shipments_total || 0);
        Object.keys(t.shipments_by_bucket).forEach((k) => {
            t.shipments_by_bucket[k] += Number(d?.shipments_by_bucket?.[k] || 0);
        });
        t.updates_total += Number(d.updates_total || 0);
        t.updates_success += Number(d.updates_success || 0);
        t.updates_failed += Number(d.updates_failed || 0);
        if (!t.last_update || (d.last_update && new Date(d.last_update) > new Date(t.last_update))) {
            t.last_update = d.last_update || t.last_update;
        }
    });

    const awbsOut = Object.values(awbStats)
        .map((a) => ({ ...a }))
        .sort((a, b) => String(b?.last_update || '').localeCompare(String(a?.last_update || '')))
        .slice(0, awbLimitN);

    const eventsOut = Object.values(eventMap)
        .map((e) => ({ ...e }))
        .sort((a, b) => String(a?.event_id || '').localeCompare(String(b?.event_id || '')));

    totals.unique_awbs = Object.keys(awbStats).length;

    return {
        generated_at: new Date().toISOString(),
        scope: scopeNorm,
        role,
        drivers: driversOut,
        trucks: Object.values(trucksMap).sort((a, b) => String(a?.truck_plate || '').localeCompare(String(b?.truck_plate || ''))),
        awbs: awbsOut,
        events: eventsOut,
        totals
    };
}
