import { normalizeRole, ROLE_ADMIN, ROLE_DRIVER, ROLE_RECIPIENT, VALID_ROLES, permissionsForRole } from '../auth/permissions';

// Demo mode is meant for showcasing the app without connecting to live APIs
// or exposing real operational data. Everything below is localStorage-backed.

const DEMO_LOGS_KEY = 'arynik_demo_logs_v1';
const DEMO_SHIPMENTS_KEY = 'arynik_demo_shipments_v1';
const DEMO_USERS_KEY = 'arynik_demo_users_v1';
const DEMO_NOTIFICATIONS_KEY = 'arynik_demo_notifications_v1';
const DEMO_TRACKING_REQUESTS_KEY = 'arynik_demo_tracking_requests_v1';
const DEMO_DRIVER_LOCATIONS_KEY = 'arynik_demo_driver_locations_v1';
const DEMO_CHAT_THREADS_KEY = 'arynik_demo_chat_threads_v1';
const DEMO_CHAT_MESSAGES_KEY = 'arynik_demo_chat_messages_v1';
const DEMO_ADMIN_NOTES_KEY = 'arynik_demo_admin_notes_v1';
const DEMO_PROVIDER_SECRETS_KEY = 'arynik_demo_provider_secrets_v1';
const DEMO_MAPS_PROVIDER_KEY = 'arynik_demo_maps_provider_v1';
const DEMO_WAREHOUSES_KEY = 'arynik_demo_warehouses_v1';
const DEMO_STORES_KEY = 'arynik_demo_stores_v1';
const DEMO_CARRIERS_KEY = 'arynik_demo_carriers_v1';

let demoPostisSyncState = {
    running: false,
    running_since: null,
    last_trigger: null,
    last_error: null,
    last_stats: null,
};

const STATUS_OPTIONS = [
    { event_id: '1', label: 'Expediere preluata de Curier', description: 'Expediere preluata de Curier' },
    { event_id: '2', label: 'Expeditie Livrata', description: 'Expeditie Livrata' },
    { event_id: '3', label: 'Refuzare colet', description: 'Refuzare colet' },
    { event_id: '4', label: 'Expeditie returnata', description: 'Expeditie returnata' },
    { event_id: '5', label: 'Expeditie anulata', description: 'Expeditie anulata' },
    { event_id: '6', label: 'Intrare in depozit', description: 'Intrare in depozit' },
    { event_id: '7', label: 'Livrare reprogramata', description: 'Livrare reprogramata' }
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
    '7': 'Rescheduled'
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

const maskSecret = (value) => {
    const text = String(value || '').trim();
    if (!text) return null;
    if (text.length <= 8) return '*'.repeat(text.length);
    return `${text.slice(0, 4)}...${text.slice(-4)}`;
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
    },
    {
        id: 10,
        driver_id: 'SFLBC001',
        name: 'Flanco Bacau Supernova',
        username: 'flanco.bacau.supernova',
        role: 'Store',
        active: true,
        last_login: null,
        truck_plate: null,
        truck_phone: null,
        helper_name: null,
        warehouse_id: 1,
        store_id: 1
    },
    {
        id: 11,
        driver_id: 'SFLIS001',
        name: 'Flanco Iasi Nicolina',
        username: 'flanco.iasi.nicolina',
        role: 'Store',
        active: true,
        last_login: null,
        truck_plate: null,
        truck_phone: null,
        helper_name: null,
        warehouse_id: 2,
        store_id: 2
    },
    {
        id: 12,
        driver_id: 'SFLSV001',
        name: 'Flanco Suceava Carrefour',
        username: 'flanco.suceava.carrefour',
        role: 'Store',
        active: true,
        last_login: null,
        truck_plate: null,
        truck_phone: null,
        helper_name: null,
        warehouse_id: 3,
        store_id: 3
    }
]);

const initialWarehouses = () => ([
    {
        id: 1,
        code: 'WH-BACAU',
        name: 'Depozit Bacau',
        address: 'Bacau, Romania',
        latitude: 46.5667,
        longitude: 26.9167,
        active: true,
        created_at: hoursAgoIso(200),
        updated_at: hoursAgoIso(2),
    },
    {
        id: 2,
        code: 'WH-IASI',
        name: 'Depozit Iasi',
        address: 'Iasi, Romania',
        latitude: 47.1585,
        longitude: 27.6014,
        active: true,
        created_at: hoursAgoIso(200),
        updated_at: hoursAgoIso(2),
    },
    {
        id: 3,
        code: 'WH-SUCEAVA',
        name: 'Depozit Suceava',
        address: 'Suceava, Romania',
        latitude: 47.6514,
        longitude: 26.2556,
        active: true,
        created_at: hoursAgoIso(200),
        updated_at: hoursAgoIso(2),
    },
]);

const initialStores = () => ([
    {
        id: 1,
        code: 'FLN-BC-SUPERNOVA',
        name: 'Flanco Smart Discounter Bacau Supernova',
        warehouse_id: 1,
        warehouse_name: 'Depozit Bacau',
        address: 'Calea Republicii 181, Bacau',
        latitude: 46.5710,
        longitude: 26.9200,
        active: true,
        created_at: hoursAgoIso(150),
        updated_at: hoursAgoIso(2),
    },
    {
        id: 2,
        code: 'FLN-IS-KA-NICOLINA',
        name: 'Flanco Iasi Kaufland Nicolina',
        warehouse_id: 2,
        warehouse_name: 'Depozit Iasi',
        address: 'Soseaua Nicolina 57, Iasi',
        latitude: 47.1383,
        longitude: 27.5928,
        active: true,
        created_at: hoursAgoIso(150),
        updated_at: hoursAgoIso(2),
    },
    {
        id: 3,
        code: 'FLN-SV-CARREFOUR',
        name: 'Flanco Suceava Carrefour',
        warehouse_id: 3,
        warehouse_name: 'Depozit Suceava',
        address: 'Calea Unirii 27B, Suceava',
        latitude: 47.6488,
        longitude: 26.2525,
        active: true,
        created_at: hoursAgoIso(150),
        updated_at: hoursAgoIso(2),
    },
]);

const initialCarriers = () => ([
    {
        id: 1,
        code: 'ARYNIK_DIRECT',
        name: 'Arynik Direct Fleet',
        integration_mode: 'arynik_direct',
        base_fee: 10,
        cost_per_km: 1.55,
        cost_per_kg: 0.35,
        cod_fee_percent: 0.5,
        avg_speed_kmph: 52,
        base_eta_hours: 10,
        service_radius_km: 220,
        priority_bonus: 0.08,
        active: true,
        notes: 'Operare proprie Arynik',
        created_at: hoursAgoIso(320),
        updated_at: hoursAgoIso(2),
    },
    {
        id: 2,
        code: 'POSTIS_NETWORK',
        name: 'Postis Network',
        integration_mode: 'postis_allocated',
        base_fee: 13.5,
        cost_per_km: 1.85,
        cost_per_kg: 0.42,
        cod_fee_percent: 0.9,
        avg_speed_kmph: 45,
        base_eta_hours: 14,
        service_radius_km: null,
        priority_bonus: 0.04,
        active: true,
        notes: 'Acoperire nationala prin agregator',
        created_at: hoursAgoIso(320),
        updated_at: hoursAgoIso(2),
    },
    {
        id: 3,
        code: 'REGIONAL_FLANCO',
        name: 'Regional Flanco Partner',
        integration_mode: 'partner_api',
        base_fee: 9,
        cost_per_km: 1.3,
        cost_per_kg: 0.3,
        cod_fee_percent: 0.6,
        avg_speed_kmph: 41,
        base_eta_hours: 11,
        service_radius_km: 140,
        priority_bonus: 0.02,
        active: true,
        notes: 'Partener regional',
        created_at: hoursAgoIso(320),
        updated_at: hoursAgoIso(2),
    },
]);

const initialNotifications = () => ([]);

const FLANCO_STORE_ACCOUNT_SPECS = [
    {
        driver_id: 'SFLBC001',
        name: 'Flanco Bacau Supernova',
        username: 'flanco.bacau.supernova',
        warehouse_code: 'WH-BACAU',
        store_code: 'FLN-BC-SUPERNOVA',
    },
    {
        driver_id: 'SFLIS001',
        name: 'Flanco Iasi Nicolina',
        username: 'flanco.iasi.nicolina',
        warehouse_code: 'WH-IASI',
        store_code: 'FLN-IS-KA-NICOLINA',
    },
    {
        driver_id: 'SFLSV001',
        name: 'Flanco Suceava Carrefour',
        username: 'flanco.suceava.carrefour',
        warehouse_code: 'WH-SUCEAVA',
        store_code: 'FLN-SV-CARREFOUR',
    },
];

const upsertByCode = (rows, desired) => {
    const list = Array.isArray(rows) ? rows.slice() : [];
    let changed = false;
    (Array.isArray(desired) ? desired : []).forEach((entry) => {
        const code = String(entry?.code || '').trim().toUpperCase();
        if (!code) return;
        const idx = list.findIndex((row) => String(row?.code || '').trim().toUpperCase() === code);
        if (idx >= 0) {
            const next = {
                ...list[idx],
                ...entry,
                id: list[idx]?.id ?? entry?.id,
            };
            if (JSON.stringify(next) !== JSON.stringify(list[idx])) {
                list[idx] = next;
                changed = true;
            }
        } else {
            list.push({ ...entry });
            changed = true;
        }
    });
    return { rows: list, changed };
};

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
    const list = Array.isArray(users) ? users.slice() : initialUsers();
    const stores = getStoresStore();
    const warehouses = getWarehousesStore();
    const storeByCode = new Map((Array.isArray(stores) ? stores : []).map((s) => [String(s?.code || '').trim().toUpperCase(), s]));
    const warehouseByCode = new Map((Array.isArray(warehouses) ? warehouses : []).map((w) => [String(w?.code || '').trim().toUpperCase(), w]));

    let changed = false;
    FLANCO_STORE_ACCOUNT_SPECS.forEach((spec) => {
        const store = storeByCode.get(String(spec.store_code || '').trim().toUpperCase()) || null;
        const wh = warehouseByCode.get(String(spec.warehouse_code || '').trim().toUpperCase()) || null;
        const idx = list.findIndex((u) => String(u?.username || '').trim().toLowerCase() === String(spec.username || '').trim().toLowerCase());
        const nextPayload = {
            driver_id: String(spec.driver_id || '').trim().toUpperCase(),
            name: String(spec.name || '').trim(),
            username: String(spec.username || '').trim().toLowerCase(),
            role: 'Store',
            active: true,
            truck_plate: null,
            truck_phone: null,
            helper_name: null,
            warehouse_id: Number(wh?.id || store?.warehouse_id || 0) || null,
            store_id: Number(store?.id || 0) || null,
        };
        if (idx < 0) {
            const nextId = list.reduce((acc, u) => Math.max(acc, Number(u?.id || 0)), 0) + 1;
            list.push({
                id: nextId,
                last_login: null,
                ...nextPayload,
            });
            changed = true;
            return;
        }
        const prev = list[idx] || {};
        const fallbackId = Number(spec?.id || 0) || (idx + 1);
        const next = {
            ...prev,
            ...nextPayload,
            id: prev?.id ?? fallbackId,
        };
        if (JSON.stringify(next) !== JSON.stringify(prev)) {
            list[idx] = next;
            changed = true;
        }
    });

    if (changed) setUsersStore(list);
    return list;
};

