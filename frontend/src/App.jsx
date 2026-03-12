import React, { Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import Layout from './components/Layout';
import { useAuth } from './context/AuthContext';
import { hasAllPermissions } from './auth/rbac';
import { normalizeRole, PERM_CHAT_READ, PERM_COD_READ, PERM_LIVEOPS_READ, PERM_LOGS_READ_SELF, PERM_MANIFESTS_READ, PERM_NOTIFICATIONS_READ, PERM_ROUTE_RUNS_WRITE, PERM_SHIPMENTS_READ, PERM_STATS_READ, PERM_USERS_READ } from './auth/permissions';

const Home = React.lazy(() => import('./pages/Home'));
const Login = React.lazy(() => import('./pages/Login'));
const RecipientSignup = React.lazy(() => import('./pages/RecipientSignup'));
const History = React.lazy(() => import('./pages/History'));
const Settings = React.lazy(() => import('./pages/Settings'));
const Shipments = React.lazy(() => import('./pages/Shipments'));
const CalendarView = React.lazy(() => import('./pages/CalendarView'));
const RoutesPage = React.lazy(() => import('./pages/Routes'));
const RouteDetail = React.lazy(() => import('./pages/RouteDetail'));
const RouteRun = React.lazy(() => import('./pages/RouteRun'));
const Analytics = React.lazy(() => import('./pages/Analytics'));
const Notifications = React.lazy(() => import('./pages/Notifications'));
const Users = React.lazy(() => import('./pages/Users'));
const Warehouses = React.lazy(() => import('./pages/Warehouses'));
const Tracking = React.lazy(() => import('./pages/Tracking'));
const ChatInbox = React.lazy(() => import('./pages/ChatInbox'));
const ChatThread = React.lazy(() => import('./pages/ChatThread'));
const Assistant = React.lazy(() => import('./pages/Assistant'));
const Manifests = React.lazy(() => import('./pages/Manifests'));
const LiveOps = React.lazy(() => import('./pages/LiveOps'));
const Finance = React.lazy(() => import('./pages/Finance'));
const Fleet = React.lazy(() => import('./pages/Fleet'));
const BIB = React.lazy(() => import('./pages/BIB'));
const Manual = React.lazy(() => import('./pages/Manual'));

const AccessDenied = ({ message = 'Nu ai acces la acest modul cu rolul curent.' }) => (
    <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-slate-700/60 bg-slate-900/70 p-6 text-center">
            <h2 className="text-xl font-semibold text-white mb-2">Acces restricționat</h2>
            <p className="text-sm text-slate-300">{message}</p>
        </div>
    </div>
);

const ProtectedRoute = ({ children, allowedRoles, blockedRoles, allowedPermissions }) => {
    const { user, loading } = useAuth();

    if (loading) {
        return <div>Loading...</div>;
    }

    if (!user) {
        return <Navigate to="/login" replace />;
    }

    const role = normalizeRole(user?.role);

    if (allowedRoles && !allowedRoles.includes(role)) {
        return <AccessDenied />;
    }

    if (blockedRoles && blockedRoles.includes(role)) {
        return <AccessDenied />;
    }

    if (allowedPermissions && !hasAllPermissions(user, allowedPermissions)) {
        return <AccessDenied />;
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
            <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-sm text-slate-400">Loading...</div>}>
                <Routes location={location} key={location.pathname}>
                    <Route path="/login" element={<Login />} />
                    <Route path="/signup" element={<RecipientSignup />} />
                    <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                        <Route path="/" element={<Home />} />
                        <Route path="/home" element={<Home />} />
                        <Route path="/history" element={<ProtectedRoute allowedPermissions={[PERM_LOGS_READ_SELF]} blockedRoles={['Driver']}><History /></ProtectedRoute>} />
                        <Route path="/shipments" element={<ProtectedRoute allowedPermissions={[PERM_SHIPMENTS_READ]} blockedRoles={['Driver']}><Shipments /></ProtectedRoute>} />
                        <Route path="/routes" element={<ProtectedRoute allowedRoles={["Manager", "Admin", "Dispatcher", "Driver"]}><RoutesPage /></ProtectedRoute>} />
                        <Route path="/routes/:routeId" element={<ProtectedRoute allowedRoles={["Manager", "Admin", "Dispatcher", "Driver"]}><RouteDetail /></ProtectedRoute>} />
                        <Route path="/routes/:routeId/run" element={<ProtectedRoute allowedPermissions={[PERM_ROUTE_RUNS_WRITE]}><RouteRun /></ProtectedRoute>} />
                        <Route path="/users" element={<ProtectedRoute allowedPermissions={[PERM_USERS_READ]}><Users /></ProtectedRoute>} />
                        <Route path="/warehouses" element={<ProtectedRoute allowedPermissions={[PERM_USERS_READ]} blockedRoles={['Driver', 'Recipient']}><Warehouses /></ProtectedRoute>} />
                        <Route path="/notifications" element={<ProtectedRoute allowedPermissions={[PERM_NOTIFICATIONS_READ]} blockedRoles={['Driver']}><Notifications /></ProtectedRoute>} />
                        <Route path="/chat" element={<ProtectedRoute allowedPermissions={[PERM_CHAT_READ]} blockedRoles={['Driver']}><ChatInbox /></ProtectedRoute>} />
                        <Route path="/chat/:threadId" element={<ProtectedRoute allowedPermissions={[PERM_CHAT_READ]} blockedRoles={['Driver']}><ChatThread /></ProtectedRoute>} />
                        <Route path="/assistant" element={<ProtectedRoute allowedPermissions={[PERM_CHAT_READ]}><Assistant /></ProtectedRoute>} />
                        <Route path="/tracking/:requestId" element={<ProtectedRoute><Tracking /></ProtectedRoute>} />
                        <Route path="/manifests" element={<ProtectedRoute allowedPermissions={[PERM_MANIFESTS_READ]} blockedRoles={['Driver']}><Manifests /></ProtectedRoute>} />
                        <Route path="/live" element={<ProtectedRoute allowedPermissions={[PERM_LIVEOPS_READ]} blockedRoles={['Driver']}><LiveOps /></ProtectedRoute>} />
                        <Route path="/finance" element={<ProtectedRoute allowedPermissions={[PERM_COD_READ]} blockedRoles={['Driver']}><Finance /></ProtectedRoute>} />
                        <Route path="/fleet" element={<ProtectedRoute allowedPermissions={[PERM_SHIPMENTS_READ]} blockedRoles={['Driver']}><Fleet /></ProtectedRoute>} />
                        <Route path="/bib" element={<ProtectedRoute allowedPermissions={[PERM_SHIPMENTS_READ]} blockedRoles={['Driver']}><BIB /></ProtectedRoute>} />
                        <Route path="/manual" element={<Manual />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/calendar" element={<ProtectedRoute allowedPermissions={[PERM_SHIPMENTS_READ]} blockedRoles={['Driver']}><CalendarView /></ProtectedRoute>} />
                        <Route path="/analytics" element={<ProtectedRoute allowedPermissions={[PERM_STATS_READ]} blockedRoles={['Driver']}><Analytics /></ProtectedRoute>} />
                    </Route>
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </Suspense>
        </AnimatePresence>
    );
};

export default App;
