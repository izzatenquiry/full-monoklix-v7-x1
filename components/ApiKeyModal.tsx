import React from 'react';
import { type User } from '../../types';
import { XIcon } from './Icons';
import ApiKeyClaimPanel from './common/ApiKeyClaimPanel';

interface ApiKeyModalProps {
    isOpen: boolean;
    onClose: () => void;
    currentUser: User;
    onUserUpdate: (user: User) => void;
}

const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ isOpen, onClose, currentUser, onUserUpdate }) => {

    const handleClaimSuccess = () => {
        setTimeout(() => {
            onClose();
        }, 1500);
    };
    
    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={onClose}
            aria-labelledby="api-key-modal-title"
            role="dialog"
            aria-modal="true"
        >
            <div 
                className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl w-full max-w-2xl transform transition-all max-h-[90vh] flex flex-col animate-zoomIn" 
                role="document"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-6">
                    <div className="flex items-start justify-between">
                        
                    </div>
                </div>
                
                <div className="overflow-y-auto custom-scrollbar px-6 pb-6">
                    <ApiKeyClaimPanel 
                        language="en"
                        currentUser={currentUser}
                        onClaimSuccess={handleClaimSuccess}
                    />
                </div>
            </div>
        </div>
    );
};

export default ApiKeyModal;