import React, { useState, useEffect, useRef } from 'react';
import { KeyIcon, CheckCircleIcon, XIcon, AlertTriangleIcon, RefreshCwIcon, SparklesIcon } from './Icons';
import Spinner from './common/Spinner';
import { runApiHealthCheck, type HealthCheckResult, isImageModelHealthy } from '../services/geminiService';
import { type User } from '../types';
import { getAvailableApiKeys, claimApiKey, type AvailableApiKey } from '../services/userService';
import eventBus from '../services/eventBus';

interface ApiKeyStatusProps {
    activeApiKey: string | null;
    veoTokenRefreshedAt: string | null;
    currentUser: User;
}

const ApiKeyStatus: React.FC<ApiKeyStatusProps> = ({ activeApiKey, veoTokenRefreshedAt, currentUser }) => {
    const [isPopoverOpen, setIsPopoverOpen] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const [results, setResults] = useState<HealthCheckResult[] | null>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [veoTokenCreatedAt, setVeoTokenCreatedAt] = useState<string | null>(null);

    // New state for key claiming
    const [isLoading, setIsLoading] = useState(false);
    const [availableKeys, setAvailableKeys] = useState<AvailableApiKey[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [autoSelectStatus, setAutoSelectStatus] = useState<'idle' | 'loading' | 'success' | 'failed'>('idle');

    useEffect(() => {
        // Read from sessionStorage whenever the refresh trigger changes
        const createdAt = sessionStorage.getItem('veoAuthTokenCreatedAt');
        setVeoTokenCreatedAt(createdAt);
    }, [veoTokenRefreshedAt]);

    const handleHealthCheck = async () => {
        setIsChecking(true);
        setResults(null);
        try {
            const checkResults = await runApiHealthCheck({
                textKey: activeApiKey || undefined,
            });
            setResults(checkResults);
        } catch (error) {
            setResults([{ service: 'Health Check Failed', model: 'N/A', status: 'error', message: error instanceof Error ? error.message : 'Unknown error' }]);
        } finally {
            setIsChecking(false);
        }
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsPopoverOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const getStatusUi = (status: HealthCheckResult['status']) => {
        switch (status) {
            case 'operational': return { icon: <CheckCircleIcon className="w-5 h-5 text-green-500"/>, text: 'text-green-700 dark:text-green-300' };
            case 'error': return { icon: <XIcon className="w-5 h-5 text-red-500"/>, text: 'text-red-700 dark:text-red-300' };
            case 'degraded': return { icon: <AlertTriangleIcon className="w-5 h-5 text-yellow-500"/>, text: 'text-yellow-700 dark:text-yellow-300' };
            default: return { icon: null, text: '' };
        }
    };

    const handleAutoSelect = async () => {
        setAutoSelectStatus('loading');
        setError(null);
        setStatusMessage(null);
        setAvailableKeys([]);
        try {
            const keys = await getAvailableApiKeys();
            let healthyKey: string | null = null;
            
            for (const key of keys) {
                if (await isImageModelHealthy(key.apiKey)) {
                    const claimResult = await claimApiKey(key.id, currentUser.id, currentUser.username);
                    if (claimResult.success) {
                        healthyKey = key.apiKey;
                        break; 
                    }
                }
            }

            if (healthyKey) {
                eventBus.dispatch('tempKeyClaimed', healthyKey);
                setStatusMessage('A new, healthy API key has been applied automatically!');
                setAutoSelectStatus('success');
                setTimeout(() => setIsPopoverOpen(false), 2000);
            } else {
                setError('Auto-select failed. No healthy API keys found. Please try the manual list.');
                setAutoSelectStatus('failed');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'An unknown error occurred.';
            setError(`Auto-select failed: ${message}`);
            setAutoSelectStatus('failed');
        } finally {
            setTimeout(() => setAutoSelectStatus('idle'), 4000);
        }
    };
    
    const handleFetchKeys = async () => {
        setIsLoading(true);
        setError(null);
        setAvailableKeys([]);
        setStatusMessage(null);
        try {
            const keys = await getAvailableApiKeys();
            setAvailableKeys(keys);
            if (keys.length === 0) {
                setStatusMessage('No new keys are available right now. Please try again later.');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'An unknown error occurred.';
            setError(`Failed to fetch keys: ${message}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleClaimKey = async (key: AvailableApiKey) => {
        setIsLoading(true);
        setError(null);
        setStatusMessage(null);

        const claimResult = await claimApiKey(key.id, currentUser.id, currentUser.username);
        if (!claimResult.success) {
            setError(`Failed to claim key: ${claimResult.message || 'Unknown error'}`);
            setIsLoading(false);
            return;
        }
        
        eventBus.dispatch('tempKeyClaimed', key.apiKey);
        
        setStatusMessage('Key claimed and applied successfully!');
        setAvailableKeys([]);
        setIsLoading(false);
        setTimeout(() => setIsPopoverOpen(false), 2000);
    };

    return (
        <div className="relative" ref={popoverRef}>
            <button
                onClick={() => setIsPopoverOpen(!isPopoverOpen)}
                className="p-2 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                aria-label="API Key Status"
            >
                <KeyIcon className={`w-5 h-5 ${activeApiKey ? 'text-green-500' : 'text-red-500'}`} />
            </button>

            {isPopoverOpen && (
                <div className="absolute top-full right-0 mt-2 w-80 sm:w-96 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl z-20 animate-zoomIn p-4">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-bold text-lg">API Status</h3>
                        <button onClick={() => setIsPopoverOpen(false)} className="p-1 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800"><XIcon className="w-4 h-4" /></button>
                    </div>

                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between items-center p-2 bg-neutral-100 dark:bg-neutral-800 rounded-md">
                            <span className="font-semibold text-neutral-600 dark:text-neutral-300">Gemini Key:</span>
                            {activeApiKey ? (
                                <span className="font-mono text-green-600 dark:text-green-400">...{activeApiKey.slice(-4)}</span>
                            ) : (
                                <span className="text-red-500 font-semibold">Not Set</span>
                            )}
                        </div>
                         <div className="flex justify-between items-center p-2 bg-neutral-100 dark:bg-neutral-800 rounded-md">
                            <span className="font-semibold text-neutral-600 dark:text-neutral-300">Veo 3 Date:</span>
                            {veoTokenCreatedAt ? (
                                <span className="text-neutral-700 dark:text-neutral-300">{new Date(veoTokenCreatedAt).toLocaleDateString()}</span>
                            ) : (
                                <span className="text-yellow-500 font-semibold">Not Set</span>
                            )}
                        </div>
                    </div>

                    <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center mb-3">
                            If you have issues, claim a new temporary key below.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-3">
                            <button 
                                onClick={handleAutoSelect} 
                                disabled={isLoading || autoSelectStatus === 'loading'}
                                className="w-full flex items-center justify-center gap-2 bg-primary-600 text-white font-semibold py-2 px-4 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
                            >
                                {autoSelectStatus === 'loading' ? <Spinner/> : <SparklesIcon className="w-5 h-5"/>}
                                Auto New Key
                            </button>
                             <button 
                                onClick={handleFetchKeys} 
                                disabled={isLoading || autoSelectStatus === 'loading'}
                                className="w-full flex items-center justify-center gap-2 bg-neutral-200 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 font-semibold py-2 px-4 rounded-lg hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors disabled:opacity-50"
                            >
                                {isLoading && availableKeys.length === 0 ? <Spinner/> : 'Show Manual List'}
                            </button>
                        </div>
                        {error && <p className="mt-2 text-red-500 text-xs">{error}</p>}
                        {statusMessage && <p className="mt-2 text-green-600 text-xs">{statusMessage}</p>}
                        {autoSelectStatus === 'success' && <p className="mt-2 text-green-600 text-xs">A new, healthy API key has been applied automatically!</p>}
                        {autoSelectStatus === 'failed' && <p className="mt-2 text-red-500 text-xs">Auto-select failed. No healthy API keys found. Please try the manual list.</p>}
                    </div>

                    {availableKeys.length > 0 && !isLoading && (
                        <div className="mt-4 border-t border-neutral-200 dark:border-neutral-700 pt-4 space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                            {availableKeys.map(key => (
                                <div key={key.id} className="bg-neutral-100 dark:bg-neutral-800 rounded-lg p-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="font-mono text-xs text-neutral-700 dark:text-neutral-300">
                                            ...{key.apiKey.slice(-4)}
                                        </p>
                                        <button 
                                            onClick={() => handleClaimKey(key)}
                                            className="text-xs font-semibold py-1 px-3 rounded-full bg-primary-600 text-white hover:bg-primary-700 transition-colors"
                                        >
                                            Claim
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    
                    <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
                      <button
                          onClick={handleHealthCheck}
                          disabled={isChecking || !activeApiKey}
                          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-semibold py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                      >
                          {isChecking ? <Spinner /> : <RefreshCwIcon className="w-4 h-4" />}
                          Run Full Health Check
                      </button>
                    </div>

                    {results && (
                        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 max-h-60 overflow-y-auto custom-scrollbar space-y-2">
                            {results.map((result, index) => {
                                const { icon, text } = getStatusUi(result.status);
                                return (
                                    <div key={index} className="p-2 bg-neutral-50 dark:bg-neutral-800 rounded-md">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex-1">
                                                <p className="font-semibold text-xs">{result.service}</p>
                                                <p className="text-xs text-neutral-500 font-mono truncate">{result.model}</p>
                                            </div>
                                            <div className={`flex items-center gap-1.5 font-semibold text-xs capitalize ${text}`}>
                                                {icon}
                                                {result.status}
                                            </div>
                                        </div>
                                         {(result.message !== 'OK' || result.details) && (
                                            <div className="text-xs mt-1 pt-1 border-t border-neutral-200 dark:border-neutral-700/50">
                                                <p className={`${result.status === 'error' ? 'text-red-500' : 'text-neutral-500'}`}>{result.message}</p>
                                                {result.details && <p className="text-neutral-500">{result.details}</p>}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ApiKeyStatus;