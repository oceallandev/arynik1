const DEMO_LOGS_KEY = 'arynik_demo_logs_v1';
const DEMO_SHIPMENTS_KEY = 'arynik_demo_shipments_v1';

const STATUS_OPTIONS = [
    {
        event_id: 'DELIVERED',
        label: 'Delivered',
        description: 'Package delivered to recipient'
    },
    {
        event_id: 'IN_TRANSIT',
        label: 'In Transit',
        description: 'Package is on route to destination'
    },
    {
        event_id: 'NOT_HOME',
        label: 'Not Home',
        description: 'Recipient was not available at address'
    },
    {
        event_id: 'REFUSED',
        label: 'Refused',
        description: 'Recipient refused the package'
    },
    {
        event_id: 'WRONG_ADDRESS',
        label: 'Wrong Address',
        description: 'Address is incorrect or incomplete'
    }
];

const EVENT_LABELS = STATUS_OPTIONS.reduce((acc, option) => {
    acc[option.event_id] = option.label;
    return acc;
}, {});

const EVENT_TO_STATUS = {
    DELIVERED: 'Delivered',
    IN_TRANSIT: 'In Transit',
    NOT_HOME: 'Attempted',
    REFUSED: 'Refused',
    WRONG_ADDRESS: 'Address Issue'
};

const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const initialShipments = () => ([
    {
        awb: 'AWB1000001',
        recipient_name: 'Maria Popescu',
        delivery_address: 'Bucharest, Sector 1',
        weight: 1.2,
        status: 'In Transit',
        tracking_history: [
            {
                eventDescription: 'Package picked up by courier',
                eventDate: hoursAgo(20),
                localityName: 'Bucharest'
            },
            {
                eventDescription: 'In transit to delivery area',
                eventDate: hoursAgo(6),
                localityName: 'Bucharest'
            }
        ]
    },
    {
        awb: 'AWB1000002',
        recipient_name: 'Andrei Ionescu',
        delivery_address: 'Cluj-Napoca, Str. Memorandumului 5',
        weight: 0.8,
        status: 'Attempted',
        tracking_history: [
            {
                eventDescription: 'Delivery attempted, recipient not home',
                eventDate: hoursAgo(4),
                localityName: 'Cluj-Napoca'
            }
        ]
    },
    {
        awb: 'AWB1000003',
        recipient_name: 'Elena Stan',
        delivery_address: 'Iasi, Bulevardul Stefan cel Mare 10',
        weight: 2.5,
        status: 'Delivered',
        tracking_history: [
            {
                eventDescription: 'Package delivered to recipient',
                eventDate: hoursAgo(2),
                localityName: 'Iasi'
            }
        ]
    }
]);

const safeParse = (raw, fallbackValue) => {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : fallbackValue;
    } catch {
        return fallbackValue;
    }
};

const loadArray = (key, fallbackFactory) => {
    const raw = localStorage.getItem(key);

    if (!raw) {
        const seeded = fallbackFactory();
        localStorage.setItem(key, JSON.stringify(seeded));
        return seeded;
    }

    return safeParse(raw, fallbackFactory());
};

const saveArray = (key, value) => {
    localStorage.setItem(key, JSON.stringify(value));
};

const getLogs = () => loadArray(DEMO_LOGS_KEY, () => []);
const setLogs = (logs) => saveArray(DEMO_LOGS_KEY, logs);

const getShipmentsStore = () => loadArray(DEMO_SHIPMENTS_KEY, initialShipments);
const setShipmentsStore = (shipments) => saveArray(DEMO_SHIPMENTS_KEY, shipments);

const toBase64Url = (value) => {
    const bytes = new TextEncoder().encode(value);
    let binary = '';

    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });

    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
};

const buildDemoToken = (payload) => {
    const header = { alg: 'none', typ: 'JWT' };
    return `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}.demo`;
};

const apiError = (detail) => {
    const error = new Error(detail);
    error.response = { data: { detail } };
    return error;
};