const setUsersStore = (users) => saveJson(DEMO_USERS_KEY, Array.isArray(users) ? users : []);

const getWarehousesStore = () => {
    const rows = loadJson(DEMO_WAREHOUSES_KEY, initialWarehouses);
    const current = Array.isArray(rows) ? rows : initialWarehouses();
    const seeded = upsertByCode(current, initialWarehouses());
    if (seeded.changed) saveJson(DEMO_WAREHOUSES_KEY, seeded.rows);
    return seeded.rows;
};

const getStoresStore = () => {
    const rows = loadJson(DEMO_STORES_KEY, initialStores);
    const current = Array.isArray(rows) ? rows : initialStores();
    const warehouses = getWarehousesStore();
    const warehouseNameById = new Map((Array.isArray(warehouses) ? warehouses : []).map((w) => [Number(w?.id || 0), String(w?.name || '').trim()]));
    const desired = initialStores().map((s) => ({
        ...s,
        warehouse_name: warehouseNameById.get(Number(s?.warehouse_id || 0)) || s?.warehouse_name || null,
    }));
    const seeded = upsertByCode(current, desired);
    if (seeded.changed) saveJson(DEMO_STORES_KEY, seeded.rows);
    return seeded.rows;
};

const getCarriersStore = () => {
    const rows = loadJson(DEMO_CARRIERS_KEY, initialCarriers);
    return Array.isArray(rows) ? rows : initialCarriers();
};

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

const getChatThreadsStore = () => {
    const items = loadJson(DEMO_CHAT_THREADS_KEY, () => []);
    return Array.isArray(items) ? items : [];
};

const setChatThreadsStore = (items) => saveJson(DEMO_CHAT_THREADS_KEY, Array.isArray(items) ? items : []);

const getChatMessagesStore = () => {
    const items = loadJson(DEMO_CHAT_MESSAGES_KEY, () => ({}));
    return items && typeof items === 'object' ? items : {};
};

const setChatMessagesStore = (items) => saveJson(DEMO_CHAT_MESSAGES_KEY, items && typeof items === 'object' ? items : {});

const getAdminNotesStore = () => {
    const items = loadJson(DEMO_ADMIN_NOTES_KEY, () => ([]));
    return Array.isArray(items) ? items : [];
};

const setAdminNotesStore = (items) => saveJson(DEMO_ADMIN_NOTES_KEY, Array.isArray(items) ? items : []);

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
    const warehouses = getWarehousesStore();
    const stores = getStoresStore();
    const wid = Number(found?.warehouse_id || 0) || null;
    const sid = Number(found?.store_id || 0) || null;
    const wh = wid ? warehouses.find((w) => Number(w?.id || 0) === wid) : null;
    const st = sid ? stores.find((s) => Number(s?.id || 0) === sid) : null;

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
        warehouse_id: wid,
        warehouse_name: String(wh?.name || '').trim() || null,
        store_id: sid,
        store_name: String(st?.name || '').trim() || null,
        last_login: found?.last_login || null,
        permissions: permissionsForRole(role)
    };
}

export async function demoSyncMyDevicePhone({ phone_number, source = null } = {}) {
    const { payload } = currentAuth();
    const role = normalizeRole(payload?.role);
    if (role !== ROLE_DRIVER) throw apiError('Only drivers can sync device phone.');

    const driverId = String(payload?.driver_id || '').trim().toUpperCase();
    if (!driverId) throw apiError('driver_id is missing from session.');

    const phoneNorm = normalizePhone(phone_number);
    if (!phoneNorm) throw apiError('Invalid phone number.');
    const phoneE164 = `+${phoneNorm}`;

    const users = getUsersStore();
    const idx = users.findIndex((u) => String(u?.driver_id || '').trim().toUpperCase() === driverId);
    if (idx < 0) throw apiError('User not found.');

    const prev = users[idx] || {};
    const updated = String(prev?.truck_phone || '').trim() !== phoneE164 || String(prev?.phone_norm || '').trim() !== phoneNorm;

    users[idx] = {
        ...prev,
        truck_phone: phoneE164,
        phone_number: phoneE164,
        phone_norm: phoneNorm,
    };
    setUsersStore(users);

    return {
        driver_id: driverId,
        truck_phone: phoneE164,
        phone_norm: phoneNorm,
        updated: Boolean(updated),
        source: String(source || '').trim() || null,
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

export async function demoListWarehouses() {
    return getWarehousesStore().slice().sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
}

export async function demoListStores({ warehouse_id = null } = {}) {
    const rows = getStoresStore().slice();
    if (warehouse_id != null && warehouse_id !== '') {
        const wid = Number(warehouse_id);
        if (Number.isFinite(wid) && wid > 0) {
            return rows.filter((s) => Number(s?.warehouse_id || 0) === wid);
        }
    }
    return rows.sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
}

export async function demoListCarriers({ include_inactive = false } = {}) {
    const rows = getCarriersStore().slice();
    const filtered = include_inactive ? rows : rows.filter((c) => c?.active !== false);
    return filtered.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
}

export async function demoRecommendCarriers(payload = {}) {
    const priority = (() => {
        const p = String(payload?.priority || '').trim().toLowerCase();
        return ['balanced', 'cost', 'speed', 'distance'].includes(p) ? p : 'balanced';
    })();
    const weightsByPriority = {
        balanced: { cost: 0.4, speed: 0.35, distance: 0.25 },
        cost: { cost: 0.7, speed: 0.15, distance: 0.15 },
        speed: { cost: 0.15, speed: 0.7, distance: 0.15 },
        distance: { cost: 0.2, speed: 0.2, distance: 0.6 },
    };
    const weights = weightsByPriority[priority] || weightsByPriority.balanced;

    const carrierFilter = new Set(
        (Array.isArray(payload?.carrier_codes) ? payload.carrier_codes : [])
            .map((x) => String(x || '').trim().toUpperCase())
            .filter(Boolean)
    );
    const carriers = (await demoListCarriers({ include_inactive: false }))
        .filter((c) => carrierFilter.size === 0 || carrierFilter.has(String(c?.code || '').trim().toUpperCase()));
    if (!carriers.length) throw apiError('No active carriers configured');

    const toNum = (v, fallback = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    const warehouseId = Number(payload?.warehouse_id || 0) || null;
    const storeId = Number(payload?.store_id || 0) || null;
    const localityKey = String(payload?.locality || '').trim().toLowerCase();
    const countyKey = String(payload?.county || '').trim().toLowerCase();
    const warehouses = getWarehousesStore();
    const stores = getStoresStore();
    const store = stores.find((s) => Number(s?.id || 0) === storeId) || null;
    const warehouse = warehouses.find((w) => Number(w?.id || 0) === (store?.warehouse_id || warehouseId || 0)) || null;

    const originText = `${store?.name || ''} ${store?.address || ''} ${warehouse?.name || ''} ${warehouse?.address || ''}`.toLowerCase();
    let distanceKm = Math.max(0.3, toNum(payload?.distance_km, 0));
    if (!distanceKm) {
        if (localityKey && originText.includes(localityKey)) distanceKm = 8;
        else if (countyKey && originText.includes(countyKey)) distanceKm = 28;
        else if (localityKey) distanceKm = 42;
        else distanceKm = 25;
    }

    const weight = Math.max(0, toNum(payload?.weight, 0));
    const codAmount = Math.max(0, toNum(payload?.cod_amount, 0));

    const rows = carriers.map((carrier) => {
        const baseFee = Math.max(0, toNum(carrier?.base_fee, 0));
        const perKm = Math.max(0, toNum(carrier?.cost_per_km, 0));
        const perKg = Math.max(0, toNum(carrier?.cost_per_kg, 0));
        const codPct = Math.max(0, toNum(carrier?.cod_fee_percent, 0));
        const speed = Math.max(8, toNum(carrier?.avg_speed_kmph, 45));
        const etaBase = Math.max(0, toNum(carrier?.base_eta_hours, 12));
        const radius = toNum(carrier?.service_radius_km, 0);
        const bonus = toNum(carrier?.priority_bonus, 0);

        const estimatedCost = baseFee + (distanceKm * perKm) + (weight * perKg) + (codAmount * (codPct / 100));
        const estimatedEta = etaBase + (distanceKm / speed);
        let coverage = 1;
        if (radius > 0 && distanceKm > radius) {
            coverage = Math.max(0.05, 1 - ((distanceKm - radius) / Math.max(60, radius)));
        }
        return {
            carrier,
            estimatedCost,
            estimatedEta,
            coverage,
            bonus,
        };
    });

    const normalizeInverse = (values) => {
        const min = Math.min(...values);
        const max = Math.max(...values);
        if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) < 1e-9) {
            return values.map(() => 1);
        }
        return values.map((v) => Math.max(0, Math.min(1, (max - v) / (max - min))));
    };

    const costScores = normalizeInverse(rows.map((r) => r.estimatedCost));
    const speedScores = normalizeInverse(rows.map((r) => r.estimatedEta));
    const options = rows.map((r, index) => {
        const costScore = costScores[index];
        const speedScore = speedScores[index];
        const distanceScore = Math.max(0, Math.min(1, r.coverage));
        const totalScore = Math.max(0, Math.min(1,
            (weights.cost * costScore)
            + (weights.speed * speedScore)
            + (weights.distance * distanceScore)
            + r.bonus
        ));
        return {
            code: String(r.carrier?.code || '').trim().toUpperCase(),
            name: String(r.carrier?.name || '').trim(),
            integration_mode: String(r.carrier?.integration_mode || '').trim() || null,
            distance_km: Number(distanceKm.toFixed(2)),
            estimated_cost: Number(r.estimatedCost.toFixed(2)),
            estimated_eta_hours: Number(r.estimatedEta.toFixed(2)),
            coverage_score: Number(distanceScore.toFixed(4)),
            cost_score: Number(costScore.toFixed(4)),
            speed_score: Number(speedScore.toFixed(4)),
            distance_score: Number(distanceScore.toFixed(4)),
            total_score: Number(totalScore.toFixed(4)),
            recommended: false,
            reason: priority === 'cost'
                ? 'Best estimated cost for this order.'
                : (priority === 'speed'
                    ? 'Fastest estimated delivery time.'
                    : (priority === 'distance'
                        ? 'Best coverage for this delivery distance.'
                        : 'Best combined score (cost + speed + coverage).')),
        };
    });
    options.sort((a, b) => (
        Number(b?.total_score || 0) - Number(a?.total_score || 0)
        || Number(a?.estimated_eta_hours || 0) - Number(b?.estimated_eta_hours || 0)
        || Number(a?.estimated_cost || 0) - Number(b?.estimated_cost || 0)
        || String(a?.code || '').localeCompare(String(b?.code || ''))
    ));
    if (options.length) options[0].recommended = true;
    for (let i = 1; i < options.length; i += 1) {
        options[i].reason = 'Alternative option for this shipment.';
    }

    return {
        priority,
        origin_label: store?.name || warehouse?.name || null,
        distance_km: Number(distanceKm.toFixed(2)),
        recommended_code: options[0]?.code || null,
        options,
    };
}

export async function demoCreateWarehouse(payload = {}) {
    const code = String(payload?.code || '').trim().toUpperCase();
    const name = String(payload?.name || '').trim();
    if (!code) throw apiError('code is required');
    if (!name) throw apiError('name is required');

    const rows = getWarehousesStore();
    if (rows.some((w) => String(w?.code || '').trim().toUpperCase() === code)) {
        throw apiError('Warehouse code already exists');
    }
    const nextId = rows.reduce((acc, w) => Math.max(acc, Number(w?.id || 0)), 0) + 1;
    const nowIso = new Date().toISOString();
    const created = {
        id: nextId,
        code,
        name,
        address: String(payload?.address || '').trim() || null,
        latitude: Number(payload?.latitude),
        longitude: Number(payload?.longitude),
        active: payload?.active !== false,
        created_at: nowIso,
        updated_at: nowIso,
    };
    if (!Number.isFinite(created.latitude)) created.latitude = null;
    if (!Number.isFinite(created.longitude)) created.longitude = null;
    rows.push(created);
    saveJson(DEMO_WAREHOUSES_KEY, rows);
    return created;
}

export async function demoUpdateWarehouse(warehouseId, patch = {}) {
    const id = Number(warehouseId);
    if (!Number.isFinite(id) || id <= 0) throw apiError('warehouse_id is required');

    const rows = getWarehousesStore();
    const idx = rows.findIndex((w) => Number(w?.id || 0) === id);
    if (idx < 0) throw apiError('Warehouse not found');
    const next = { ...rows[idx] };
    if (Object.prototype.hasOwnProperty.call(patch, 'code')) next.code = String(patch?.code || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) next.name = String(patch?.name || '').trim();
    if (Object.prototype.hasOwnProperty.call(patch, 'address')) next.address = String(patch?.address || '').trim() || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'latitude')) {
        const v = Number(patch?.latitude);
        next.latitude = Number.isFinite(v) ? v : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'longitude')) {
        const v = Number(patch?.longitude);
        next.longitude = Number.isFinite(v) ? v : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'active')) next.active = patch?.active !== false;
    if (!String(next?.code || '').trim()) throw apiError('code is required');
    if (!String(next?.name || '').trim()) throw apiError('name is required');
    rows[idx] = { ...next, updated_at: new Date().toISOString() };
    saveJson(DEMO_WAREHOUSES_KEY, rows);
    return rows[idx];
}

