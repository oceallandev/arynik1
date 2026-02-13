import { get, keys, set } from 'idb-keyval';
import { updateAwb } from '../services/api';

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
    const queueKeys = allKeys.filter((key) => key.startsWith('queue-'));
    const items = await Promise.all(queueKeys.map((key) => get(key)));

    return items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
};

export const syncQueue = async (token) => {
    const items = await getQueue();
    const pendingItems = items.filter((item) => item.status === 'pending');

    for (const item of pendingItems) {
        try {
            await updateAwb(token, {
                awb: item.awb,
                event_id: item.event_id,
                timestamp: item.timestamp,
                payload: item.payload
            });

            item.status = 'synced';
            await set(`queue-${item.id}`, item);
        } catch (error) {
            console.error('Sync failed for item', item.id, error);
        }
    }
};