const roleForUsername = (username) => {
    const normalized = username.toLowerCase();

    if (normalized.includes('admin')) {
        return 'Admin';
    }

    if (normalized.includes('manager')) {
        return 'Manager';
    }

    return 'Driver';
};

const normalizeAwb = (awb) => String(awb || '').trim().toUpperCase();

const withDateFilters = (logs, params = {}) => {
    const { start_date: startDate, end_date: endDate, awb } = params;

    return logs.filter((log) => {
        const ts = new Date(log.timestamp);

        if (Number.isNaN(ts.getTime())) {
            return false;
        }

        if (startDate && ts < new Date(startDate)) {
            return false;
        }

        if (endDate && ts > new Date(endDate)) {
            return false;
        }

        if (awb && log.awb !== awb) {
            return false;
        }

        return true;
    });
};

const updateShipmentFromEvent = (shipments, awb, eventId, timestamp, localityName) => {
    const statusText = EVENT_TO_STATUS[eventId] || 'Updated';
    const eventDescription = `Status updated: ${EVENT_LABELS[eventId] || eventId}`;

    let shipment = shipments.find((item) => item.awb === awb);

    if (!shipment) {
        shipment = {
            awb,
            recipient_name: 'Demo Recipient',
            delivery_address: 'Demo Address',
            weight: 1,
            status: statusText,
            tracking_history: []
        };
        shipments.unshift(shipment);
    }

    shipment.status = statusText;
    shipment.tracking_history = [
        {
            eventDescription,
            eventDate: timestamp,
            localityName: localityName || 'Demo City'
        },
        ...(shipment.tracking_history || [])
    ];
};

const makeId = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

export async function demoLogin(username, password) {
    if (!username || !password) {
        throw apiError('Username and password are required.');
    }

    if (password !== 'demo' && password !== 'admin') {
        throw apiError('Demo mode: use password "demo".');
    }

    const role = roleForUsername(username);
    const payload = {
        sub: username,
        driver_id: `DRV-${username.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || '0001'}`,
        role,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    };

    return {
        access_token: buildDemoToken(payload),
        token_type: 'bearer',
        role
    };
}

export async function demoGetStats() {
    const logs = getLogs().filter((log) => log.status === 'synced');
    const todayStamp = new Date().toDateString();
    const todayCount = logs.filter((log) => new Date(log.timestamp).toDateString() === todayStamp).length;

    return {
        today_count: todayCount,
        total_count: logs.length,
        driver_name: 'Demo Driver',
        last_sync: new Date().toISOString()
    };
}

export async function demoGetStatusOptions() {
    return STATUS_OPTIONS;
}

export async function demoUpdateAwb(request) {
    const awb = normalizeAwb(request?.awb);
    const eventId = request?.event_id;

    if (!awb || !eventId) {
        throw apiError('AWB and event_id are required.');
    }

    const timestamp = request.timestamp || new Date().toISOString();

    const shipments = getShipmentsStore();
    updateShipmentFromEvent(
        shipments,
        awb,
        eventId,
        timestamp,
        request?.payload?.locality
    );
    setShipmentsStore(shipments);

    const logs = getLogs();
    logs.push({
        id: makeId('log'),
        awb,
        event_id: eventId,
        timestamp,
        outcome: 'SUCCESS',
        status: 'synced',
        label: EVENT_LABELS[eventId] || eventId,
        error_message: null
    });
    setLogs(logs);

    return {
        status: 'ok',
        outcome: 'SUCCESS',
        reference: makeId('DEMO')
    };
}

export async function demoGetLogs(params = {}) {
    const logs = getLogs().map((log) => ({
        ...log,
        label: log.label || EVENT_LABELS[log.event_id] || log.event_id
    }));

    return withDateFilters(logs, params)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export async function demoGetShipments() {
    return getShipmentsStore().sort((a, b) => a.awb.localeCompare(b.awb));
}
