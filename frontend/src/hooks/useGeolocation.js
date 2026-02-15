import { useState, useEffect } from 'react';

export default function useGeolocation(params = {}) {
    const enabled = typeof params === 'boolean'
        ? params
        : (params?.enabled ?? true);

    const [location, setLocation] = useState(null);
    const [error, setError] = useState(null);

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
            setLocation({ latitude, longitude, heading, speed });
        };

        const handleError = (error) => {
            setError(error.message);
        };

        const options = {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0,
            ...(typeof params === 'object' && params?.options ? params.options : {})
        };

        const id = navigator.geolocation.watchPosition(success, handleError, options);

        return () => navigator.geolocation.clearWatch(id);
    }, [enabled]);

    return { location, error };
}
