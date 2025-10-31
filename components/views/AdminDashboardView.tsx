import React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { getAllUsers, updateUserStatus, replaceUsers, exportAllUserData } from '../../services/userService';
import { type User, type UserStatus } from '../../types';
import { UsersIcon, XIcon, DownloadIcon, UploadIcon, CheckCircleIcon } from '../Icons';
import Spinner from '../common/Spinner';
import ApiHealthCheckModal from '../common/ApiHealthCheckModal';

const formatStatus = (user: User): { text: string; color: 'green' | 'yellow' | 'red' | 'blue' } => {
    switch(user.status) {
        case 'admin':
            return { text: 'Admin', color: 'blue' };
        case 'lifetime':
            return { text: 'Lifetime', color: 'green' };
        case 'subscription':
            return { text: 'Subscription', color: 'green' };
        case 'trial':
            return { text: 'Trial', color: 'yellow' };
        case 'inactive':
            return { text: 'Inactive', color: 'red' };
        default:
            return { text: 'Unknown', color: 'red' };
    }
};

const statusColors: Record<'green' | 'yellow' | 'red' | 'blue', string> = {
    green: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
    yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
    blue: 'bg-primary-100 text-primary-800 dark:bg-primary-900/50 dark:text-primary-300',
};

const TrialCountdown: React.FC<{ expiry: number }> = ({ expiry }) => {
    const calculateRemainingTime = useCallback(() => {
        const now = Date.now();
        const timeLeft = expiry - now;

        if (timeLeft <= 0) {
            return { text: 'Expired', color: 'red' as const };
        }

        const minutes = Math.floor((timeLeft / 1000 / 60) % 60);
        const seconds = Math.floor((timeLeft / 1000) % 60);

        return { text: `Expires in ${minutes}m ${seconds}s`, color: 'yellow' as const };
    }, [expiry]);
    
    const [timeInfo, setTimeInfo] = useState(calculateRemainingTime());

    useEffect(() => {
        const timer = setInterval(() => {
            setTimeInfo(calculateRemainingTime());
        }, 1000);

        return () => clearInterval(timer);
    }, [expiry, calculateRemainingTime]);

    return (
        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${statusColors[timeInfo.color]}`}>
            {timeInfo.text}
        </span>
    );
};


const AdminDashboardView: React.FC = () => {
    const [users, setUsers] = useState<User[] | null>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedUser, setSelectedUser] = useState<User | null>(null);
    const [newStatus, setNewStatus] = useState<UserStatus>('trial');
    const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [isHealthModalOpen, setIsHealthModalOpen] = useState(false);
    const [userForHealthCheck, setUserForHealthCheck] = useState<User | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const fetchUsers = useCallback(async () => {
        setLoading(true);
        const allUsers = await getAllUsers();
        if (allUsers) {
            // Sort by created_at descending (newest first)
            const sortedUsers = allUsers.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            setUsers(sortedUsers.filter(user => user.role !== 'admin'));
        } else {
            setUsers(null);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchUsers();
    }, [fetchUsers]);

    const openEditModal = (user: User) => {
        setSelectedUser(user);
        setNewStatus(user.status);
        setIsModalOpen(true);
    };

    const handleSaveStatus = async () => {
        if (!selectedUser) return;
        
        if (await updateUserStatus(selectedUser.id, newStatus)) {
            fetchUsers();
            setStatusMessage({ type: 'success', message: `Status for ${selectedUser.username} has been updated.` });
        } else {
            setStatusMessage({ type: 'error', message: 'Failed to update status.' });
        }
        setIsModalOpen(false);
        setSelectedUser(null);
        setTimeout(() => setStatusMessage(null), 4000);
    };
    

    const handleExport = async () => {
        setStatusMessage(null);
        const usersToExport = await exportAllUserData();
        if (!usersToExport) {
            setStatusMessage({ type: 'error', message: 'Export failed: User database is corrupted.' });
            setTimeout(() => setStatusMessage(null), 4000);
            return;
        }

        try {
            const dataStr = JSON.stringify(usersToExport, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            const timestamp = new Date().toISOString().split('T')[0];
            link.download = `monoklix-users-backup-${timestamp}.json`;
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            setStatusMessage({ type: 'success', message: 'User data exported successfully.' });
        } catch (error) {
             setStatusMessage({ type: 'error', message: 'Failed to create export file.' });
        }
        setTimeout(() => setStatusMessage(null), 4000);
    };

    const handleImportClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        setStatusMessage(null);
        const file = event.target.files?.[0];
        if (!file) return;

        if (!window.confirm("Are you sure you want to replace all existing user data with the contents of this file? This action cannot be undone.")) {
            if(event.target) event.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const text = e.target?.result;
                if (typeof text !== 'string') throw new Error("Failed to read file.");
                
                const importedUsers = JSON.parse(text);
                const result = await replaceUsers(importedUsers);

                if (result.success) {
                    setStatusMessage({ type: 'success', message: result.message });
                    fetchUsers(); // Refresh the view
                } else {
                    setStatusMessage({ type: 'error', message: result.message });
                }
            } catch (error) {
                setStatusMessage({ type: 'error', message: `Error importing file: ${error instanceof Error ? error.message : 'Invalid file format.'}` });
            } finally {
                 if(event.target) event.target.value = '';
                 setTimeout(() => setStatusMessage(null), 5000);
            }
        };
        reader.readAsText(file);
    };


    const filteredUsers = users
        ? users.filter(user =>
              (user.username || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
              (user.email || '').toLowerCase().includes(searchTerm.toLowerCase())
          )
        : [];
    
    if (loading) {
        return <div>Loading users...</div>;
    }

    if (users === null) {
        return (
            <div className="bg-red-100 dark:bg-red-900/50 border border-red-400 text-red-700 dark:text-red-300 px-4 py-3 rounded-lg" role="alert">
                <strong className="font-bold">Critical Error:</strong>
                <span className="block sm:inline"> The user database is corrupted and could not be read. Please contact support.</span>
            </div>
        );
    }

    return (
        <>
            <div className="bg-white dark:bg-neutral-900 p-6 rounded-lg shadow-sm">
                <h2 className="text-xl font-semibold mb-2">User Database</h2>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-6">Manage users, subscriptions, and database backups.</p>
                
                <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
                    <input
                        type="text"
                        placeholder="Search by username or email..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full max-w-sm bg-white dark:bg-neutral-800/50 border border-neutral-300 dark:border-neutral-700 rounded-lg p-2 focus:ring-2 focus:ring-primary-500 focus:outline-none transition"
                    />
                    <div className="flex gap-2">
                         <button onClick={() => { setUserForHealthCheck(null); setIsHealthModalOpen(true); }} className="flex items-center gap-2 text-sm bg-blue-600 text-white font-semibold py-2 px-3 rounded-lg hover:bg-blue-700 transition-colors">
                            <CheckCircleIcon className="w-4 h-4" />
                            API Health Summary
                        </button>
                        <input type="file" ref={fileInputRef} onChange={handleFileImport} accept=".json" className="hidden" />
                        <button onClick={handleImportClick} className="flex items-center gap-2 text-sm bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200 font-semibold py-2 px-3 rounded-lg hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors">
                            <UploadIcon className="w-4 h-4" />
                            Import
                        </button>
                        <button onClick={handleExport} className="flex items-center gap-2 text-sm bg-primary-600 text-white font-semibold py-2 px-3 rounded-lg hover:bg-primary-700 transition-colors">
                            <DownloadIcon className="w-4 h-4" />
                            Export
                        </button>
                    </div>
                </div>

                 {statusMessage && (
                    <div className={`p-3 rounded-md mb-4 text-sm ${statusMessage.type === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'}`}>
                        {statusMessage.message}
                    </div>
                )}

                <div className="bg-white dark:bg-neutral-950 rounded-lg shadow-inner">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left text-neutral-500 dark:text-neutral-400">
                            <thead className="text-xs text-neutral-700 uppercase bg-neutral-100 dark:bg-neutral-800/50 dark:text-neutral-400">
                                <tr>
                                    <th scope="col" className="px-4 py-3">#</th>
                                    <th scope="col" className="px-6 py-3">
                                        Username
                                    </th>
                                    <th scope="col" className="px-6 py-3">
                                        Email
                                    </th>
                                    <th scope="col" className="px-6 py-3">
                                        Phone Number
                                    </th>
                                    <th scope="col" className="px-6 py-3">
                                        Account Status
                                    </th>
                                    <th scope="col" className="px-6 py-3">
                                        Action
                                    </th>
                                    <th scope="col" className="px-6 py-3">
                                        API Check
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredUsers.length > 0 ? (
                                    filteredUsers.map((user, index) => {
                                        const { text, color } = formatStatus(user);
                                        return (
                                            <tr key={user.id} className="bg-white dark:bg-neutral-950 border-b dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                                                <td className="px-4 py-4 font-medium text-neutral-600 dark:text-neutral-400">{index + 1}</td>
                                                <th scope="row" className="px-6 py-4 font-medium text-neutral-900 whitespace-nowrap dark:text-white">
                                                    {user.username || '-'}
                                                </th>
                                                <td className="px-6 py-4">
                                                    {user.email || '-'}
                                                </td>
                                                <td className="px-6 py-4">
                                                    {user.phone || '-'}
                                                </td>
                                                <td className="px-6 py-4">
                                                    {user.status === 'trial' && user.subscriptionExpiry ? (
                                                        <TrialCountdown expiry={user.subscriptionExpiry} />
                                                    ) : (
                                                        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${statusColors[color]}`}>
                                                            {text}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4">
                                                    <button 
                                                        onClick={() => openEditModal(user)}
                                                        className="font-medium text-primary-600 dark:text-primary-500 hover:underline"
                                                    >
                                                        Update
                                                    </button>
                                                </td>
                                                <td className="px-6 py-4 text-center">
                                                     <button
                                                        onClick={() => { setUserForHealthCheck(user); setIsHealthModalOpen(true); }}
                                                        className="font-medium text-blue-600 dark:text-blue-500 hover:underline"
                                                        title={'Check API health'}
                                                    >
                                                        Check
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })
                                ) : (
                                    <tr>
                                        <td colSpan={7} className="text-center py-10">
                                            {users.length > 0 ? (
                                                <div>
                                                    <p className="mt-2 font-semibold">No users found.</p>
                                                    <p className="text-xs">No users match "{searchTerm}".</p>
                                                </div>
                                            ) : (
                                                <div>
                                                    <UsersIcon className="w-12 h-12 mx-auto text-neutral-400" />
                                                    <p className="mt-2 font-semibold">No registered users yet.</p>
                                                    <p className="text-xs">When new users register, they will appear here.</p>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            {isModalOpen && selectedUser && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" aria-modal="true" role="dialog">
                    <div className="bg-white dark:bg-neutral-800 rounded-lg shadow-xl p-6 w-full max-w-md m-4">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-bold">Edit User Status</h3>
                            <button onClick={() => setIsModalOpen(false)} className="p-1 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700">
                                <XIcon className="w-5 h-5" />
                            </button>
                        </div>
                        <p className="mb-4 text-sm">Updating status for <span className="font-semibold">{selectedUser.username}</span>.</p>
                        <div className="space-y-4">
                            <div>
                                <label htmlFor="status-select" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                                    Account Status
                                </label>
                                <select
                                    id="status-select"
                                    value={newStatus}
                                    onChange={(e) => setNewStatus(e.target.value as UserStatus)}
                                    className="w-full bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 rounded-lg p-2 focus:ring-2 focus:ring-primary-500 focus:outline-none"
                                >
                                    <option value="trial">Trial</option>
                                    <option value="subscription">Subscription</option>
                                    <option value="lifetime">Lifetime</option>
                                    <option value="inactive">Inactive</option>
                                </select>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-2">
                                <button
                                    onClick={() => setIsModalOpen(false)}
                                    className="px-4 py-2 text-sm font-semibold bg-neutral-200 dark:bg-neutral-600 rounded-lg hover:bg-neutral-300 dark:hover:bg-neutral-500 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSaveStatus}
                                    className="px-4 py-2 text-sm font-semibold text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                                >
                                    Update Status
                                </button>
                        </div>
                    </div>
                </div>
            )}

            {isHealthModalOpen && (
                <ApiHealthCheckModal
                    isOpen={isHealthModalOpen}
                    onClose={() => {
                        setIsHealthModalOpen(false);
                        setUserForHealthCheck(null);
                    }}
                    user={userForHealthCheck}
                />
            )}
        </>
    );
};

export default AdminDashboardView;