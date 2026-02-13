import React, { useEffect, useState } from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Loader2, Package } from 'lucide-react';
import { getLogs } from '../services/api';

export default function CalendarView() {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [deliveries, setDeliveries] = useState({});
    const [loading, setLoading] = useState(true);

    const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
    const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay();

    const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));

    const monthName = currentDate.toLocaleString('default', { month: 'long' });
    const year = currentDate.getFullYear();

    useEffect(() => {
        const fetchDeliveries = async () => {
            setLoading(true);

            try {
                const token = localStorage.getItem('token');
                const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).toISOString();
                const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59).toISOString();

                const logs = await getLogs(token, {
                    start_date: startOfMonth,
                    end_date: endOfMonth
                });

                const grouped = logs.reduce((acc, log) => {
                    const day = new Date(log.timestamp).getDate();
                    if (!acc[day]) {
                        acc[day] = [];
                    }
                    acc[day].push(log);
                    return acc;
                }, {});

                setDeliveries(grouped);
            } catch (err) {
                console.error('Failed to fetch monthly deliveries', err);
            } finally {
                setLoading(false);
            }
        };

        fetchDeliveries();
    }, [currentDate]);

    const days = [];

    for (let i = 0; i < firstDayOfMonth; i += 1) {
        days.push(<div key={`empty-${i}`} className="h-24" />);
    }

    for (let d = 1; d <= daysInMonth; d += 1) {
        const dayDeliveries = deliveries[d] || [];
        const hasDeliveries = dayDeliveries.length > 0;
        const isToday = d === new Date().getDate()
            && currentDate.getMonth() === new Date().getMonth()
            && currentDate.getFullYear() === new Date().getFullYear();

        days.push(
            <div key={d} className={`h-24 border-t border-gray-50 dark:border-gray-700/50 p-2 relative flex flex-col items-center justify-center gap-1 ${isToday ? 'bg-primary-50/50 dark:bg-primary-900/10' : ''}`}>
                <span className={`text-xs font-black absolute top-2 right-2 ${isToday ? 'text-primary-600' : 'text-gray-400'}`}>{d}</span>
                {hasDeliveries && (
                    <div className="flex flex-col items-center">
                        <div className="p-1.5 bg-primary-600 rounded-lg text-white shadow-lg shadow-primary-500/20">
                            <Package size={16} />
                        </div>
                        <span className="text-[9px] font-black text-primary-600 uppercase mt-1">{dayDeliveries.length} AWB</span>
                    </div>
                )}
            </div>
        );
    }

    const totalThisMonth = Object.values(deliveries).flat().length;

    return (
        <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
            <header className="p-6 bg-white dark:bg-gray-800 shadow-sm flex items-center justify-between sticky top-0 z-10">
                <h1 className="text-xl font-black text-gray-900 dark:text-white uppercase tracking-tight">Delivery Schedule</h1>
                <div className="p-2.5 bg-gray-100 dark:bg-gray-700 rounded-2xl text-gray-400">
                    <CalendarIcon size={20} />
                </div>
            </header>

            <div className="flex-1 p-4 pb-24">
                <div className="bg-white dark:bg-gray-800 rounded-[40px] shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
                    <div className="p-6 flex items-center justify-between bg-primary-600 text-white">
                        <button onClick={prevMonth} className="p-2 hover:bg-white/20 rounded-xl transition-colors"><ChevronLeft /></button>
                        <h2 className="text-lg font-black uppercase tracking-widest">{monthName} {year}</h2>
                        <button onClick={nextMonth} className="p-2 hover:bg-white/20 rounded-xl transition-colors"><ChevronRight /></button>
                    </div>

                    <div className="grid grid-cols-7 text-center py-4 bg-gray-50 dark:bg-gray-900/50 text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">
                        <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
                    </div>

                    <div className="grid grid-cols-7 relative min-h-[400px]">
                        {loading && (
                            <div className="absolute inset-0 bg-white/50 dark:bg-gray-800/50 z-10 flex items-center justify-center backdrop-blur-[2px]">
                                <Loader2 className="animate-spin text-primary-600" size={32} />
                            </div>
                        )}
                        {days}
                    </div>
                </div>

                <div className="mt-8 space-y-4">
                    <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Key Metrics</h3>
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-[32px] border border-gray-100 dark:border-gray-700 flex items-center gap-4">
                        <div className="p-4 bg-primary-50 dark:bg-primary-900/20 text-primary-600 rounded-2xl">
                            <Package size={24} />
                        </div>
                        <div>
                            <p className="text-sm font-black text-gray-900 dark:text-white">Active Month</p>
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">{totalThisMonth} Total Shipments Processed</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
