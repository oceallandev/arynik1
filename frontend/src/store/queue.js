import { get, set, del, keys } from 'idb-keyval';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const queueItem = async (awb, event_id, payload = {}) => {
    const id = `${awb}-${event_id}-${Date.now()}`;
    const item = {
        id,
        awb,
        event_id,
        payload,
        timestamp: new Date().toISOString(),
        status: 'pending'
    };
    await set(`queue-${id}`, item);
    return item;
};

export const getQueue = async () => {
    const allKeys = await keys();
    const queueKeys = allKeys.filter(k => k.startsWith('queue-'));
    const items = await Promise.all(queueKeys.map(k => get(k)));
    return items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
};

export const syncQueue = async (token) => {
    const items = await getQueue();
    const pendingItems = items.filter(i => i.status === 'pending');

    for (const item of pendingItems) {
        try {
            await axios.post(`${API_URL}/update-awb`, {
                awb: item.awb,
                event_id: item.event_id,
                timestamp: item.timestamp,
                payload: item.payload
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            item.status = 'synced';
            await set(`queue-${item.id}`, item);
        } catch (error) {
            console.error('Sync failed for item', item.id, error);
        }
    }
};
