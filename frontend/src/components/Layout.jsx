import React from 'react';
import { Outlet } from 'react-router-dom';
import BottomNav from './BottomNav';

export default function Layout() {
    return (
        <div className="min-h-screen pb-32"> {/* Added more padding-bottom for floating nav */}
            <div className="max-w-xl mx-auto">
                <Outlet />
            </div>
            <BottomNav />
        </div>
    );
}
