import { del, get, keys, set } from 'idb-keyval';
import { updateAwb } from '../services/api';

const QUEUE_PREFIX = 'queue-';
const QUEUE_EVENT = 'arynik:queue-updated';
const DEFAULT_AUTO_SYNC_MS = 30000;

let syncPromise = null;
let autoSyncStarted = false;

const isAuthError = (error) => {
    const status = Number(error?.response?.status || 0);
    return status === 401 || status === 403;
};

const queueKey = (id) => `${QUEUE_PREFIX}${id}`;

const emitQueueChanged = async () => {
    if (typeof window === 'undefined') return;
    try {
        const stats = await getQueueStats();
        window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: stats }));
    } catch {
        window.dispatchEvent(new CustomEvent(QUEUE_EVENT));
    }
};

export const queueItem = async (awb, event_id, payload = {}) => {
    const id = `${String(awb || '').trim().toUpperCase()}-${String(event_id || '').trim()}-${Date.now()}`;
    const item = {
        id,
        type: 'update-awb',
        awb: String(awb || '').trim().toUpperCase(),
        event_id: String(event_id || '').trim(),
        payload,
        timestamp: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        last_error: null,
        last_attempt_at: null,
        synced_at: null,
    };

    await set(queueKey(id), item);
    await emitQueueChanged();
    return item;
};

export const getQueue = async () => {
    const allKeys = await keys();
    const queueKeys = (Array.isArray(allKeys) ? allKeys : []).filter((key) => String(key).startsWith(QUEUE_PREFIX));
    const items = await Promise.all(queueKeys.map((key) => get(key)));
    return (Array.isArray(items) ? items : [])
        .filter(Boolean)
        .sort((a, b) => new Date(b?.timestamp || 0) - new Date(a?.timestamp || 0));
};

export const getQueueStats = async () => {
    const items = await getQueue();
    const stats = {
        total: items.length,
        pending: 0,
        synced: 0,
        failed: 0,
        last_timestamp: null,
    };

    for (const item of items) {
        const status = String(item?.status || 'pending');
        if (status === 'synced') stats.synced += 1;
        else if (status === 'failed') stats.failed += 1;
        else stats.pending += 1;
    }

    if (items.length > 0) {
        stats.last_timestamp = items[0]?.timestamp || null;
    }

    return stats;
};

const processQueueItem = async (token, item) => {
    const type = String(item?.type || 'update-awb');
    if (type === 'update-awb') {
        await updateAwb(token, {
            awb: item.awb,
            event_id: item.event_id,
            timestamp: item.timestamp,
            payload: item.payload,
        });
        return;
    }

    throw new Error(`Unsupported queue item type: ${type}`);
};

const pruneQueue = async ({ keepSynced = 200, maxSyncedAgeDays = 7 } = {}) => {
    const items = await getQueue();
    const synced = items
        .filter((it) => String(it?.status || '') === 'synced')
        .sort((a, b) => new Date(b?.synced_at || b?.timestamp || 0) - new Date(a?.synced_at || a?.timestamp || 0));

    const maxAgeMs = Math.max(1, Number(maxSyncedAgeDays || 7)) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const toDelete = [];

    synced.forEach((item, idx) => {
        const ts = new Date(item?.synced_at || item?.timestamp || 0).getTime();
        const tooOld = Number.isFinite(ts) ? ((now - ts) > maxAgeMs) : true;
        const overLimit = idx >= Math.max(0, Number(keepSynced || 0));
        if (tooOld || overLimit) {
            toDelete.push(queueKey(item.id));
        }
    });

    if (toDelete.length > 0) {
        await Promise.all(toDelete.map((k) => del(k)));
    }

    return toDelete.length;
};

export const syncQueue = async (token, { limit = 200 } = {}) => {
    if (!token) {
        return { synced: 0, failed: 0, pending: (await getQueueStats()).pending };
    }

    if (syncPromise) {
        return syncPromise;
    }

    syncPromise = (async () => {
        const items = await getQueue();
        const pending = items
            .filter((item) => String(item?.status || 'pending') === 'pending')
            .sort((a, b) => new Date(a?.timestamp || 0) - new Date(b?.timestamp || 0))
            .slice(0, Math.max(1, Number(limit || 200)));

        let syncedCount = 0;
        let failedCount = 0;

        for (const item of pending) {
            const key = queueKey(item.id);
            const next = {
                ...item,
                attempts: Number(item?.attempts || 0) + 1,
                last_attempt_at: new Date().toISOString(),
            };
            try {
                await processQueueItem(token, next);
                next.status = 'synced';
                next.last_error = null;
                next.synced_at = new Date().toISOString();
                syncedCount += 1;
            } catch (error) {
                next.status = 'pending';
                next.last_error = String(error?.response?.data?.detail || error?.message || 'Sync failed');
                failedCount += 1;
                await set(key, next);

                if (isAuthError(error)) {
                    // Stop processing: token is invalid/expired.
                    break;
                }

                continue;
            }

            await set(key, next);
        }

        await pruneQueue();
        await emitQueueChanged();
        const stats = await getQueueStats();
        return {
            synced: syncedCount,
            failed: failedCount,
            pending: stats.pending,
            total: stats.total,
        };
    })();

    try {
        return await syncPromise;
    } finally {
        syncPromise = null;
    }
};

export const clearQueue = async () => {
    const allKeys = await keys();
    const queueKeys = (Array.isArray(allKeys) ? allKeys : []).filter((key) => String(key).startsWith(QUEUE_PREFIX));
    await Promise.all(queueKeys.map((key) => del(key)));
    await emitQueueChanged();
    return queueKeys.length;
};

export const startQueueAutoSync = ({ getToken, intervalMs = DEFAULT_AUTO_SYNC_MS } = {}) => {
    if (typeof window === 'undefined' || autoSyncStarted) {
        return () => { };
    }

    autoSyncStarted = true;

    const resolveToken = () => {
        try {
            if (typeof getToken === 'function') {
                const t = getToken();
                if (t) return t;
            }
            return localStorage.getItem('token');
        } catch {
            return null;
        }
    };

    const runSync = async () => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        const token = resolveToken();
        if (!token) return;
        await syncQueue(token).catch(() => { });
    };

    const onOnline = () => { void runSync(); };
    const onVisibility = () => {
        if (document?.visibilityState === 'visible') {
            void runSync();
        }
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => { void runSync(); }, Math.max(10000, Number(intervalMs || DEFAULT_AUTO_SYNC_MS)));

    void runSync();
    void emitQueueChanged();

    return () => {
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisibility);
        window.clearInterval(timer);
        autoSyncStarted = false;
    };
};

export const QUEUE_UPDATED_EVENT = QUEUE_EVENT;