export async function demoCreateStore(payload = {}) {
    const code = String(payload?.code || '').trim().toUpperCase();
    const name = String(payload?.name || '').trim();
    if (!code) throw apiError('code is required');
    if (!name) throw apiError('name is required');

    const stores = getStoresStore();
    if (stores.some((s) => String(s?.code || '').trim().toUpperCase() === code)) {
        throw apiError('Store code already exists');
    }
    const warehouses = getWarehousesStore();
    const warehouseId = Number(payload?.warehouse_id);
    let warehouseName = null;
    if (Number.isFinite(warehouseId) && warehouseId > 0) {
        const wh = warehouses.find((w) => Number(w?.id || 0) === warehouseId);
        if (!wh) throw apiError('warehouse_id not found');
        warehouseName = String(wh?.name || '').trim() || null;
    }
    const nextId = stores.reduce((acc, s) => Math.max(acc, Number(s?.id || 0)), 0) + 1;
    const nowIso = new Date().toISOString();
    const created = {
        id: nextId,
        code,
        name,
        warehouse_id: Number.isFinite(warehouseId) && warehouseId > 0 ? Math.trunc(warehouseId) : null,
        warehouse_name: warehouseName,
        address: String(payload?.address || '').trim() || null,
        latitude: Number(payload?.latitude),
        longitude: Number(payload?.longitude),
        active: payload?.active !== false,
        created_at: nowIso,
        updated_at: nowIso,
    };
    if (!Number.isFinite(created.latitude)) created.latitude = null;
    if (!Number.isFinite(created.longitude)) created.longitude = null;
    stores.push(created);
    saveJson(DEMO_STORES_KEY, stores);
    return created;
}

export async function demoUpdateStore(storeId, patch = {}) {
    const id = Number(storeId);
    if (!Number.isFinite(id) || id <= 0) throw apiError('store_id is required');

    const stores = getStoresStore();
    const idx = stores.findIndex((s) => Number(s?.id || 0) === id);
    if (idx < 0) throw apiError('Store not found');
    const next = { ...stores[idx] };

    if (Object.prototype.hasOwnProperty.call(patch, 'code')) next.code = String(patch?.code || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) next.name = String(patch?.name || '').trim();
    if (Object.prototype.hasOwnProperty.call(patch, 'address')) next.address = String(patch?.address || '').trim() || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'latitude')) {
        const v = Number(patch?.latitude);
        next.latitude = Number.isFinite(v) ? v : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'longitude')) {
        const v = Number(patch?.longitude);
        next.longitude = Number.isFinite(v) ? v : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'active')) next.active = patch?.active !== false;
    if (Object.prototype.hasOwnProperty.call(patch, 'warehouse_id')) {
        const warehouseId = Number(patch?.warehouse_id);
        if (!Number.isFinite(warehouseId) || warehouseId <= 0) {
            next.warehouse_id = null;
            next.warehouse_name = null;
        } else {
            const warehouses = getWarehousesStore();
            const wh = warehouses.find((w) => Number(w?.id || 0) === Math.trunc(warehouseId));
            if (!wh) throw apiError('warehouse_id not found');
            next.warehouse_id = Math.trunc(warehouseId);
            next.warehouse_name = String(wh?.name || '').trim() || null;
        }
    }

    if (!String(next?.code || '').trim()) throw apiError('code is required');
    if (!String(next?.name || '').trim()) throw apiError('name is required');
    stores[idx] = { ...next, updated_at: new Date().toISOString() };
    saveJson(DEMO_STORES_KEY, stores);
    return stores[idx];
}

export async function demoGetHealth() {
    return {
        ok: true,
        time: new Date().toISOString(),
        postis_base_url: 'https://shipments.postisgate.com',
        postis_configured: true,
    };
}

export async function demoListUsers() {
    return getUsersStore().slice().sort((a, b) => String(a?.driver_id || '').localeCompare(String(b?.driver_id || '')));
}

export async function demoSeedFlancoStoreAccounts({ reset_passwords = true } = {}) {
    const revealDefaultPassword = Boolean(reset_passwords);
    const users = getUsersStore();
    const out = [];
    const defaultPassword = 'FlancoStore123!';
    FLANCO_STORE_ACCOUNT_SPECS.forEach((spec) => {
        const found = users.find((u) => String(u?.username || '').trim().toLowerCase() === String(spec.username || '').trim().toLowerCase());
        if (!found) return;
        out.push({
            driver_id: String(found?.driver_id || spec.driver_id || '').trim().toUpperCase(),
            name: String(found?.name || spec.name || '').trim(),
            username: String(found?.username || spec.username || '').trim().toLowerCase(),
            password: revealDefaultPassword ? defaultPassword : 'unchanged',
            role: 'Store',
        });
    });
    return out;
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
        helper_name: null,
        warehouse_id: Number(payload?.warehouse_id || 0) || null,
        store_id: Number(payload?.store_id || 0) || null,
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
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'warehouse_id')) next.warehouse_id = Number(patch?.warehouse_id || 0) || null;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'store_id')) next.store_id = Number(patch?.store_id || 0) || null;

    users[idx] = next;
    setUsersStore(users);
    return next;
}

export async function demoDeleteUser(driverId) {
    const { payload } = currentAuth();
    const role = normalizeRole(payload?.role);
    if (role !== ROLE_ADMIN) throw apiError('Only admin users can delete accounts.');

    const identifier = String(driverId || '').trim();
    if (!identifier) throw apiError('driver_id is required.');

    const me = String(payload?.driver_id || '').trim().toUpperCase();
    if (me && me === identifier.toUpperCase()) {
        throw apiError('Cannot delete your own account.');
    }

    const users = getUsersStore();
    const idx = users.findIndex((u) => String(u?.driver_id || '').trim().toUpperCase() === identifier.toUpperCase());
    if (idx < 0) throw apiError('User not found.');

    const target = users[idx] || {};
    const targetRole = normalizeRole(target?.role);
    const targetActive = target?.active !== false;
    if (targetRole === ROLE_ADMIN && targetActive) {
        const activeAdmins = users.filter((u) => normalizeRole(u?.role) === ROLE_ADMIN && u?.active !== false).length;
        if (activeAdmins <= 1) throw apiError('Cannot delete the last active admin account.');
    }

    const previous_role = String(target?.role || '').trim() || null;
    const previous_username = String(target?.username || '').trim() || null;
    users.splice(idx, 1);
    setUsersStore(users);

    return {
        driver_id: identifier,
        hard_deleted: true,
        deactivated: false,
        previous_role,
        previous_username,
        message: 'User permanently deleted.'
    };
}

export async function demoSyncDrivers() {
    return { status: 'synced' };
}

export async function demoGetPostisSyncStatus() {
    return { ...demoPostisSyncState };
}

