import React, { useState, useEffect, useCallback } from 'react';
// FIX: Import Language type for state management.
import { type View, type User, type BatchProcessorPreset, type Language, UserStatus } from './types';
import Sidebar from './components/Sidebar';
import AiTextSuiteView from './components/views/AiTextSuiteView';
import AiImageSuiteView from './components/views/AiImageSuiteView';
import AiVideoSuiteView from './components/views/AiVideoSuiteView';
import ECourseView from './components/views/ECourseView';
import SettingsView from './components/views/SettingsView';
import LoginPage from './LoginPage';
import GalleryView from './components/views/GalleryView';
import WelcomeAnimation from './components/WelcomeAnimation';
import LibraryView from './components/views/LibraryView';
import { MenuIcon, LogoIcon, XIcon, SunIcon, MoonIcon, CheckCircleIcon, AlertTriangleIcon, PartyPopperIcon, RefreshCwIcon } from './components/Icons';
import { signOutUser, logActivity, getVeoAuthTokens, getTrialMasterApiKey, getAvailableApiKeys, claimApiKey, updateUserLastSeen } from './services/userService';
import { createChatSession, streamChatResponse, isImageModelHealthy } from './services/geminiService';
import Spinner from './components/common/Spinner';
import { loadData, saveData } from './services/indexedDBService';
import { type Chat } from '@google/genai';
import { getSupportPrompt } from './services/promptManager';
import { triggerUserWebhook } from './services/webhookService';
// FIX: Changed to a named import to resolve the "no default export" error.
import { GetStartedView } from './components/views/GetStartedView';
import AiPromptLibrarySuiteView from './components/views/AiPromptLibrarySuiteView';
import SocialPostStudioView from './components/views/SocialPostStudioView';
import eventBus from './services/eventBus';
import { TRIAL_USAGE_LIMIT } from './services/aiConfig';
import ApiKeyStatus from './components/ApiKeyStatus';
import { clearLogs } from './services/aiLogService';
import { clearVideoCache } from './services/videoCacheService';
import localforage from 'localforage';
import { supabase, type Database } from './services/supabaseClient';


interface VideoGenPreset {
  prompt: string;
  image: { base64: string; mimeType: string; };
}

interface ImageEditPreset {
  base64: string;
  mimeType: string;
}

interface Message {
  role: 'user' | 'model';
  text: string;
}

const ThemeSwitcher: React.FC<{ theme: string; setTheme: (theme: string) => void }> = ({ theme, setTheme }) => (
    <button
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        className="p-2 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
        aria-label="Toggle theme"
    >
        {theme === 'light' ? (
            <MoonIcon className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
        ) : (
            <SunIcon className="w-5 h-5 text-yellow-500" />
        )}
    </button>
);

const AutoFixBanner: React.FC<{ status: 'in-progress' | 'success' | 'failed'; onClose: () => void }> = ({ status, onClose }) => {
  const content = {
    'in-progress': {
      icon: <Spinner />,
      message: 'API connection error detected. Attempting to automatically resolve...',
      bg: 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-200',
    },
    success: {
      icon: <CheckCircleIcon className="w-5 h-5 text-green-600 dark:text-green-400" />,
      message: 'Connection restored! A new, healthy key/token has been applied automatically.',
      bg: 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-200',
    },
    failed: {
      icon: <AlertTriangleIcon className="w-5 h-5 text-red-600 dark:text-red-400" />,
      message: 'Auto-repair failed. Please check your personal key in Settings.',
      bg: 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200',
    },
  }[status];

  return (
    <div className={`fixed bottom-4 right-4 z-50 p-4 rounded-lg shadow-lg flex items-center gap-4 animate-zoomIn ${content.bg}`}>
      {content.icon}
      <p className="text-sm font-semibold">{content.message}</p>
      <button onClick={onClose} className="p-1 rounded-full hover:bg-black/10">
        <XIcon className="w-4 h-4" />
      </button>
    </div>
  );
};

const OnboardingNotification: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="fixed bottom-4 right-4 z-50 p-4 rounded-lg shadow-lg flex items-center gap-4 animate-zoomIn bg-sky-100 dark:bg-sky-900/50 text-sky-800 dark:text-sky-200">
    <PartyPopperIcon className="w-6 h-6 text-sky-600 dark:text-sky-400" />
    <p className="text-sm font-semibold">
      We've automatically assigned a temporary API key to get you started!
    </p>
    <button onClick={onClose} className="p-1 rounded-full hover:bg-black/10">
      <XIcon className="w-4 h-4" />
    </button>
  </div>
);


