import { useEffect, useRef, useState } from 'react';
import { DEFAULT_GEO_WATCH_OPTIONS, getCurrentPositionRobust, normalizeGeoErrorMessage } from '../services/location';

export default function useGeolocation(params = {}) {
    const enabled = typeof params === 'boolean'
        ? params
        : (params?.enabled ?? true);

    const [location, setLocation] = useState(null);
    const [error, setError] = useState(null);
    const locationRef = useRef(null);

    useEffect(() => {
        if (!enabled) {
            return;
        }

        if (!navigator.geolocation) {
            setError('Geolocation is not supported by your browser');
            return;
        }

        const success = (position) => {
            const { latitude, longitude, heading, speed } = position.coords;
            const next = { latitude, longitude, heading, speed };
            locationRef.current = next;
            setLocation(next);
            setError(null);
        };

        const handleError = (geoErr) => {
            // On mobile, watchPosition may timeout intermittently even when a recent fix exists.
            if (Number(geoErr?.code || 0) === 3 && locationRef.current) return;
            setError(normalizeGeoErrorMessage(geoErr));
        };

        const options = {
            ...DEFAULT_GEO_WATCH_OPTIONS,
            ...(typeof params === 'object' && params?.options ? params.options : {})
        };

        const id = navigator.geolocation.watchPosition(success, handleError, options);
        let cancelled = false;

        // Prime the first location with a robust multi-attempt request.
        if (!locationRef.current) {
            getCurrentPositionRobust()
                .then((coords) => {
                    if (cancelled) return;
                    const next = {
                        latitude: Number(coords.latitude),
                        longitude: Number(coords.longitude),
                        heading: Number.isFinite(Number(coords.heading)) ? Number(coords.heading) : null,
                        speed: Number.isFinite(Number(coords.speed)) ? Number(coords.speed) : null
                    };
                    locationRef.current = next;
                    setLocation(next);
                    setError(null);
                })
                .catch((e) => {
                    if (cancelled) return;
                    const code = Number(e?.code || 0);
                    // Ignore transient timeout while watchPosition continues trying.
                    if (code === 3) return;
                    setError(normalizeGeoErrorMessage(e));
                });
        }

        return () => {
            cancelled = true;
            navigator.geolocation.clearWatch(id);
        };
    }, [enabled]);

    return { location, error };
}
