import { useEffect, useRef } from 'react';

/**
 * Keep the screen awake while live driver tracking is active.
 * This improves location continuity on mobile browsers that throttle background tabs.
 */
export default function useWakeLock(enabled = false) {
    const lockRef = useRef(null);

    useEffect(() => {
        let mounted = true;

        const releaseLock = async () => {
            const lock = lockRef.current;
            lockRef.current = null;
            if (!lock || typeof lock.release !== 'function') return;
            try { await lock.release(); } catch { }
        };

        const requestLock = async () => {
            if (!mounted || !enabled) return;
            if (typeof navigator === 'undefined') return;
            if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
            if (document.visibilityState !== 'visible') return;
            if (lockRef.current) return;
            try {
                const lock = await navigator.wakeLock.request('screen');
                if (!mounted) {
                    try { await lock.release(); } catch { }
                    return;
                }
                lockRef.current = lock;
                if (lock && typeof lock.addEventListener === 'function') {
                    lock.addEventListener('release', () => {
                        if (lockRef.current === lock) lockRef.current = null;
                    });
                }
            } catch {
                // Ignore unsupported/denied wake lock requests.
            }
        };

        const onVisibility = () => {
            if (!enabled) {
                void releaseLock();
                return;
            }
            if (document.visibilityState === 'visible') {
                void requestLock();
            }
        };

        if (enabled) {
            void requestLock();
            document.addEventListener('visibilitychange', onVisibility);
        } else {
            void releaseLock();
        }

        return () => {
            mounted = false;
            document.removeEventListener('visibilitychange', onVisibility);
            void releaseLock();
        };
    }, [enabled]);
}