export async function demoTriggerPostisSync({ wait = false } = {}) {
    const started = !demoPostisSyncState.running;
    if (!started) {
        return { started: false, ...demoPostisSyncState };
    }

    const startedAt = new Date();
    demoPostisSyncState = {
        ...demoPostisSyncState,
        running: true,
        running_since: startedAt.toISOString(),
        last_trigger: 'manual',
        last_error: null,
        last_stats: null,
    };

    const finish = () => {
        const finishedAt = new Date();
        demoPostisSyncState = {
            ...demoPostisSyncState,
            running: false,
            running_since: null,
            last_trigger: 'manual',
            last_error: null,
            last_stats: {
                started_at: startedAt.toISOString(),
                finished_at: finishedAt.toISOString(),
                list_items: 120,
                unique_awbs: 120,
                new_awbs: 0,
                changed_awbs: 5,
                fetched_details: 5,
                upserted_list: 120,
                upserted_details: 5,
                fetch_errors: 0,
                upsert_errors_list: 0,
                upsert_errors_details: 0,
            },
        };
    };

    if (wait) {
        await new Promise((r) => setTimeout(r, 1200));
        finish();
        return { started: true, ...demoPostisSyncState };
    }

    setTimeout(finish, 1200);
    return { started: true, ...demoPostisSyncState };
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
    const normalizeStatus = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
    const isDriverPoolStatus = (status, processingStatus) => {
        const folded = normalizeStatus(status || processingStatus);
        if (!folded) return false;
        return (
            folded.includes('finalizare pregatire depozit')
            || folded.includes('initial')
            || folded.includes('pending')
            || folded.includes('in asteptare')
            || folded.includes('in transit')
            || folded.includes('expediere preluata de curier')
            || folded.includes('incarcat la curier')
            || folded.includes('intrare in depozit')
            || folded.includes('in depot')
            || folded.includes('livrare reprogramata')
            || folded.includes('reprogramat')
            || folded.includes('reschedule')
            || folded.includes('refuz')
            || folded.includes('refused')
        );
    };

    const list = getShipmentsStore().slice().sort((a, b) => String(a?.awb || '').localeCompare(String(b?.awb || '')));
    if (String(role) === 'Driver') {
        const me = String(driver_id || '').trim().toUpperCase();
        return list.filter((s) => {
            const sid = String(s?.driver_id || '').trim().toUpperCase();
            if (sid && sid === me) return true;
            if (sid) return false;
            return isDriverPoolStatus(s?.status, s?.processing_status);
        });
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

export async function demoGetNotifications({ limit = 50, unread_only = false, scope = 'mine' } = {}) {
    const { payload } = currentAuth();
    const driver_id = String(payload?.driver_id || '').trim();
    const role = normalizeRole(payload?.role);
    if (!driver_id) return [];

    let limitN = Number(limit) || 50;
    limitN = Math.max(1, Math.min(limitN, 200));

    const scopeNorm = String(scope || 'mine').trim().toLowerCase();
    const canCompanyScope = scopeNorm === 'company' && role !== ROLE_RECIPIENT && role !== ROLE_DRIVER;
    const list = canCompanyScope
        ? getNotificationsStore()
        : getNotificationsStore().filter((n) => String(n?.user_id || '') === driver_id);
    const filtered = unread_only
        ? list.filter((n) => !n?.read_at)
        : list;

    const users = getUsersStore();
    const byId = new Map(
        (Array.isArray(users) ? users : []).map((u) => [String(u?.driver_id || '').trim().toUpperCase(), u])
    );

    return filtered
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limitN)
        .map((n) => {
            if (!canCompanyScope) return n;
            const targetId = String(n?.user_id || '').trim().toUpperCase();
            const target = byId.get(targetId);
            const dataRaw = n?.data && typeof n.data === 'object' ? n.data : {};
            return {
                ...n,
                data: {
                    ...dataRaw,
                    target_user_id: targetId || null,
                    target_role: normalizeRole(target?.role || null) || null,
                    target_name: String(target?.name || target?.username || '').trim() || null,
                }
            };
        });
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

export async function demoListAdminNotes({ limit = 100 } = {}) {
    const { payload } = currentAuth();
    const role = String(payload?.role || '').trim();
    if (role !== 'Admin') throw apiError('Only admins can read improvement notes.');

    let limitN = Number(limit) || 100;
    limitN = Math.max(1, Math.min(limitN, 300));

    return getAdminNotesStore()
        .slice()
        .sort((a, b) => new Date(b?.created_at || 0) - new Date(a?.created_at || 0))
        .slice(0, limitN);
}

export async function demoCreateAdminNote({ text } = {}) {
    const { payload } = currentAuth();
    const role = String(payload?.role || '').trim();
    if (role !== 'Admin') throw apiError('Only admins can create improvement notes.');

    const content = String(text || '').trim();
    if (!content) throw apiError('text is required.');

    const uid = String(payload?.driver_id || '').trim().toUpperCase();
    const user = getUsersStore().find((u) => String(u?.driver_id || '').trim().toUpperCase() === uid);
    const note = {
        id: Date.now(),
        created_at: new Date().toISOString(),
        created_by_user_id: uid || 'D001',
        created_by_name: String(user?.name || user?.username || 'Admin'),
        text: content.slice(0, 4000),
    };
    const notes = getAdminNotesStore();
    notes.unshift(note);
    setAdminNotesStore(notes);
    return note;
}

export async function demoGetProviderSecretsStatus() {
    const { payload } = currentAuth();
    const role = normalizeRole(payload?.role);
    if (role !== 'Admin') throw apiError('Only admins can view provider secrets.');

    const data = loadJson(DEMO_PROVIDER_SECRETS_KEY, () => ({}));
    const openai = String(data?.OPENAI_API_KEY || '').trim();
    const eleven = String(data?.ELEVENLABS_API_KEY || '').trim();
    return {
        openai_api_key: { configured: Boolean(openai), masked: maskSecret(openai) },
        elevenlabs_api_key: { configured: Boolean(eleven), masked: maskSecret(eleven) },
    };
}

export async function demoUpdateProviderSecrets(payload = {}) {
    const { payload: authPayload } = currentAuth();
    const role = normalizeRole(authPayload?.role);
    if (role !== 'Admin') throw apiError('Only admins can update provider secrets.');

    const current = loadJson(DEMO_PROVIDER_SECRETS_KEY, () => ({}));
    const next = { ...current };

    if (payload && Object.prototype.hasOwnProperty.call(payload, 'openai_api_key')) {
        const raw = String(payload?.openai_api_key || '').trim();
        if (raw) next.OPENAI_API_KEY = raw;
        else delete next.OPENAI_API_KEY;
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'elevenlabs_api_key')) {
        const raw = String(payload?.elevenlabs_api_key || '').trim();
        if (raw) next.ELEVENLABS_API_KEY = raw;
        else delete next.ELEVENLABS_API_KEY;
    }

    saveJson(DEMO_PROVIDER_SECRETS_KEY, next);

    const openai = String(next?.OPENAI_API_KEY || '').trim();
    const eleven = String(next?.ELEVENLABS_API_KEY || '').trim();
    return {
        ok: true,
        saved_to_env: payload?.persist_to_env !== false,
        openai_api_key: { configured: Boolean(openai), masked: maskSecret(openai) },
        elevenlabs_api_key: { configured: Boolean(eleven), masked: maskSecret(eleven) },
    };
}

const loadMapsProviderDemo = () => loadJson(DEMO_MAPS_PROVIDER_KEY, () => ({
    maps_mode: 'platform',
    own_maps_api_key: '',
    platform_google_maps_api_key: '',
    platform_credit_balance: 0,
    platform_usage_requests: 0,
    platform_usage_cost: 0,
    recent_usage: [],
}));

const saveMapsProviderDemo = (value) => saveJson(DEMO_MAPS_PROVIDER_KEY, value || {});

const mapsProviderDemoResponse = (state) => {
    const current = state || loadMapsProviderDemo();
    const price1k = 35.0;
    const pricePerRequest = price1k / 1000.0;
    const balance = Number(current?.platform_credit_balance || 0) || 0;
    const remaining = pricePerRequest > 0 ? Math.max(0, Math.floor(balance / pricePerRequest)) : null;
    return {
        owner_user_id: String(currentAuth()?.payload?.driver_id || '').trim().toUpperCase() || null,
        maps_mode: String(current?.maps_mode || 'platform').trim().toLowerCase() === 'own' ? 'own' : 'platform',
        own_maps_api_key: {
            configured: Boolean(String(current?.own_maps_api_key || '').trim()),
            masked: maskSecret(current?.own_maps_api_key),
        },
        platform_google_maps_api_key: {
            configured: Boolean(String(current?.platform_google_maps_api_key || '').trim()),
            masked: maskSecret(current?.platform_google_maps_api_key),
        },
        pricing_per_1000: price1k,
        pricing_per_request: pricePerRequest,
        platform_credit_balance: balance,
        platform_usage_requests: Number(current?.platform_usage_requests || 0) || 0,
        platform_usage_cost: Number(current?.platform_usage_cost || 0) || 0,
        platform_remaining_estimated_requests: remaining,
        recent_usage: Array.isArray(current?.recent_usage)
            ? current.recent_usage.slice(0, 60)
            : [],
    };
};

export async function demoGetMapsProviderConfig() {
    const { payload } = currentAuth();
    const role = normalizeRole(payload?.role);
    if (role !== 'Admin') throw apiError('Only admins can view maps provider config.');
    const current = loadMapsProviderDemo();
    return mapsProviderDemoResponse(current);
}

export async function demoUpdateMapsProviderConfig(payload = {}) {
    const { payload: authPayload } = currentAuth();
    const role = normalizeRole(authPayload?.role);
    if (role !== 'Admin') throw apiError('Only admins can update maps provider config.');

    const current = loadMapsProviderDemo();
    const next = { ...current };

    if (payload && Object.prototype.hasOwnProperty.call(payload, 'maps_mode')) {
        const mode = String(payload?.maps_mode || '').trim().toLowerCase();
        next.maps_mode = mode === 'own' ? 'own' : 'platform';
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'own_maps_api_key')) {
        next.own_maps_api_key = String(payload?.own_maps_api_key || '').trim();
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'platform_google_maps_api_key')) {
        next.platform_google_maps_api_key = String(payload?.platform_google_maps_api_key || '').trim();
    }

    saveMapsProviderDemo(next);
    return mapsProviderDemoResponse(next);
}

