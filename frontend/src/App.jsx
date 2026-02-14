import React from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import Layout from './components/Layout';
import { useAuth } from './context/AuthContext';
import Home from './pages/Home';
import Login from './pages/Login';
import History from './pages/History';
import Settings from './pages/Settings';
import Shipments from './pages/Shipments';
import CalendarView from './pages/CalendarView';
import RoutesPage from './pages/Routes';
import RouteDetail from './pages/RouteDetail';

const ProtectedRoute = ({ children, allowedRoles }) => {
    const { user, loading } = useAuth();

    if (loading) {
        return <div>Loading...</div>;
    }

    if (!user) {
        return <Navigate to="/login" replace />;
    }

    if (allowedRoles && !allowedRoles.includes(user.role)) {
        return <Navigate to="/" replace />;
    }

    return children;
};

function App() {
    return (
        <HashRouter>
            <AnimatedRoutes />
        </HashRouter>
    );
}

const AnimatedRoutes = () => {
    const location = useLocation();

    return (
        <AnimatePresence mode="wait">
            <Routes location={location} key={location.pathname}>
                <Route path="/login" element={<Login />} />
                <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                    <Route path="/" element={<Home />} />
                    <Route path="/home" element={<Home />} />
                    <Route path="/history" element={<History />} />
                    <Route path="/shipments" element={<ProtectedRoute allowedRoles={["Manager", "Admin", "Driver"]}><Shipments /></ProtectedRoute>} />
                    <Route path="/routes" element={<ProtectedRoute allowedRoles={["Manager", "Admin", "Driver"]}><RoutesPage /></ProtectedRoute>} />
                    <Route path="/routes/:routeId" element={<ProtectedRoute allowedRoles={["Manager", "Admin", "Driver"]}><RouteDetail /></ProtectedRoute>} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/calendar" element={<CalendarView />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </AnimatePresence>
    );
};

export default App;
