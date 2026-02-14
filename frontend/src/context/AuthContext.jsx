import React, { createContext, useContext, useState, useEffect } from 'react';
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
        const token = localStorage.getItem('token');
        if (token) {
            const decoded = jwtDecode(token);
            if (decoded && decoded.sub) {
                // JWT payload structure: { sub: username, driver_id: id, role: role, exp: ... }
                setUser({
                    username: decoded.sub,
                    driver_id: decoded.driver_id,
                    role: decoded.role,
                    token: token
                });
            } else {
                console.warn("Invalid/undecodable token in localStorage; clearing it.");
                localStorage.removeItem('token');
            }
        }
        setLoading(false);
    }, []);

    const login = (token, role) => {
        localStorage.setItem('token', token);
        const decoded = jwtDecode(token);
        if (!decoded || !decoded.sub) {
            console.error("Login returned an invalid token; clearing it.");
            localStorage.removeItem('token');
            setUser(null);
            return;
        }
        setUser({
            username: decoded.sub,
            driver_id: decoded.driver_id,
            role: role || decoded.role,
            token: token
        });
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
