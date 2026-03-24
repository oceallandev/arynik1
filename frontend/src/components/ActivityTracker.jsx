import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { logActivity } from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function ActivityTracker() {
    const location = useLocation();
    const { user } = useAuth();
    const token = user?.token;
    
    useEffect(() => {
        if (token) {
            logActivity(token, {
                action_type: 'VIEW',
                path: location.pathname + location.search,
                method: 'GET',
                details: `Visited ${location.pathname}`
            }).catch(() => {
                // Silently ignore tracking errors so they don't break the UI
            });
        }
    }, [location, token]);

    return null;
}