const App: React.FC = () => {
  const [sessionChecked, setSessionChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [tempApiKey, setTempApiKey] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<View>('home');
  const [theme, setTheme] = useState('light'); // Default to light, load async
  // FIX: Add state for language to pass down to child components for translations.
  const [language, setLanguage] = useState<Language>('en');
  const [videoGenPreset, setVideoGenPreset] = useState<VideoGenPreset | null>(null);
  const [imageToReEdit, setImageToReEdit] = useState<ImageEditPreset | null>(null);
  const [imageGenPresetPrompt, setImageGenPresetPrompt] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isShowingWelcome, setIsShowingWelcome] = useState(false);
  const [justLoggedIn, setJustLoggedIn] = useState(false);
  const [autoClaimStatus, setAutoClaimStatus] = useState<'idle' | 'in-progress' | 'success' | 'failed'>('idle');
  const [showOnboardingNotification, setShowOnboardingNotification] = useState(false);
  const [veoTokenRefreshedAt, setVeoTokenRefreshedAt] = useState<string | null>(null);

  // --- AI Support Chat State ---
  const [aiSupportMessages, setAiSupportMessages] = useState<Message[]>([]);
  const [aiSupportChat, setAiSupportChat] = useState<Chat | null>(null);
  const [isAiSupportLoading, setIsAiSupportLoading] = useState(false);
  
  const handleUserUpdate = useCallback((updatedUser: User) => {
    setCurrentUser(updatedUser);
    localStorage.setItem('currentUser', JSON.stringify(updatedUser));
  }, []);

  const handleLogout = useCallback(async () => {
    await signOutUser();
    localStorage.removeItem('currentUser');
    sessionStorage.removeItem('monoklix_session_api_key'); // Clean up session key
    sessionStorage.removeItem('session_started_at'); // Clean up session start time
    setCurrentUser(null);
    setTempApiKey(null);
    setActiveView('home');
  }, []);

  const handleClearCacheAndRefresh = () => {
    if (window.confirm("This will refresh your session, log you out, and clear temporary application settings. Your saved gallery and history will NOT be deleted. Continue?")) {
        try {
            console.log("Clearing session and refreshing application...");

            // 1. Clear session-level storage to force re-authentication of keys.
            sessionStorage.clear();

            // 2. Clear local storage to log the user out and reset app state.
            localStorage.clear();
            
            // 3. Reload the page. This forces a fresh start.
            window.location.reload();

        } catch (error) {
            console.error("Failed to refresh session:", error);
            alert("An error occurred while refreshing the session. Please try again.");
        }
    }
  };

  const handleAutoVeoKey = useCallback(async (): Promise<boolean> => {
      const tokensData = await getVeoAuthTokens();
      if (tokensData && tokensData.length > 0) {
          sessionStorage.setItem('veoAuthTokens', JSON.stringify(tokensData));
          sessionStorage.setItem('veoAuthToken', tokensData[0].token);
          sessionStorage.setItem('veoAuthTokenCreatedAt', tokensData[0].createdAt);
          setVeoTokenRefreshedAt(new Date().toISOString());
          console.log("VEO Auth Tokens automatically refreshed.");
          return true;
      } else {
          sessionStorage.removeItem('veoAuthTokens');
          sessionStorage.removeItem('veoAuthToken');
          sessionStorage.removeItem('veoAuthTokenCreatedAt');
          console.warn("Could not auto-refresh VEO Auth Tokens from Supabase.");
          return false;
      }
  }, []);

  useEffect(() => {
    const fetchAndSetTokens = async () => {
      const tokensData = await getVeoAuthTokens();
      if (tokensData && tokensData.length > 0) {
        sessionStorage.setItem('veoAuthTokens', JSON.stringify(tokensData));
        // For simple checks, also store the primary token separately
        sessionStorage.setItem('veoAuthToken', tokensData[0].token);
        sessionStorage.setItem('veoAuthTokenCreatedAt', tokensData[0].createdAt);
        setVeoTokenRefreshedAt(new Date().toISOString());
        console.log(`${tokensData.length} VEO Auth Tokens loaded from Supabase and set in session storage.`);
      } else {
        sessionStorage.removeItem('veoAuthTokens');
        sessionStorage.removeItem('veoAuthToken');
        sessionStorage.removeItem('veoAuthTokenCreatedAt');
        console.warn("Could not fetch any VEO Auth Tokens from Supabase.");
      }
    };
    fetchAndSetTokens();
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
        const savedTheme = await loadData<string>('theme');
        if (savedTheme) setTheme(savedTheme);
    };
    loadSettings();
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveData('theme', theme);
  }, [theme]);
  
  // Effect to listen for events that require API key management.
  useEffect(() => {
    const handleNewKeyClaimed = (newKey: string) => {
      console.log('App: New temporary key has been claimed. Updating state.');
      setTempApiKey(newKey);
    };

    const handleAutoClaim = async () => {
      if (autoClaimStatus === 'in-progress' || !currentUser) return;
      console.log('App: API key error detected. Initiating auto-claim...');
      setAutoClaimStatus('in-progress');
      try {
          const keys = await getAvailableApiKeys();
          let healthyKey: string | null = null;
          // Find the first healthy key and claim it
          for (const key of keys) {
              if (await isImageModelHealthy(key.apiKey)) {
                  const claimResult = await claimApiKey(key.id, currentUser.id, currentUser.username);
                  if (claimResult.success) {
                      healthyKey = key.apiKey;
                      break; // Stop after finding one
                  }
              }
          }

          if (healthyKey) {
              setTempApiKey(healthyKey);
              setAutoClaimStatus('success');
          } else {
              setAutoClaimStatus('failed');
          }
      } catch (error) {
          console.error("Auto-claim process failed:", error);
          setAutoClaimStatus('failed');
      }
    };

    const handleAutoVeoClaim = async () => {
        if (autoClaimStatus === 'in-progress') return;
        console.log('App: VEO key error detected. Initiating auto-refresh...');
        setAutoClaimStatus('in-progress');
        const success = await handleAutoVeoKey();
        setAutoClaimStatus(success ? 'success' : 'failed');
    };
    
    // FIX: Add event listener for real-time user usage updates.
    const handleUserUsageUpdate = (updatedUser: User) => {
      console.log('App: User usage stats updated via event bus. Refreshing state.');
      handleUserUpdate(updatedUser);
    };

    eventBus.on('tempKeyClaimed', handleNewKeyClaimed);
    eventBus.on('initiateAutoApiKeyClaim', handleAutoClaim);
    eventBus.on('initiateAutoVeoKeyClaim', handleAutoVeoClaim);
    eventBus.on('userUsageUpdated', handleUserUsageUpdate);

    return () => {
      eventBus.remove('tempKeyClaimed', handleNewKeyClaimed);
      eventBus.remove('initiateAutoApiKeyClaim', handleAutoClaim);
      eventBus.remove('initiateAutoVeoKeyClaim', handleAutoVeoClaim);
      eventBus.remove('userUsageUpdated', handleUserUsageUpdate);
    };
  }, [currentUser, autoClaimStatus, handleUserUpdate, handleAutoVeoKey]);
  
  // Effect to check for an active session in localStorage on initial load.
  useEffect(() => {
    try {
        const savedUserJson = localStorage.getItem('currentUser');
        if (savedUserJson) {
            const user = JSON.parse(savedUserJson);
            setCurrentUser(user);
            // THIS IS THE FIX: Set session start time on every app load for a logged-in user.
            sessionStorage.setItem('session_started_at', new Date().toISOString());
        }
    } catch (error) {
        console.error("Failed to parse user from localStorage", error);
        localStorage.removeItem('currentUser');
    }
    setSessionChecked(true);
  }, []);

  useEffect(() => {
    if (justLoggedIn) {
        setIsShowingWelcome(true);
        setJustLoggedIn(false); // Reset the flag
    }
  }, [justLoggedIn]);

  const activeApiKey = currentUser?.apiKey || tempApiKey;

  // Effect to sync the active API key to sessionStorage and initialize dependent services like the AI chat.
  useEffect(() => {
    if (activeApiKey) {
        sessionStorage.setItem('monoklix_session_api_key', activeApiKey);
        console.log(`Active API key (...${activeApiKey.slice(-4)}) set in session storage.`);
    } else {
        sessionStorage.removeItem('monoklix_session_api_key');
        console.log("No active API key. Session storage cleared.");
    }

    const setupChatSession = async () => {
        if (activeApiKey) {
            try {
                const systemInstruction = getSupportPrompt();
                const session = await createChatSession(systemInstruction);
                setAiSupportChat(session);
            } catch (e) {
                console.error("Failed to create chat session on key update:", e);
                setAiSupportChat(null);
            }
        } else {
            setAiSupportChat(null);
            setAiSupportMessages([]);
        }
    };
    setupChatSession();
  }, [activeApiKey]);
  
   // Effect for user heartbeat (active status)
    useEffect(() => {
        if (currentUser) {
            // Initial update on login
            updateUserLastSeen(currentUser.id);

            const heartbeatInterval = setInterval(() => {
                updateUserLastSeen(currentUser.id);
            }, 30000); // Send a heartbeat every 30 seconds

            return () => clearInterval(heartbeatInterval);
        }
    }, [currentUser]);

    // Effect for real-time remote logout listener
    useEffect(() => {
        if (!currentUser || currentUser.status === 'trial') return;

        const channel = supabase
            .channel(`user-session-channel-${currentUser.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'users',
                    filter: `id=eq.${currentUser.id}`,
                },
                (payload) => {
                    const newUserData = payload.new as Database['public']['Tables']['users']['Row'];
                    const forceLogoutAt = newUserData.force_logout_at;
                    
                    if (forceLogoutAt) {
                        const sessionStartedAt = sessionStorage.getItem('session_started_at');
                        if (sessionStartedAt && new Date(forceLogoutAt) > new Date(sessionStartedAt)) {
                            alert('Your session has been terminated by an administrator.');
                            handleLogout();
                        }
                    }
                }
            )
            .subscribe();
        
        return () => {
            supabase.removeChannel(channel);
        };
    }, [currentUser, handleLogout]);

  const handleLoginSuccess = async (user: User) => {
    handleUserUpdate(user);
    setJustLoggedIn(true);
    logActivity('login');
    sessionStorage.setItem('session_started_at', new Date().toISOString());

    // For trial users, assign the master trial key.
    if (user.status === 'trial') {
        console.log("Trial user logged in. Fetching master trial key.");
        const trialKey = await getTrialMasterApiKey();
        if (trialKey) {
            setTempApiKey(trialKey);
            setShowOnboardingNotification(true);
            console.log("Successfully set master trial API key for the session.");
        } else {
            console.warn("Could not fetch master trial API key. User will have no API access.");
        }
    } else if (!user.apiKey) {
        // For full users without their own key, they'll need to claim one.
        console.log("Full user logged in without a personal API key.");
    }
  };


  const handleAiSupportSend = useCallback(async (prompt: string) => {
    if (!prompt.trim() || !aiSupportChat || isAiSupportLoading) return;

    const userMessage: Message = { role: 'user', text: prompt };
    setAiSupportMessages((prev) => [...prev, userMessage]);
    setIsAiSupportLoading(true);

    try {
        const stream = await streamChatResponse(aiSupportChat, prompt);
        let modelResponse = '';
        setAiSupportMessages((prev) => [...prev, { role: 'model', text: '...' }]);
        
        for await (const chunk of stream) {
            modelResponse += chunk.text;
            setAiSupportMessages((prev) => {
                const newMessages = [...prev];
                if(newMessages.length > 0) {
                    newMessages[newMessages.length - 1].text = modelResponse;
                }
                return newMessages;
            });
        }
        triggerUserWebhook({ type: 'text', prompt, result: modelResponse });
    } catch (error) {
        // Error is now handled by the UI component via a thrown error.
        // We just need to update the chat UI to show failure.
        console.error('Error sending support message:', error);
        const errorMessageText = error instanceof Error ? error.message : "Sorry, an error occurred. Please try again.";
        const errorMessage: Message = { role: 'model', text: errorMessageText };
        setAiSupportMessages((prev) => {
            const newMessages = [...prev];
            if (newMessages.length > 0 && newMessages[newMessages.length-1].role === 'model') {
                newMessages[newMessages.length - 1] = errorMessage;
            } else {
                newMessages.push(errorMessage);
            }
            return newMessages;
        });
    } finally {
        setIsAiSupportLoading(false);
    }
  }, [aiSupportChat, isAiSupportLoading]);

  const handleCreateVideoFromImage = (preset: VideoGenPreset) => {
    setVideoGenPreset(preset);
    setActiveView('ai-video-suite');
  };

  const handleReEditImage = (preset: ImageEditPreset) => {
    setImageToReEdit(preset);
    setActiveView('ai-image-suite');
  };

  const handleUsePromptInGenerator = (prompt: string) => {
    setImageGenPresetPrompt(prompt);
    setActiveView('ai-image-suite');
  };

  const renderView = () => {
    switch (activeView) {
      case 'home':
        return <ECourseView currentUser={currentUser!} />;
      case 'get-started':
        return <GetStartedView />;
      case 'ai-text-suite':
        // FIX: Pass language prop to AiTextSuiteView.
        return <AiTextSuiteView currentUser={currentUser!} language={language} />;
      case 'ai-image-suite':
        return <AiImageSuiteView 
                  onCreateVideo={handleCreateVideoFromImage} 
                  onReEdit={handleReEditImage}
                  imageToReEdit={imageToReEdit}
                  clearReEdit={() => setImageToReEdit(null)}
                  presetPrompt={imageGenPresetPrompt}
                  clearPresetPrompt={() => setImageGenPresetPrompt(null)}
                  // FIX: Pass language prop to AiImageSuiteView.
                  language={language}
                />;
      case 'ai-video-suite':
        return <AiVideoSuiteView 
                  currentUser={currentUser!}
                  preset={videoGenPreset} 
                  clearPreset={() => setVideoGenPreset(null)}
                  onCreateVideo={handleCreateVideoFromImage}
                  onReEdit={handleReEditImage}
                  onUserUpdate={handleUserUpdate}
                  // FIX: Pass language prop to AiVideoSuiteView.
                  language={language}
                />;
      case 'ai-prompt-library-suite':
          return <AiPromptLibrarySuiteView onUsePrompt={handleUsePromptInGenerator} />;
      case 'social-post-studio':
          // FIX: Pass language prop to SocialPostStudioView.
          return <SocialPostStudioView currentUser={currentUser!} language={language} />;
      case 'gallery':
        return <GalleryView onCreateVideo={handleCreateVideoFromImage} onReEdit={handleReEditImage} />;
      case 'settings':
          return <SettingsView 
                    currentUser={currentUser!} 
                    tempApiKey={tempApiKey}
                    onUserUpdate={handleUserUpdate} 
                    aiSupportMessages={aiSupportMessages}
                    isAiSupportLoading={isAiSupportLoading}
                    onAiSupportSend={handleAiSupportSend}
                    // FIX: Pass language prop to SettingsView.
                    language={language}
                    veoTokenRefreshedAt={veoTokenRefreshedAt}
                 />;
      default:
        return <ECourseView currentUser={currentUser!} />;
    }
  };
  
  if (!sessionChecked) {
      return (
          <div className="flex items-center justify-center min-h-screen bg-neutral-100 dark:bg-neutral-900">
              <Spinner />
          </div>
      );
  }

  if (isShowingWelcome) {
    return <WelcomeAnimation onAnimationEnd={() => {
        setIsShowingWelcome(false);
        // Redirect trial users directly to their main feature
        if (currentUser?.status === 'trial') {
            setActiveView('ai-video-suite');
        } else {
            setActiveView('home');
        }
    }} />;
  }
  
  if (!currentUser) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  // --- Access Control Logic for Full Version ---
  let isBlocked = false;
  let blockMessage = { title: "Access Denied", body: "" };

  const isSubscriptionActive = currentUser.status === 'subscription' && currentUser.subscriptionExpiry && Date.now() < currentUser.subscriptionExpiry;

  const adminOnlyViews: View[] = ['social-post-studio'];

  if (adminOnlyViews.includes(activeView) && currentUser.role !== 'admin') {
      isBlocked = true;
      blockMessage = { title: "Access Denied", body: "This feature is only available for administrators." };
  } else if (currentUser.status === 'admin' || currentUser.status === 'lifetime' || isSubscriptionActive) {
    isBlocked = false;
  } 
  else if (currentUser.status === 'subscription' && !isSubscriptionActive) {
      isBlocked = true;
      blockMessage = { title: "Subscription Expired", body: "Your plan has expired. To continue using all features, please renew your subscription. [BUTTON]Renew Now[URL]https://monoklix.com/step/monoklix-checkout/" };
  }
  // Apply restrictions for trial users
  else if (currentUser.status === 'trial') {
    const usageCount = currentUser.storyboardUsageCount || 0;
    const allowedViews: View[] = ['home', 'get-started', 'gallery'];
    if (usageCount < TRIAL_USAGE_LIMIT) {
        allowedViews.push('ai-video-suite');
    }

    if (!allowedViews.includes(activeView)) {
        isBlocked = true;
        blockMessage = { 
            title: "⚠️ Trial Mode Ended", 
            body: usageCount >= TRIAL_USAGE_LIMIT 
                ? `You have used up your trial credits for this feature.
To continue enjoying full access to all MONOklix Studio features, please upgrade your account to the full version. 🚀
[BUTTON]Register for a Full Account[URL]https://monoklix.com/step/monoklix-checkout/
After upgrading, you will get unlimited access to all features including:

Unlimited storyboard video creation 🎬
Full AI & VEO integration ⚡
Unrestricted project saving and exporting 📂

Thank you for trying MONOklix Studio!`
                : `This feature is not available in trial mode.
To unlock this and all other advanced features, please upgrade to the full version.
[BUTTON]Register for a Full Account[URL]https://monoklix.com/step/monoklix-checkout/`
        };
    }
  } 
  // Block any other status (e.g., inactive, pending_payment)
  else {
      isBlocked = true;
      blockMessage = { title: "Access Denied", body: `Your account status is "${currentUser.status}". Please contact support for assistance.` };
  }


  const renderBlockMessageBody = (body: string) => {
        if (!body.includes('[BUTTON]')) {
            return <p className="mt-2 text-neutral-600 dark:text-neutral-300 whitespace-pre-line">{body}</p>;
        }

        const buttonRegex = /\[BUTTON\](.*?)\[URL\](.*)/;
        const buttonMatch = body.match(buttonRegex);

        if (!buttonMatch || typeof buttonMatch.index === 'undefined') {
            return <p className="mt-2 text-neutral-600 dark:text-neutral-300 whitespace-pre-line">{body}</p>;
        }
        
        const beforeText = body.substring(0, buttonMatch.index);
        const buttonText = buttonMatch[1];
        const buttonUrl = buttonMatch[2];
        const afterText = body.substring(buttonMatch.index + buttonMatch[0].length);

        return (
            <div className="mt-4 text-neutral-600 dark:text-neutral-300 space-y-4">
                <p className="whitespace-pre-line text-sm">{beforeText.trim()}</p>
                <a
                    href={buttonUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block bg-primary-600 text-white font-semibold py-3 px-6 rounded-lg hover:bg-primary-700 transition-colors shadow-md text-base"
                >
                    {buttonText}
                </a>
                <p className="whitespace-pre-line text-sm">{afterText.trim()}</p>
            </div>
        );
    };

  const PageContent = isBlocked ? (
    <div className="flex items-center justify-center h-full p-4">
      <div className="text-center p-8 sm:p-12 max-w-lg bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-100 dark:bg-primary-900/50">
          <XIcon className="h-6 w-6 text-primary-600 dark:text-primary-400" />
        </div>
        <h2 className="mt-5 text-xl font-bold text-neutral-800 dark:text-white sm:text-2xl">{blockMessage.title}</h2>
        {renderBlockMessageBody(blockMessage.body)}
      </div>
    </div>
  ) : renderView();

  return (
    <div className="flex h-screen bg-neutral-100 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 font-sans">
      <Sidebar 
        activeView={activeView} 
        setActiveView={setActiveView} 
        onLogout={handleLogout} 
        currentUser={currentUser}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
      />
      <main className="flex-1 flex flex-col overflow-y-auto">
        {/* Header */}
        <header className="flex items-center justify-between p-2 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <button onClick={() => setIsSidebarOpen(true)} className="p-2 lg:hidden" aria-label="Open menu">
              <MenuIcon className="w-6 h-6" />
            </button>
             <LogoIcon className="w-28 text-neutral-800 dark:text-neutral-200" />
          </div>
          <div className="flex items-center gap-2 pr-2">
              <ThemeSwitcher theme={theme} setTheme={setTheme} />
              <button
                  onClick={handleClearCacheAndRefresh}
                  className="p-2 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                  aria-label="Refresh Session"
                  title="Refresh Session (clears session data & logs you out)"
              >
                  <RefreshCwIcon className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
              </button>
              <ApiKeyStatus 
                activeApiKey={activeApiKey} 
                veoTokenRefreshedAt={veoTokenRefreshedAt} 
                currentUser={currentUser}
              />
          </div>
        </header>
        <div className="flex-1 p-4 md:p-8">
          {PageContent}
        </div>
      </main>

      {autoClaimStatus !== 'idle' && (
        <AutoFixBanner
          status={autoClaimStatus}
          onClose={() => setAutoClaimStatus('idle')}
        />
      )}

      {showOnboardingNotification && (
        <OnboardingNotification onClose={() => setShowOnboardingNotification(false)} />
      )}
    </div>
  );
};

export default App;