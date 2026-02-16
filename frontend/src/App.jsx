import React from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import Layout from './components/Layout';
import { useAuth } from './context/AuthContext';
import { hasAllPermissions } from './auth/rbac';
import { PERM_CHAT_READ, PERM_COD_READ, PERM_LIVEOPS_READ, PERM_LOGS_READ_SELF, PERM_MANIFESTS_READ, PERM_NOTIFICATIONS_READ, PERM_ROUTE_RUNS_WRITE, PERM_SHIPMENTS_READ, PERM_STATS_READ, PERM_USERS_READ } from './auth/permissions';
import Home from './pages/Home';
import Login from './pages/Login';
import RecipientSignup from './pages/RecipientSignup';
import History from './pages/History';
import Settings from './pages/Settings';
import Shipments from './pages/Shipments';
import CalendarView from './pages/CalendarView';
import RoutesPage from './pages/Routes';
import RouteDetail from './pages/RouteDetail';
import RouteRun from './pages/RouteRun';
import Analytics from './pages/Analytics';
import Notifications from './pages/Notifications';
import Users from './pages/Users';
import Tracking from './pages/Tracking';
import ChatInbox from './pages/ChatInbox';
import ChatThread from './pages/ChatThread';
import Manifests from './pages/Manifests';
import LiveOps from './pages/LiveOps';
import Finance from './pages/Finance';

const ProtectedRoute = ({ children, allowedRoles, allowedPermissions }) => {
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

    if (allowedPermissions && !hasAllPermissions(user, allowedPermissions)) {
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
                <Route path="/signup" element={<RecipientSignup />} />
                <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                    <Route path="/" element={<Home />} />
                    <Route path="/home" element={<Home />} />
                    <Route path="/history" element={<ProtectedRoute allowedPermissions={[PERM_LOGS_READ_SELF]}><History /></ProtectedRoute>} />
                    <Route path="/shipments" element={<ProtectedRoute allowedPermissions={[PERM_SHIPMENTS_READ]}><Shipments /></ProtectedRoute>} />
                    <Route path="/routes" element={<ProtectedRoute allowedRoles={["Manager", "Admin", "Dispatcher", "Driver"]}><RoutesPage /></ProtectedRoute>} />
                    <Route path="/routes/:routeId" element={<ProtectedRoute allowedRoles={["Manager", "Admin", "Dispatcher", "Driver"]}><RouteDetail /></ProtectedRoute>} />
                    <Route path="/routes/:routeId/run" element={<ProtectedRoute allowedPermissions={[PERM_ROUTE_RUNS_WRITE]}><RouteRun /></ProtectedRoute>} />
                    <Route path="/users" element={<ProtectedRoute allowedPermissions={[PERM_USERS_READ]}><Users /></ProtectedRoute>} />
                    <Route path="/notifications" element={<ProtectedRoute allowedPermissions={[PERM_NOTIFICATIONS_READ]}><Notifications /></ProtectedRoute>} />
                    <Route path="/chat" element={<ProtectedRoute allowedPermissions={[PERM_CHAT_READ]}><ChatInbox /></ProtectedRoute>} />
                    <Route path="/chat/:threadId" element={<ProtectedRoute allowedPermissions={[PERM_CHAT_READ]}><ChatThread /></ProtectedRoute>} />
                    <Route path="/tracking/:requestId" element={<ProtectedRoute><Tracking /></ProtectedRoute>} />
                    <Route path="/manifests" element={<ProtectedRoute allowedPermissions={[PERM_MANIFESTS_READ]}><Manifests /></ProtectedRoute>} />
                    <Route path="/live" element={<ProtectedRoute allowedPermissions={[PERM_LIVEOPS_READ]}><LiveOps /></ProtectedRoute>} />
                    <Route path="/finance" element={<ProtectedRoute allowedPermissions={[PERM_COD_READ]}><Finance /></ProtectedRoute>} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/calendar" element={<ProtectedRoute allowedPermissions={[PERM_SHIPMENTS_READ]}><CalendarView /></ProtectedRoute>} />
                    <Route path="/analytics" element={<ProtectedRoute allowedPermissions={[PERM_STATS_READ]}><Analytics /></ProtectedRoute>} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </AnimatePresence>
    );
};

export default App;
