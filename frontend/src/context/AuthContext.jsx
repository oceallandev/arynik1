import React, { createContext, useContext, useState, useEffect } from 'react';
import { getMe, syncMyDevicePhone } from '../services/api';
import { normalizeRole, permissionsForRole } from '../auth/permissions';
import { phoneDigitsFingerprint, readDevicePhoneNumber } from '../services/devicePhone';

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

const isAuthError = (error) => {
    const status = Number(error?.response?.status || 0);
    return status === 401 || status === 403;
};

const isExpiredJwt = (payload) => {
    const exp = Number(payload?.exp || 0);
    if (!exp) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return exp <= nowSec;
};

const isLegacyOfflineToken = (token, payload = null) => {
    const raw = String(token || '').trim();
    if (!raw) return false;
    const parts = raw.split('.');
    if (parts.length === 3 && String(parts[2] || '').toLowerCase() === 'offline') {
        return true;
    }
    const decoded = payload || jwtDecode(raw);
    const issuer = String(decoded?.iss || '').trim().toLowerCase();
    const source = String(decoded?.source || '').trim().toLowerCase();
    return issuer === 'offline' || source === 'offline';
};

const AUTH_INVALID_EVENT = 'arynik:auth-invalid';

const maybeSyncDriverDevicePhone = async ({ token, userLike }) => {
    const roleNorm = normalizeRole(userLike?.role);
    if (roleNorm !== 'Driver') return null;

    try {
        const detected = await readDevicePhoneNumber();
        const detectedPhone = String(detected?.phone || '').trim();
        if (!detectedPhone) return null;

        const existingPhone = String(userLike?.truck_phone || userLike?.phone_number || '').trim();
        const sameNumber = (
            phoneDigitsFingerprint(existingPhone)
            && phoneDigitsFingerprint(existingPhone) === phoneDigitsFingerprint(detectedPhone)
        );
        if (sameNumber) {
            return {
                truck_phone: existingPhone || detectedPhone,
                updated: false,
                source: detected?.source || 'device',
            };
        }

        const payload = await syncMyDevicePhone(token, {
            phone_number: detectedPhone,
            source: detected?.source || 'device_auto',
        });
        return payload && typeof payload === 'object' ? payload : null;
    } catch (e) {
        // Best effort only; login flow should not fail because phone cannot be read/synced.
        console.warn('Device phone auto-sync skipped:', e?.message || e);
        return null;
    }
};

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const onAuthInvalid = () => {
            localStorage.removeItem('token');
            setUser(null);
            setLoading(false);
        };
        window.addEventListener(AUTH_INVALID_EVENT, onAuthInvalid);
        return () => window.removeEventListener(AUTH_INVALID_EVENT, onAuthInvalid);
    }, []);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            const token = localStorage.getItem('token');
            if (!token) {
                if (!cancelled) setLoading(false);
                return;
            }

            const decoded = jwtDecode(token);
            if (!decoded || !decoded.sub || isLegacyOfflineToken(token, decoded) || isExpiredJwt(decoded)) {
                console.warn("Invalid/expired local token; clearing it.");
                localStorage.removeItem('token');
                if (!cancelled) setUser(null);
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
                const syncPayload = await maybeSyncDriverDevicePhone({ token, userLike: me || baseUser });
                if (!cancelled && syncPayload?.truck_phone) {
                    setUser((prev) => ({
                        ...(prev || baseUser),
                        truck_phone: String(syncPayload.truck_phone || '').trim() || null,
                        phone_number: String(syncPayload.truck_phone || '').trim() || null,
                    }));
                }
            } catch (e) {
                if (isAuthError(e)) {
                    console.warn("Stored session is no longer valid; clearing token.");
                    localStorage.removeItem('token');
                    if (!cancelled) setUser(null);
                } else {
                    // Offline mode is supported elsewhere; keep token-based user as fallback.
                    console.warn("Failed to load /me; continuing with token payload only.", e);
                }
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
        if (!decoded || !decoded.sub || isLegacyOfflineToken(token, decoded) || isExpiredJwt(decoded)) {
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
            const syncPayload = await maybeSyncDriverDevicePhone({ token, userLike: me || baseUser });
            if (syncPayload?.truck_phone) {
                setUser((prev) => ({
                    ...(prev || baseUser),
                    truck_phone: String(syncPayload.truck_phone || '').trim() || null,
                    phone_number: String(syncPayload.truck_phone || '').trim() || null,
                }));
            }
        } catch (e) {
            if (isAuthError(e)) {
                console.warn("Login session rejected by backend; clearing token.");
                localStorage.removeItem('token');
                setUser(null);
                throw e;
            }
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
