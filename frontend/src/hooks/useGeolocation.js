import { useState, useEffect } from 'react';

export default function useGeolocation() {
    const [location, setLocation] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
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
            maximumAge: 0
        };

        const id = navigator.geolocation.watchPosition(success, handleError, options);

        return () => navigator.geolocation.clearWatch(id);
    }, []);

    return { location, error };
}
