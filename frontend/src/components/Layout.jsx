import React from 'react';
import { Outlet } from 'react-router-dom';
import BottomNav from './BottomNav';

export default function Layout() {
    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 pb-20">
            <Outlet />
            <BottomNav />
        </div>
    );
}
