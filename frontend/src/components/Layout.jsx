import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import BottomNav from './BottomNav';
import MenuDrawer from './MenuDrawer';
import ChatNotificationListener from './ChatNotificationListener';
import TrackingRequestListener from './TrackingRequestListener';

export default function Layout() {
    const [menuOpen, setMenuOpen] = useState(false);

    return (
        <div className="min-h-screen pb-[calc(8rem+env(safe-area-inset-bottom))]"> {/* Safe-area for iOS/Android browser chrome */}
            <div className="max-w-xl mx-auto">
                <Outlet context={{ openMenu: () => setMenuOpen(true) }} />
            </div>
            <BottomNav onOpenMenu={() => setMenuOpen(true)} />
            <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />
            <ChatNotificationListener />
            <TrackingRequestListener />
        </div>
    );
}
