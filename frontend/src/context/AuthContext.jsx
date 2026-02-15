import React, { createContext, useContext, useState, useEffect } from 'react';
import { getMe } from '../services/api';
import { normalizeRole, permissionsForRole } from '../auth/permissions';
const jwtDecode = (token) => {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        return null;
    }
};

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            const token = localStorage.getItem('token');
            if (!token) {
                if (!cancelled) setLoading(false);
                return;
            }

            const decoded = jwtDecode(token);
            if (!decoded || !decoded.sub) {
                console.warn("Invalid/undecodable token in localStorage; clearing it.");
                localStorage.removeItem('token');
                if (!cancelled) setLoading(false);
                return;
            }

            // Base user from token payload: { sub: username, driver_id: id, role: role, exp: ... }
            const roleNorm = normalizeRole(decoded.role);
            const baseUser = {
                username: decoded.sub,
                driver_id: decoded.driver_id,
                role: roleNorm,
                token,
                permissions: permissionsForRole(roleNorm)
            };

            if (!cancelled) setUser(baseUser);

            // Enrich with /me (name, permissions, allocated truck, etc.)
            try {
                const me = await getMe(token);
                if (!cancelled && me) {
                    setUser((prev) => ({
                        ...(prev || baseUser),
                        ...me,
                        token,
                        permissions: Array.isArray(me?.permissions) ? me.permissions : (prev?.permissions || baseUser.permissions)
                    }));
                }
            } catch (e) {
                // Offline mode is supported elsewhere; keep token-based user as fallback.
                console.warn("Failed to load /me; continuing with token payload only.", e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    const login = async (token, role) => {
        localStorage.setItem('token', token);
        const decoded = jwtDecode(token);
        if (!decoded || !decoded.sub) {
            console.error("Login returned an invalid token; clearing it.");
            localStorage.removeItem('token');
            setUser(null);
            return;
        }
        const roleNorm = normalizeRole(role || decoded.role);
        const baseUser = {
            username: decoded.sub,
            driver_id: decoded.driver_id,
            role: roleNorm,
            token: token,
            permissions: permissionsForRole(roleNorm)
        };

        setUser(baseUser);

        try {
            const me = await getMe(token);
            if (me) {
                setUser((prev) => ({
                    ...(prev || baseUser),
                    ...me,
                    token,
                    permissions: Array.isArray(me?.permissions) ? me.permissions : (prev?.permissions || baseUser.permissions)
                }));
            }
        } catch (e) {
            console.warn("Failed to load /me after login; continuing with token payload only.", e);
        }
    };

    const logout = () => {
        localStorage.setItem('token', '');
        localStorage.removeItem('token');
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, login, logout, loading }}>
            {!loading && children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