export async function demoTopupMapsProviderCredit(payload = {}) {
    const { payload: authPayload } = currentAuth();
    const role = normalizeRole(authPayload?.role);
    if (role !== 'Admin') throw apiError('Only admins can top up maps provider credit.');

    const amount = Number(payload?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw apiError('amount must be greater than 0');

    const current = loadMapsProviderDemo();
    const next = { ...current };
    next.platform_credit_balance = (Number(next.platform_credit_balance || 0) || 0) + amount;
    const history = Array.isArray(next.recent_usage) ? next.recent_usage.slice() : [];
    history.unshift({
        created_at: new Date().toISOString(),
        action: 'credit_topup',
        mode: 'platform',
        requests_count: 0,
        estimated_cost: -amount,
    });
    next.recent_usage = history.slice(0, 120);
    saveMapsProviderDemo(next);

    return {
        ok: true,
        owner_user_id: String(authPayload?.driver_id || '').trim().toUpperCase() || null,
        amount_added: amount,
        platform_credit_balance: Number(next.platform_credit_balance || 0) || 0,
        platform_usage_requests: Number(next.platform_usage_requests || 0) || 0,
        platform_usage_cost: Number(next.platform_usage_cost || 0) || 0,
    };
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

export async function demoCreateManualShipment(payload = {}) {
    const { payload: authPayload } = currentAuth();
    const role = normalizeRole(authPayload?.role);
    if (!['Admin', 'Warehouse', 'Store'].includes(role)) {
        throw apiError('Only admin/warehouse/store can create manual AWBs.');
    }

    const awb = normalizeAwb(payload?.awb);
    const recipient_name = String(payload?.recipient_name || '').trim();
    const delivery_address = String(payload?.delivery_address || '').trim();
    const locality = String(payload?.locality || '').trim();
    if (!awb || awb.length < 6) throw apiError('awb is required (min 6 chars).');
    if (!recipient_name) throw apiError('recipient_name is required.');
    if (!delivery_address) throw apiError('delivery_address is required.');
    if (!locality) throw apiError('locality is required.');

    const shipments = getShipmentsStore();
    if (shipments.some((s) => normalizeAwb(s?.awb) === awb)) {
        throw apiError('Shipment already exists.');
    }

    const nowIso = new Date().toISOString();
    const cod_amount = Math.max(0, Number(payload?.cod_amount || 0) || 0);
    const weight = Math.max(0, Number(payload?.weight || 0) || 0);
    const number_of_parcels = Math.max(1, Number(payload?.number_of_parcels || 1) || 1);

    const selectedCarrierCode = String(payload?.carrier_code || '').trim().toUpperCase() || null;
    const carrierPriority = (() => {
        const p = String(payload?.carrier_priority || '').trim().toLowerCase();
        return ['balanced', 'cost', 'speed', 'distance'].includes(p) ? p : 'balanced';
    })();
    const carrierPlan = await demoRecommendCarriers({
        warehouse_id: payload?.warehouse_id,
        store_id: payload?.store_id,
        delivery_address,
        locality,
        county: payload?.county,
        distance_km: payload?.carrier_distance_km,
        destination_latitude: payload?.destination_latitude,
        destination_longitude: payload?.destination_longitude,
        weight,
        cod_amount,
        priority: carrierPriority,
        carrier_codes: selectedCarrierCode ? [selectedCarrierCode] : undefined,
    });
    let selectedCarrier = (Array.isArray(carrierPlan?.options) ? carrierPlan.options : []).find((x) => x?.recommended) || null;
    if (!selectedCarrier && Array.isArray(carrierPlan?.options) && carrierPlan.options.length) {
        selectedCarrier = carrierPlan.options[0];
    }
    const carrierCodeOut = String(selectedCarrier?.code || payload?.carrier_code || '').trim().toUpperCase() || null;
    const carrierNameOut = String(selectedCarrier?.name || payload?.carrier_name || '').trim() || null;
    const carrierCostOut = Number(payload?.carrier_estimated_cost);
    const carrierEtaOut = Number(payload?.carrier_estimated_eta_hours);
    const shippingCost = Number.isFinite(carrierCostOut)
        ? Math.max(0, carrierCostOut)
        : Math.max(0, Number(selectedCarrier?.estimated_cost || 0) || 0);
    const courierData = carrierCodeOut || carrierNameOut
        ? {
            courierId: carrierCodeOut,
            courierName: carrierNameOut,
            carrierId: carrierCodeOut,
            carrierName: carrierNameOut,
            carrierCode: carrierCodeOut,
            integrationMode: String(selectedCarrier?.integration_mode || '').trim() || null,
            selectionMethod: selectedCarrierCode ? 'manual' : 'auto',
            selectionPriority: carrierPriority,
            distanceKm: Number(selectedCarrier?.distance_km || payload?.carrier_distance_km || 0) || null,
            estimatedCost: Number.isFinite(shippingCost) ? Number(shippingCost.toFixed(2)) : null,
            estimatedEtaHours: Number.isFinite(carrierEtaOut)
                ? Number(Math.max(0, carrierEtaOut).toFixed(2))
                : (Number(selectedCarrier?.estimated_eta_hours || 0) || null),
            score: Number(selectedCarrier?.total_score || 0) || null,
        }
        : null;

    const shipment = {
        awb,
        status: String(payload?.status || 'Intrare in depozit').trim() || 'Intrare in depozit',
        recipient_name,
        recipient_phone: String(payload?.recipient_phone || '').trim() || null,
        recipient_email: String(payload?.recipient_email || '').trim() || null,
        delivery_address,
        locality,
        cod_amount,
        weight,
        volumetric_weight: Math.max(0, Number(payload?.volumetric_weight || 0) || 0),
        dimensions: String(payload?.dimensions || '').trim() || null,
        content_description: String(payload?.content_description || '').trim() || 'General parcel',
        declared_value: Math.max(0, Number(payload?.declared_value || 0) || 0),
        number_of_parcels,
        currency: 'RON',
        shipping_cost: Number.isFinite(shippingCost) ? Number(shippingCost.toFixed(2)) : null,
        estimated_shipping_cost: Number.isFinite(shippingCost) ? Number(shippingCost.toFixed(2)) : null,
        source_channel: 'ARYNIK_LOCAL',
        send_type: 'Manual',
        processing_status: 'Manual entry',
        local_awb_shipment: true,
        local_shipment: true,
        shipment_label_available: true,
        warehouse_id: Number(payload?.warehouse_id || 0) || null,
        store_id: Number(payload?.store_id || 0) || null,
        created_date: nowIso,
        awb_status_date: nowIso,
        last_updated: nowIso,
        tracking_history: [
            {
                eventDescription: 'AWB created manually in Arynik',
                eventDate: nowIso,
                localityName: locality,
            },
        ],
        raw_data: {
            source: 'arynik_manual',
            labelProvider: 'arynik_local',
            createdAt: nowIso,
            createdByUserId: String(authPayload?.driver_id || '').trim() || null,
            carrierSelectionPriority: carrierPriority,
            carrierRecommendation: carrierPlan,
            courier: courierData,
        },
    };
    shipments.unshift(shipment);
    setShipmentsStore(shipments);
    return shipment;
}

export async function demoConfirmShipmentReturn(awb, payload = {}) {
    const key = normalizeAwb(awb);
    if (!key) throw apiError('awb is required.');
    const shipments = getShipmentsStore();
    const idx = shipments.findIndex((s) => normalizeAwb(s?.awb) === key);
    if (idx < 0) throw apiError('Shipment not found.');

    const nowIso = new Date().toISOString();
    const { payload: authPayload } = currentAuth();
    const byId = String(authPayload?.driver_id || '').trim() || 'DEMO';
    const note = String(payload?.notes || '').trim();

    const next = {
        ...shipments[idx],
        return_confirmed_at: nowIso,
        return_confirmed_by: byId,
        last_updated: nowIso,
    };
    const history = Array.isArray(next?.tracking_history) ? next.tracking_history.slice() : [];
    history.unshift({
        eventDescription: note ? `Return confirmed: ${note}` : 'Return confirmed at store/warehouse',
        eventDate: nowIso,
        localityName: String(next?.locality || ''),
    });
    next.tracking_history = history;

    shipments[idx] = next;
    setShipmentsStore(shipments);
    return next;
}

export async function demoGetStats() {
    const { payload } = currentAuth();
    const driver_id = String(payload?.driver_id || '').trim() || 'D002';
    const username = String(payload?.sub || '').trim() || 'demo';

    const logs = getLogsStore().filter((l) => String(l?.driver_id || '') === driver_id);
    const deliveredLogs = logs.filter((l) => (
        String(l?.outcome || '').toUpperCase() === 'SUCCESS'
        && String(l?.event_id || '') === '2'
        && normalizeAwb(l?.awb)
    ));

    const todayStamp = new Date().toDateString();
    const todaySet = new Set(
        deliveredLogs
            .filter((log) => new Date(log.timestamp).toDateString() === todayStamp)
            .map((log) => normalizeAwb(log.awb))
            .filter(Boolean)
    );
    const totalSet = new Set(
        deliveredLogs
            .map((log) => normalizeAwb(log.awb))
            .filter(Boolean)
    );

    const found = getUsersStore().find((x) => String(x?.driver_id || '').trim() === driver_id) || null;

    return {
        today_count: todaySet.size,
        total_count: totalSet.size,
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

const getTrackingRequestsStore = () => loadJson(DEMO_TRACKING_REQUESTS_KEY, () => []);
const saveTrackingRequestsStore = (value) => saveJson(DEMO_TRACKING_REQUESTS_KEY, value);

const getDriverLocationsStore = () => loadJson(DEMO_DRIVER_LOCATIONS_KEY, () => ({}));
const saveDriverLocationsStore = (value) => saveJson(DEMO_DRIVER_LOCATIONS_KEY, value);

export async function demoUpdateLocation(payload = {}) {
    const { payload: authPayload } = currentAuth();
    const driverId = String(authPayload?.driver_id || '').trim() || 'D002';
    const lat = Number(payload?.latitude);
    const lon = Number(payload?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw apiError('Invalid location');
    }

    const store = getDriverLocationsStore();
    store[driverId] = { driver_id: driverId, latitude: lat, longitude: lon, timestamp: new Date().toISOString() };
    saveDriverLocationsStore(store);
    return { status: 'updated', timestamp: store[driverId].timestamp };
}

export async function demoCreateTrackingRequest(payload = {}) {
    const { payload: authPayload } = currentAuth();
    const requesterId = String(authPayload?.driver_id || '').trim() || 'D001';
    const requesterRole = String(authPayload?.role || '').trim() || 'Admin';

    const durationSec = Math.max(60, Math.min(Number(payload?.duration_sec) || 900, 6 * 60 * 60));
    const awb = payload?.awb ? normalizeAwb(payload.awb) : null;
    const driverIdIn = payload?.driver_id ? String(payload.driver_id).trim().toUpperCase() : null;

    if ((awb && driverIdIn) || (!awb && !driverIdIn)) {
        throw apiError('Provide only one: awb or driver_id');
    }

    let targetDriverId = driverIdIn;
    if (awb) {
        const shipments = getShipmentsStore();
        const ship = shipments.find((s) => normalizeAwb(s?.awb) === awb) || null;
        if (!ship) throw apiError('Shipment not found');
        targetDriverId = String(ship?.driver_id || '').trim().toUpperCase() || null;
        if (!targetDriverId) throw apiError('Shipment has no driver allocated yet');
    }

    const id = Date.now();
    const now = new Date();
    const req = {
        id,
        created_at: now.toISOString(),
        created_by_user_id: requesterId,
        created_by_role: requesterRole,
        target_driver_id: targetDriverId,
        awb,
        status: 'Pending',
        duration_sec: durationSec,
        expires_at: new Date(now.getTime() + durationSec * 1000).toISOString(),
        accepted_at: null,
        denied_at: null,
        stopped_at: null,
        last_location_at: null
    };

    const store = getTrackingRequestsStore();
    store.unshift(req);
    saveTrackingRequestsStore(store.slice(0, 500));
    return req;
}

export async function demoListTrackingInbox({ limit = 20 } = {}) {
    const { payload: authPayload } = currentAuth();
    const driverId = String(authPayload?.driver_id || '').trim() || 'D002';

    const limitN = Math.max(1, Math.min(Number(limit) || 20, 100));
    const store = getTrackingRequestsStore();
    const now = new Date();
    return store
        .filter((r) => String(r?.target_driver_id || '') === driverId)
        .filter((r) => String(r?.status || '') === 'Pending')
        .filter((r) => r?.expires_at && new Date(r.expires_at) > now)
        .slice(0, limitN);
}

export async function demoListTrackingActive({ limit = 10 } = {}) {
    const { payload: authPayload } = currentAuth();
    const driverId = String(authPayload?.driver_id || '').trim() || 'D002';

    const limitN = Math.max(1, Math.min(Number(limit) || 10, 50));
    const store = getTrackingRequestsStore();
    const now = new Date();
    return store
        .filter((r) => String(r?.target_driver_id || '') === driverId)
        .filter((r) => String(r?.status || '') === 'Accepted')
        .filter((r) => !r?.stopped_at)
        .filter((r) => r?.expires_at && new Date(r.expires_at) > now)
        .slice(0, limitN);
}

const demoCurrentUser = () => {
    const { payload: authPayload } = currentAuth();
    return {
        role: String(authPayload?.role || '').trim(),
        driverId: String(authPayload?.driver_id || '').trim(),
    };
};

export async function demoAcceptTrackingRequest(requestId) {
    const store = getTrackingRequestsStore();
    const idx = store.findIndex((r) => Number(r?.id) === Number(requestId));
    if (idx === -1) throw apiError('Tracking request not found');

    const durationSec = Math.max(60, Math.min(Number(store[idx]?.duration_sec) || 900, 6 * 60 * 60));
    const now = new Date();
    store[idx] = {
        ...store[idx],
        status: 'Accepted',
        accepted_at: now.toISOString(),
        expires_at: new Date(now.getTime() + durationSec * 1000).toISOString(),
        denied_at: null,
        stopped_at: null
    };
    saveTrackingRequestsStore(store);
    return store[idx];
}

export async function demoDenyTrackingRequest(requestId) {
    const store = getTrackingRequestsStore();
    const idx = store.findIndex((r) => Number(r?.id) === Number(requestId));
    if (idx === -1) throw apiError('Tracking request not found');

    const req = store[idx];
    const me = demoCurrentUser();
    if (String(me.role) === 'Driver' && me.driverId && String(req?.target_driver_id || '') === me.driverId) {
        throw apiError('Drivers cannot deny location tracking');
    }

    const now = new Date();
    store[idx] = { ...req, status: 'Denied', denied_at: now.toISOString() };
    saveTrackingRequestsStore(store);
    return store[idx];
}

export async function demoStopTrackingRequest(requestId) {
    const store = getTrackingRequestsStore();
    const idx = store.findIndex((r) => Number(r?.id) === Number(requestId));
    if (idx === -1) throw apiError('Tracking request not found');

    const req = store[idx];
    const me = demoCurrentUser();
    if (String(me.role) === 'Driver' && me.driverId && String(req?.target_driver_id || '') === me.driverId) {
        throw apiError('Drivers cannot stop location tracking');
    }

    const now = new Date();
    store[idx] = { ...req, status: 'Stopped', stopped_at: now.toISOString() };
    saveTrackingRequestsStore(store);
    return store[idx];
}

export async function demoGetTrackingRequest(requestId) {
    const store = getTrackingRequestsStore();
    const req = store.find((r) => Number(r?.id) === Number(requestId)) || null;
    if (!req) throw apiError('Tracking request not found');
    return req;
}

export async function demoGetTrackingLatest(requestId) {
    const req = await demoGetTrackingRequest(requestId);
    if (String(req?.status || '') !== 'Accepted') throw apiError('Tracking is not active');
    if (req?.expires_at && new Date(req.expires_at) <= new Date()) throw apiError('Tracking is not active');
    if (req?.stopped_at) throw apiError('Tracking is not active');

    const store = getDriverLocationsStore();
    const loc = store[String(req?.target_driver_id || '')] || null;
    if (!loc) throw apiError('No location yet');
    return { request_id: req.id, driver_id: req.target_driver_id, latitude: loc.latitude, longitude: loc.longitude, timestamp: loc.timestamp };
}

// [NEW] In-app Chat (Demo)
export async function demoListChatThreads({ limit = 50, awb = null } = {}) {
    const { payload: authPayload } = currentAuth();
    const uid = (String(authPayload?.driver_id || '').trim().toUpperCase()) || 'D002';

    const limitN = Math.max(1, Math.min(Number(limit) || 50, 200));
    const awbKey = awb ? normalizeAwb(awb) : null;

    const threads = getChatThreadsStore()
        .filter((t) => (awbKey ? normalizeAwb(t?.awb) === awbKey : true))
        .filter((t) => Array.isArray(t?.participants) && t.participants.includes(uid))
        .sort((a, b) => new Date(b?.last_message_at || b?.created_at || 0) - new Date(a?.last_message_at || a?.created_at || 0))
        .slice(0, limitN);

    return threads.map((t) => {
        const readBy = t?.read_by && typeof t.read_by === 'object' ? t.read_by : {};
        const lastRead = Number(readBy[uid] || 0);
        const msgs = (getChatMessagesStore()[String(t.id)] || []);
        const unread = (Array.isArray(msgs) ? msgs : []).filter((m) => Number(m?.id) > lastRead && String(m?.sender_user_id || '') !== uid).length;
        return { ...t, unread_count: unread };
    });
}

export async function demoEnsureChatThread({ awb } = {}) {
    const { payload: authPayload } = currentAuth();
    const uid = String(authPayload?.driver_id || '').trim() || 'D002';

    const key = normalizeAwb(awb);
    if (!key) throw apiError('awb is required');

    const threads = getChatThreadsStore();
    let thread = threads.find((t) => normalizeAwb(t?.awb) === key) || null;
    if (!thread) {
        thread = {
            id: Date.now(),
            created_at: new Date().toISOString(),
            awb: key,
            subject: `AWB ${key}`,
            last_message_at: null,
            last_message_preview: '',
            participants: [uid],
            read_by: { [uid]: 0 }
        };
        threads.unshift(thread);
    } else {
        if (!Array.isArray(thread.participants)) thread.participants = [];
        if (!thread.participants.includes(uid)) thread.participants.push(uid);
        if (!thread.read_by || typeof thread.read_by !== 'object') thread.read_by = {};
        if (thread.read_by[uid] === undefined) thread.read_by[uid] = 0;
    }

    setChatThreadsStore(threads);
    return { ...thread, unread_count: 0 };
}

export async function demoGetChatThread(threadId) {
    const id = Number(threadId);
    if (!Number.isFinite(id)) throw apiError('thread_id is required');

    const { payload: authPayload } = currentAuth();
    const uid = String(authPayload?.driver_id || '').trim() || 'D002';

    const threads = getChatThreadsStore();
    const thread = threads.find((t) => Number(t?.id) === id) || null;
    if (!thread) throw apiError('Thread not found');

    const readBy = thread?.read_by && typeof thread.read_by === 'object' ? thread.read_by : {};
    const lastRead = Number(readBy[uid] || 0);
    const msgs = (getChatMessagesStore()[String(thread.id)] || []);
    const unread = (Array.isArray(msgs) ? msgs : []).filter((m) => Number(m?.id) > lastRead && String(m?.sender_user_id || '') !== uid).length;

    return { ...thread, unread_count: unread };
}

export async function demoListChatMessages(threadId, { limit = 50, before_id = null } = {}) {
    const id = Number(threadId);
    if (!Number.isFinite(id)) throw apiError('thread_id is required');

    const store = getChatMessagesStore();
    const list = Array.isArray(store[String(id)]) ? store[String(id)] : [];
    const limitN = Math.max(1, Math.min(Number(limit) || 50, 200));
    const beforeId = before_id !== null ? Number(before_id) : null;

    const users = getUsersStore();
    const nameById = new Map(
        (Array.isArray(users) ? users : []).map((u) => [String(u?.driver_id || '').trim().toUpperCase(), String(u?.name || u?.username || '').trim()])
    );

    const filtered = list
        .filter((m) => (beforeId ? Number(m?.id) < beforeId : true))
        .sort((a, b) => Number(a?.id) - Number(b?.id));

    return filtered
        .slice(Math.max(0, filtered.length - limitN))
        .map((m) => {
            const senderId = String(m?.sender_user_id || '').trim().toUpperCase();
            return {
                ...m,
                sender_user_id: senderId,
                sender_name: nameById.get(senderId) || null,
            };
        });
}

export async function demoSendChatMessage(threadId, payload) {
    const id = Number(threadId);
    if (!Number.isFinite(id)) throw apiError('thread_id is required');

    const { payload: authPayload } = currentAuth();
    const uid = String(authPayload?.driver_id || '').trim() || 'D002';
    const role = String(authPayload?.role || 'Driver');

    const mtype = String(payload?.message_type || 'text').trim().toLowerCase();
    const text = payload?.text ? String(payload.text) : null;
    const data = payload?.data ?? null;

    if (mtype === 'text' && !String(text || '').trim()) throw apiError('text is required');
    if (mtype === 'location' && (!data || typeof data !== 'object')) throw apiError('data is required for location');

    const now = new Date().toISOString();
    const msgId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const message = {
        id: msgId,
        thread_id: id,
        created_at: now,
        sender_user_id: uid,
        sender_role: role,
        sender_name: String(getUsersStore().find((u) => String(u?.driver_id || '').trim().toUpperCase() === uid)?.name || ''),
        message_type: mtype,
        text: text,
        data: data
    };

    const store = getChatMessagesStore();
    const list = Array.isArray(store[String(id)]) ? store[String(id)].slice() : [];
    list.push(message);
    store[String(id)] = list;
    setChatMessagesStore(store);

    const threads = getChatThreadsStore();
    const idx = threads.findIndex((t) => Number(t?.id) === id);
    if (idx !== -1) {
        threads[idx] = {
            ...threads[idx],
            last_message_at: now,
            last_message_preview: mtype === 'location' ? 'Location pin' : (String(text || '').slice(0, 200))
        };
        setChatThreadsStore(threads);
    }

    return message;
}

export async function demoMarkChatRead(threadId, { last_read_message_id = null } = {}) {
    const id = Number(threadId);
    if (!Number.isFinite(id)) throw apiError('thread_id is required');

    const { payload: authPayload } = currentAuth();
    const uid = String(authPayload?.driver_id || '').trim() || 'D002';

    const store = getChatMessagesStore();
    const list = Array.isArray(store[String(id)]) ? store[String(id)] : [];
    const maxId = list.length ? Math.max(...list.map((m) => Number(m?.id) || 0)) : 0;
    const lastId = last_read_message_id !== null ? Number(last_read_message_id) : maxId;

    const threads = getChatThreadsStore();
    const idx = threads.findIndex((t) => Number(t?.id) === id);
    if (idx !== -1) {
        const readBy = threads[idx]?.read_by && typeof threads[idx].read_by === 'object' ? threads[idx].read_by : {};
        threads[idx] = { ...threads[idx], read_by: { ...readBy, [uid]: lastId } };
        setChatThreadsStore(threads);
    }

    return { ok: true, thread_id: id, last_read_message_id: lastId };
}

export async function demoAskVirtualAssistant(payload = {}) {
    const { payload: authPayload } = currentAuth();
    const role = normalizeRole(authPayload?.role || 'Viewer');
    const question = String(payload?.question || '').trim();
    if (!question) throw apiError('question is required');

    const awbExplicit = normalizeAwb(payload?.awb);
    const candidates = [];
    const addCandidate = (value) => {
        const key = normalizeAwb(value);
        if (!key || key.length < 6) return;
        if (!candidates.includes(key)) candidates.push(key);
    };

    if (awbExplicit) addCandidate(awbExplicit);
    String(question).match(/[A-Za-z0-9]{6,28}/g)?.forEach((token) => {
        if (/\d/.test(token)) addCandidate(token);
    });

    const byAwb = new Map(
        (getShipmentsStore() || [])
            .map((s) => [normalizeAwb(s?.awb), s])
            .filter(([key]) => Boolean(key))
    );
    const contextRows = [];
    candidates.forEach((candidate) => {
        const ship = byAwb.get(candidate);
        if (!ship) return;
        contextRows.push({
            awb: candidate,
            status: String(ship?.status || '').trim() || 'Necunoscut',
            locality: String(ship?.locality || '').trim() || null,
            cod_amount: Number(ship?.cod_amount || 0) || 0,
        });
    });

    const suggestions = role === ROLE_RECIPIENT
        ? ['Unde este coletul meu?', 'Pot reprograma livrarea?', 'Cum contactez soferul?']
        : role === ROLE_DRIVER
            ? ['Ce am de livrat urmatorul?', 'Cum marchez reprogramare?', 'Cum trimit locatia mea?']
            : ['Cum verific statusul unui AWB?', 'Cum aloc o livrare?', 'Cum verific COD-ul de incasat?'];

    let answer = '';
    if (contextRows.length > 0) {
        const lines = contextRows.slice(0, 3).map((row) => {
            const cod = Number(row.cod_amount || 0);
            const codText = cod > 0 ? `, COD ${cod.toFixed(2)} RON` : '';
            const locText = row.locality ? `, ${row.locality}` : '';
            return `- ${row.awb}: ${row.status}${locText}${codText}`;
        });
        answer = `Am gasit AWB in context:\n${lines.join('\n')}\n\nSpune-mi ce actiune vrei sa faci mai departe si te ghidez pas cu pas.`;
    } else if (/awb|status|livrare|colet|ruta|cod|chat|notific/i.test(question)) {
        answer = 'Pot sa te ajut cu status AWB, rute, notificari, chat si COD. Daca imi dai un AWB, iti ofer pasi exacti.';
    } else {
        answer = 'Sunt asistentul virtual Arynik. Te ajut cu intrebari operationale despre aplicatie, livrari si utilizare pe rolul tau.';
    }

    return {
        answer,
        suggestions,
        provider: 'demo_local',
        model: null,
        context_awbs: contextRows.map((row) => row.awb),
    };
}

// ---------------------------------------------------------------------------
// New business features (demo-mode stubs)
// ---------------------------------------------------------------------------

const CONTACTS_KEY = 'arynik_demo_contacts_v1';
const MANIFESTS_KEY = 'arynik_demo_manifests_v1';
const ROUTE_RUNS_KEY = 'arynik_demo_route_runs_v1';

const getJson = (key, fallback) => {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
    } catch {
        return fallback;
    }
};

const setJson = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { }
};

export async function demoGetNdrReasons() {
    return {
        reasons: [
            { code: 'NO_ANSWER', label: 'No answer', kind: 'contact' },
            { code: 'PHONE_OFF', label: 'Phone off / unreachable', kind: 'contact' },
            { code: 'WRONG_NUMBER', label: 'Wrong number', kind: 'contact' },
            { code: 'ADDRESS_NOT_FOUND', label: 'Address not found', kind: 'address' },
            { code: 'RECIPIENT_NOT_HOME', label: 'Recipient not home', kind: 'availability' },
            { code: 'RECIPIENT_REFUSED', label: 'Recipient refused', kind: 'refusal' },
            { code: 'NO_CASH', label: 'No cash / cannot pay', kind: 'payment' },
            { code: 'DAMAGED', label: 'Damaged package', kind: 'package' },
            { code: 'OTHER', label: 'Other', kind: 'other' },
        ],
        actions: [
            { code: 'RETURN_TO_SENDER', label: 'Return to sender', kind: 'return' },
            { code: 'REDIRECT_TO_FLANCO', label: 'Redirect to Flanco store', kind: 'redirect' },
            { code: 'REDIRECT_TO_NEW_RECIPIENT', label: 'Redirect to new recipient', kind: 'redirect' },
            { code: 'RESCHEDULE_DELIVERY', label: 'Reschedule delivery', kind: 'reschedule' },
        ],
        flanco_destinations: [
            {
                id: 'flanco-bacau-supernova',
                location_id: 'DEMO-FLANCO-1',
                name: 'Flanco Smart Discounter Bacau Supernova',
                shop_name: 'flanco smart discounter bacau supernova',
                locality: 'Bacau',
                county: 'Bacau',
                address: 'Calea Republicii 181, Bacau',
                phone: '+40374477100',
                source_count: 12,
            },
            {
                id: 'flanco-iasi-kaufland-nicolina',
                location_id: 'DEMO-FLANCO-2',
                name: 'Flanco Iasi Kaufland Nicolina',
                shop_name: 'flanco iasi kaufland nicolina',
                locality: 'Iasi',
                county: 'Iasi',
                address: 'Soseaua Nicolina 57, Iasi',
                phone: '+40374477100',
                source_count: 8,
            },
            {
                id: 'flanco-suceava-carrefour',
                location_id: 'DEMO-FLANCO-3',
                name: 'Flanco Suceava Carrefour',
                shop_name: 'flanco suceava carrefour',
                locality: 'Suceava',
                county: 'Suceava',
                address: 'Calea Unirii 27B, Suceava',
                phone: '+40374477100',
                source_count: 7,
            }
        ],
    };
}

export async function demoCreateContactAttempt(payload) {
    const { payload: authPayload } = currentAuth();
    const uid = String(authPayload?.driver_id || '').trim() || 'D002';
    const role = String(authPayload?.role || '').trim() || 'Driver';

    const list = getJson(CONTACTS_KEY, []);
    const id = Date.now();
    const item = {
        id,
        created_at: new Date().toISOString(),
        created_by_user_id: uid,
        created_by_role: role,
        awb: payload?.awb ? String(payload.awb).toUpperCase() : null,
        channel: String(payload?.channel || 'call'),
        to_phone: payload?.to_phone ? String(payload.to_phone) : null,
        outcome: payload?.outcome ? String(payload.outcome) : null,
        notes: payload?.notes ? String(payload.notes) : null,
        data: payload?.data ?? null,
    };
    list.unshift(item);
    setJson(CONTACTS_KEY, list.slice(0, 1000));
    return item;
}

export async function demoCreateManifest(payload) {
    const { payload: authPayload } = currentAuth();
    const uid = String(authPayload?.driver_id || '').trim() || 'D002';
    const role = String(authPayload?.role || '').trim() || 'Driver';

    const store = getJson(MANIFESTS_KEY, []);
    const id = Date.now();
    const m = {
        id,
        created_at: new Date().toISOString(),
        created_by_user_id: uid,
        created_by_role: role,
        truck_plate: payload?.truck_plate ? String(payload.truck_plate).toUpperCase() : null,
        date: payload?.date ? String(payload.date) : null,
        kind: String(payload?.kind || 'loadout'),
        status: 'Open',
        notes: payload?.notes ? String(payload.notes) : null,
        items: [],
    };
    store.unshift(m);
    setJson(MANIFESTS_KEY, store.slice(0, 200));
    return m;
}

export async function demoListManifests({ limit = 50 } = {}) {
    const store = getJson(MANIFESTS_KEY, []);
    return store.slice(0, Math.max(1, Math.min(200, Number(limit || 50))));
}

export async function demoGetManifest(manifestId) {
    const id = Number(manifestId);
    const store = getJson(MANIFESTS_KEY, []);
    const m = store.find((x) => Number(x?.id) === id);
    if (!m) throw apiError('Manifest not found', 404);
    return m;
}

export async function demoScanManifest(manifestId, payload) {
    const id = Number(manifestId);
    const store = getJson(MANIFESTS_KEY, []);
    const idx = store.findIndex((x) => Number(x?.id) === id);
    if (idx === -1) throw apiError('Manifest not found', 404);
    const m = store[idx];
    if (String(m?.status || '').toLowerCase() !== 'open') throw apiError('Manifest closed', 400);

    const ident = String(payload?.identifier || '').trim().toUpperCase();
    if (!ident) throw apiError('identifier is required', 400);
    const awbCore = ident.length > 3 && ident.slice(-3).match(/^\d{3}$/) ? ident.slice(0, -3) : ident;

    let it = (Array.isArray(m.items) ? m.items : []).find((x) => String(x?.awb || '').toUpperCase() === awbCore);
    if (!it) {
        it = {
            id: Date.now(),
            manifest_id: id,
            awb: awbCore,
            parcels_total: payload?.parcels_total ?? null,
            scanned_identifiers: [],
            scanned_parcel_indexes: [],
            scan_count: 0,
            last_scanned_at: null,
            last_scanned_by: null,
            data: null,
        };
        m.items.unshift(it);
    }

    it.scanned_identifiers = Array.isArray(it.scanned_identifiers) ? it.scanned_identifiers : [];
    if (!it.scanned_identifiers.includes(ident)) it.scanned_identifiers.push(ident);
    it.scan_count = Number(it.scan_count || 0) + 1;
    it.last_scanned_at = new Date().toISOString();

    store[idx] = { ...m };
    setJson(MANIFESTS_KEY, store);
    return it;
}

export async function demoImportManifestAwbs(manifestId, payload = {}) {
    const id = Number(manifestId);
    const store = getJson(MANIFESTS_KEY, []);
    const idx = store.findIndex((x) => Number(x?.id) === id);
    if (idx === -1) throw apiError('Manifest not found', 404);
    const manifest = { ...store[idx] };
    if (String(manifest?.status || '').toLowerCase() !== 'open') throw apiError('Manifest is not open', 400);

    const file = payload?.file ?? null;
    const sheetUrl = String(payload?.google_sheet_url || '').trim();
    if (!file && !sheetUrl) throw apiError('Provide a file upload or Google Sheet URL.', 400);
    if (file && sheetUrl) throw apiError('Use either file or Google Sheet URL.', 400);
    if (sheetUrl) throw apiError('Google Sheet import is unavailable in demo mode.', 400);

    const fileName = String(file?.name || '').trim();
    const ext = fileName.toLowerCase().split('.').pop();
    if (ext === 'xlsx' || ext === 'xls') {
        throw apiError('Excel import is unavailable in demo mode. Use CSV/TXT.', 400);
    }

    const text = typeof file?.text === 'function' ? await file.text() : '';
    const lines = String(text || '').split(/\r?\n/);
    const rawTokens = [];
    for (const line of lines) {
        const matches = String(line || '').toUpperCase().match(/[A-Z0-9][A-Z0-9._/\-]{5,}/g);
        if (Array.isArray(matches) && matches.length) rawTokens.push(...matches);
    }

    const existing = new Set(
        (Array.isArray(manifest.items) ? manifest.items : [])
            .map((item) => String(item?.awb || '').trim().toUpperCase())
            .filter(Boolean)
    );
    const seenInImport = new Set();
    const importedAwbs = [];
    const duplicateAwbs = [];
    const invalidValues = [];
    const results = [];

    for (const tokenRaw of rawTokens) {
        const token = String(tokenRaw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!token || token.length < 6) {
            invalidValues.push(String(tokenRaw || ''));
            results.push({ raw: String(tokenRaw || ''), awb: null, ok: false, reason: 'invalid', detail: 'Invalid token' });
            continue;
        }
        const hasSuffix = token.length >= 13 && /[A-Z]/.test(token) && /\d{3}$/.test(token) && token.slice(-3) !== '000';
        const awb = hasSuffix ? token.slice(0, -3) : token;

        if (seenInImport.has(awb)) {
            duplicateAwbs.push(awb);
            results.push({ raw: String(tokenRaw || ''), awb, ok: false, reason: 'duplicate_in_file', detail: 'Duplicate AWB in upload' });
            continue;
        }
        seenInImport.add(awb);

        if (existing.has(awb)) {
            duplicateAwbs.push(awb);
            results.push({ raw: String(tokenRaw || ''), awb, ok: false, reason: 'already_in_manifest', detail: 'AWB already exists in manifest' });
            continue;
        }

        const item = {
            id: Date.now() + importedAwbs.length + 1,
            manifest_id: id,
            awb,
            parcels_total: null,
            scanned_identifiers: [token],
            scanned_parcel_indexes: [],
            scan_count: 1,
            last_scanned_at: new Date().toISOString(),
            last_scanned_by: 'demo-import',
            data: { source: 'admin_bulk_import', filename: fileName || null },
        };
        manifest.items = Array.isArray(manifest.items) ? manifest.items : [];
        manifest.items.unshift(item);
        importedAwbs.push(awb);
        existing.add(awb);
        results.push({ raw: String(tokenRaw || ''), awb, ok: true, reason: 'imported', detail: null });
    }

    store[idx] = manifest;
    setJson(MANIFESTS_KEY, store);

    return {
        manifest,
        source: 'file',
        filename: fileName || null,
        total_rows: lines.filter((line) => String(line || '').trim()).length,
        detected_tokens: rawTokens.length,
        processed_count: results.length,
        imported_count: importedAwbs.length,
        duplicate_count: duplicateAwbs.length,
        invalid_count: invalidValues.length,
        imported_awbs: importedAwbs,
        duplicate_awbs: duplicateAwbs,
        invalid_values: invalidValues,
        results,
    };
}

export async function demoCloseManifest(manifestId, payload) {
    const id = Number(manifestId);
    const store = getJson(MANIFESTS_KEY, []);
    const idx = store.findIndex((x) => Number(x?.id) === id);
    if (idx === -1) throw apiError('Manifest not found', 404);
    store[idx] = { ...store[idx], status: 'Closed', notes: payload?.notes ?? store[idx]?.notes ?? null };
    setJson(MANIFESTS_KEY, store);
    return store[idx];
}

export async function demoApproveManifestUnload(manifestId, payload = {}) {
    const id = Number(manifestId);
    const store = getJson(MANIFESTS_KEY, []);
    const idx = store.findIndex((x) => Number(x?.id) === id);
    if (idx === -1) throw apiError('Manifest not found', 404);

    const manifest = { ...store[idx] };
    const items = Array.isArray(manifest.items) ? manifest.items : [];
    if (!items.length) throw apiError('Manifest has no scanned AWBs', 400);

    const eventId = '6';
    const nowIso = new Date().toISOString();
    const dateLabel = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const shipments = getJson(DEMO_SHIPMENTS_KEY, []);
    const shipmentByAwb = new Map((Array.isArray(shipments) ? shipments : []).map((s, index) => [String(s?.awb || '').toUpperCase(), index]));

    const results = [];
    for (const item of items) {
        const awb = String(item?.awb || '').trim().toUpperCase();
        if (!awb) {
            results.push({ awb: String(item?.awb || ''), ok: false, detail: 'Invalid AWB', reference: null });
            continue;
        }

        const shipIdx = shipmentByAwb.get(awb);
        if (Number.isFinite(shipIdx)) {
            const ship = { ...(shipments[shipIdx] || {}) };
            const history = Array.isArray(ship.tracking_history) ? ship.tracking_history : [];
            history.unshift({
                eventDescription: EVENT_LABELS[eventId] || 'Intrare in depozit',
                eventDate: nowIso,
                localityName: 'Depozit'
            });
            ship.status = EVENT_TO_STATUS[eventId] || 'In Depot';
            ship.awb_status_date = nowIso;
            ship.last_updated = nowIso;
            ship.tracking_history = history.slice(0, 60);
            shipments[shipIdx] = ship;
        }

        results.push({
            awb,
            ok: true,
            detail: null,
            reference: `demo-manifest-${id}-${awb}`
        });
    }

    setJson(DEMO_SHIPMENTS_KEY, shipments);

    const successCount = results.filter((r) => Boolean(r?.ok)).length;
    const failedCount = results.length - successCount;
    const closeOnSuccess = payload?.close_on_success !== false;
    manifest.status = failedCount === 0 && closeOnSuccess ? 'Approved' : 'Open';

    const noteParts = [];
    const baseNote = String(payload?.notes || '').trim();
    if (baseNote) noteParts.push(baseNote);
    noteParts.push(`[Unload approve ${dateLabel}: ok=${successCount} fail=${failedCount}]`);
    manifest.notes = noteParts.join(' | ');

    store[idx] = manifest;
    setJson(MANIFESTS_KEY, store);

    return {
        manifest,
        event_id: eventId,
        total_awbs: results.length,
        success_count: successCount,
        failed_count: failedCount,
        results,
    };
}

export async function demoStartRouteRun(payload) {
    const { payload: authPayload } = currentAuth();
    const uid = String(authPayload?.driver_id || '').trim() || 'D002';
    const role = String(authPayload?.role || '').trim() || 'Driver';

    const store = getJson(ROUTE_RUNS_KEY, []);
    const id = Date.now();
    const awbs = Array.isArray(payload?.awbs) ? payload.awbs.map((x) => String(x || '').toUpperCase()).filter(Boolean) : [];

    const run = {
        id,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        ended_at: null,
        status: 'Active',
        route_id: payload?.route_id ?? null,
        route_name: payload?.route_name ?? null,
        driver_id: uid,
        truck_plate: payload?.truck_plate ?? null,
        helper_name: payload?.helper_name ?? null,
        data: payload?.data ?? null,
        stops: awbs.map((awb, idx) => ({
            id: id + idx + 1,
            run_id: id,
            awb,
            seq: idx + 1,
            state: 'Pending',
            arrived_at: null,
            completed_at: null,
            completion_event_id: null,
            last_latitude: null,
            last_longitude: null,
            notes: null,
            data: null,
        }))
    };
    store.unshift(run);
    setJson(ROUTE_RUNS_KEY, store.slice(0, 100));
    return run;
}

export async function demoListActiveRouteRuns({ limit = 50 } = {}) {
    const store = getJson(ROUTE_RUNS_KEY, []);
    const active = store.filter((r) => String(r?.status || '') === 'Active');
    return active.slice(0, Math.max(1, Math.min(200, Number(limit || 50))));
}

export async function demoGetRouteRun(runId) {
    const id = Number(runId);
    const store = getJson(ROUTE_RUNS_KEY, []);
    const run = store.find((r) => Number(r?.id) === id);
    if (!run) throw apiError('Route run not found', 404);
    return run;
}

const updateRouteRunStop = (runId, awb, patch) => {
    const id = Number(runId);
    const key = String(awb || '').trim().toUpperCase();
    const store = getJson(ROUTE_RUNS_KEY, []);
    const idx = store.findIndex((r) => Number(r?.id) === id);
    if (idx === -1) throw apiError('Route run not found', 404);
    const run = store[idx];
    const stops = Array.isArray(run?.stops) ? run.stops : [];
    const sidx = stops.findIndex((s) => String(s?.awb || '').toUpperCase() === key);
    if (sidx === -1) throw apiError('Stop not found', 404);
    stops[sidx] = { ...stops[sidx], ...patch };
    store[idx] = { ...run, stops };
    setJson(ROUTE_RUNS_KEY, store);
    return stops[sidx];
};

export async function demoRouteRunArrive(runId, awb, payload) {
    return updateRouteRunStop(runId, awb, {
        state: 'Arrived',
        arrived_at: new Date().toISOString(),
        last_latitude: payload?.latitude ?? null,
        last_longitude: payload?.longitude ?? null,
        notes: payload?.notes ?? null,
        data: payload?.data ?? null,
    });
}

export async function demoRouteRunDepart(runId, awb, payload) {
    const nowIso = new Date().toISOString();
    const prev = await demoGetRouteRun(runId);
    const key = String(awb || '').trim().toUpperCase();
    const stop = (Array.isArray(prev?.stops) ? prev.stops : []).find((s) => String(s?.awb || '').toUpperCase() === key) || {};
    const mergedData = {
        ...(stop?.data && typeof stop.data === 'object' ? stop.data : {}),
        ...(payload?.data && typeof payload.data === 'object' ? payload.data : {}),
        on_the_way: true,
        tracking_visible: true,
        on_the_way_at: nowIso,
    };
    return updateRouteRunStop(runId, awb, {
        state: 'OnTheWay',
        last_latitude: payload?.latitude ?? stop?.last_latitude ?? null,
        last_longitude: payload?.longitude ?? stop?.last_longitude ?? null,
        notes: payload?.notes ?? stop?.notes ?? null,
        data: mergedData,
    });
}

export async function demoRouteRunComplete(runId, awb, payload) {
    return updateRouteRunStop(runId, awb, {
        state: 'Done',
        arrived_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        completion_event_id: payload?.completion_event_id ?? null,
        last_latitude: payload?.latitude ?? null,
        last_longitude: payload?.longitude ?? null,
        notes: payload?.notes ?? null,
        data: payload?.data ?? null,
    });
}

export async function demoRouteRunSkip(runId, awb, payload) {
    return updateRouteRunStop(runId, awb, {
        state: 'Skipped',
        arrived_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        last_latitude: payload?.latitude ?? null,
        last_longitude: payload?.longitude ?? null,
        notes: payload?.notes ?? null,
        data: payload?.data ?? null,
    });
}

export async function demoFinishRouteRun(runId) {
    const id = Number(runId);
    const store = getJson(ROUTE_RUNS_KEY, []);
    const idx = store.findIndex((r) => Number(r?.id) === id);
    if (idx === -1) throw apiError('Route run not found', 404);
    store[idx] = { ...store[idx], status: 'Finished', ended_at: new Date().toISOString() };
    setJson(ROUTE_RUNS_KEY, store);
    return store[idx];
}

export async function demoGetLiveDrivers() {
    return { generated_at: new Date().toISOString(), drivers: [] };
}

export async function demoGetCodReport() {
    return {
        generated_at: new Date().toISOString(),
        driver_id: null,
        totals: { shipments: 0, expected_total: 0, collected_total: 0, delta_total: 0, transfers: 0 },
        by_driver: [],
        shipments: [],
        transfers: []
    };
}

export async function demoUpdateShipmentInstructions(awb, { instructions } = {}) {
    const key = normalizeAwb(awb);
    if (!key) throw apiError('AWB is required.');
    const shipments = getShipmentsStore();
    const idx = shipments.findIndex((s) => normalizeAwb(s?.awb) === key);
    if (idx === -1) throw apiError('Shipment not found.');

    const next = String(instructions || '').trim();
    shipments[idx] = {
        ...(shipments[idx] || {}),
        recipient_instructions: next || null,
        last_updated: new Date().toISOString(),
    };
    setShipmentsStore(shipments);
    return {
        status: 'ok',
        awb: key,
        delivery_instructions: shipments[idx]?.delivery_instructions ?? null,
        recipient_instructions: shipments[idx]?.recipient_instructions ?? null,
    };
}

export async function demoRequestReschedule(awb) {
    return { status: 'ok', awb: String(awb || '').toUpperCase() };
}

export async function demoGetPaymentLink(awb) {
    return { status: 'ok', awb: String(awb || '').toUpperCase(), amount: 0, url: 'https://example.com/pay' };
}

export async function demoGetShipmentPod(awb) {
    return { awb: String(awb || '').toUpperCase(), log_id: 0, timestamp: null, driver_id: null, pod: null };
}
