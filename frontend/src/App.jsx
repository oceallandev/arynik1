import React, { Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import Layout from './components/Layout';
import { useAuth } from './context/AuthContext';
import { hasAllPermissions } from './auth/rbac';
import { normalizeRole, PERM_CHAT_READ, PERM_COD_READ, PERM_LIVEOPS_READ, PERM_LOGS_READ_SELF, PERM_MANIFESTS_READ, PERM_NOTIFICATIONS_READ, PERM_ROUTE_RUNS_WRITE, PERM_SHIPMENTS_READ, PERM_STATS_READ, PERM_USERS_READ } from './auth/permissions';

const LAZY_IMPORT_RELOAD_KEY_PREFIX = 'arynik_lazy_import_reload_v1';

const lazyImportErrorLooksRecoverable = (error) => {
    const text = `${String(error?.name || '')} ${String(error?.message || '')}`.toLowerCase();
    return (
        text.includes('failed to fetch dynamically imported module')
        || text.includes('importing a module script failed')
        || text.includes('chunkloaderror')
        || text.includes('loading chunk')
        || text.includes('module script')
        || text.includes(' 404 ')
        || text.includes('404')
    );
};

const lazyWithReloadRetry = (loader, pageKey) => React.lazy(async () => {
    try {
        return await loader();
    } catch (error) {
        if (typeof window !== 'undefined' && lazyImportErrorLooksRecoverable(error)) {
            const marker = `${LAZY_IMPORT_RELOAD_KEY_PREFIX}:${String(pageKey || 'page')}`;
            const buildId = String((typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : '') || 'build');
            let alreadyRetried = false;
            try {
                alreadyRetried = sessionStorage.getItem(marker) === buildId;
            } catch {
                alreadyRetried = false;
            }

            if (!alreadyRetried) {
                try {
                    sessionStorage.setItem(marker, buildId);
                } catch { }
                try {
                    const url = new URL(window.location.href);
                    url.searchParams.set('v', buildId || String(Date.now()));
                    window.location.replace(url.toString());
                } catch {
                    window.location.reload();
                }
                await new Promise(() => { });
            }
        }
        throw error;
    }
});

const Home = lazyWithReloadRetry(() => import('./pages/Home'), 'home');
const Login = lazyWithReloadRetry(() => import('./pages/Login'), 'login');
const RecipientSignup = lazyWithReloadRetry(() => import('./pages/RecipientSignup'), 'signup');
const History = lazyWithReloadRetry(() => import('./pages/History'), 'history');
const Settings = lazyWithReloadRetry(() => import('./pages/Settings'), 'settings');
const Shipments = lazyWithReloadRetry(() => import('./pages/Shipments'), 'shipments');
const CalendarView = lazyWithReloadRetry(() => import('./pages/CalendarView'), 'calendar');
const RoutesPage = lazyWithReloadRetry(() => import('./pages/Routes'), 'routes');
const RouteDetail = lazyWithReloadRetry(() => import('./pages/RouteDetail'), 'route-detail');
const RouteRun = lazyWithReloadRetry(() => import('./pages/RouteRun'), 'route-run');
const Analytics = lazyWithReloadRetry(() => import('./pages/Analytics'), 'analytics');
const Notifications = lazyWithReloadRetry(() => import('./pages/Notifications'), 'notifications');
const Users = lazyWithReloadRetry(() => import('./pages/Users'), 'users');
const Warehouses = lazyWithReloadRetry(() => import('./pages/Warehouses'), 'warehouses');
const Tracking = lazyWithReloadRetry(() => import('./pages/Tracking'), 'tracking');
const ChatInbox = lazyWithReloadRetry(() => import('./pages/ChatInbox'), 'chat-inbox');
const ChatThread = lazyWithReloadRetry(() => import('./pages/ChatThread'), 'chat-thread');
const Assistant = lazyWithReloadRetry(() => import('./pages/Assistant'), 'assistant');
const Manifests = lazyWithReloadRetry(() => import('./pages/Manifests'), 'manifests');
const LiveOps = lazyWithReloadRetry(() => import('./pages/LiveOps'), 'liveops');
const Finance = lazyWithReloadRetry(() => import('./pages/Finance'), 'finance');
const Fleet = lazyWithReloadRetry(() => import('./pages/Fleet'), 'fleet');
const BIB = lazyWithReloadRetry(() => import('./pages/BIB'), 'bib');
const Manual = lazyWithReloadRetry(() => import('./pages/Manual'), 'manual');

class RouteErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error) {
        // eslint-disable-next-line no-console
        console.error('Route render error:', error);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen flex items-center justify-center p-6">
                    <div className="max-w-md w-full rounded-2xl border border-slate-700/60 bg-slate-900/80 p-6 text-center space-y-3">
                        <h2 className="text-lg font-black text-white">Pagina nu s-a incarcat</h2>
                        <p className="text-sm text-slate-300">A aparut o eroare la navigare. Reincarcam aplicatia.</p>
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-black uppercase tracking-wider"
                        >
                            Reincarca
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

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
            <RouteErrorBoundary>
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
            </RouteErrorBoundary>
        </AnimatePresence>
    );
};

export default App;
