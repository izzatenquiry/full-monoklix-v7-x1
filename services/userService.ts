import { type User, type LoginResult, UserRole, UserStatus } from '../types';
import { supabase, type Database } from './supabaseClient';
import { loadData } from './indexedDBService';
import { MODELS } from './aiConfig';

type UserProfileData = Database['public']['Tables']['users']['Row'];
type TrialUserProfileData = Database['public']['Tables']['trial_user']['Row'];

export interface AvailableApiKey {
  id: number;
  apiKey: string;
  createdAt: string;
}

/**
 * Saves or updates a user's personal Gemini API key.
 * This function does NOT verify the key; it saves it directly.
 * It also upgrades the user's status to 'lifetime'.
 */
export const saveUserApiKey = async (
    userId: string,
    key: string
): Promise<{ success: true; user: User } | { success: false; message: string }> => {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
        // Allow deleting the key by saving an empty string
        const { data: updatedData, error: updateError } = await supabase
            .from('users')
            // FIX: This operation is now correctly typed after fixing supabaseClient.ts types.
            .update({ api_key: null })
            .eq('id', userId)
            .select()
            .single();

        if (updateError) {
            return { success: false, message: getErrorMessage(updateError) };
        }
        const typedData = updatedData as UserProfileData;
        const updatedUser = mapProfileToUser(typedData);
        return { success: true, user: updatedUser };
    }

    try {
        const { data: updatedData, error: updateError } = await supabase
            .from('users')
            // FIX: This operation is now correctly typed after fixing supabaseClient.ts types.
            .update({ 
                api_key: trimmedKey, 
                status: 'lifetime', // Always ensure user is lifetime when they provide a key
            })
            .eq('id', userId)
            .select()
            .single();

        if (updateError) {
            throw updateError;
        }

        const typedData = updatedData as UserProfileData;
        const updatedUser = mapProfileToUser(typedData);

        return { success: true, user: updatedUser };

    } catch (error) {
        const message = getErrorMessage(error);
        console.error("Failed to save API key:", message);
        return { success: false, message: `Failed to save API key: ${message}` };
    }
};

/**
 * Helper to extract a readable error message from various error types.
 * @param error The error object.
 * @returns A readable string message.
 */
const getErrorMessage = (error: unknown): string => {
    let message = 'An unknown error occurred.';
    if (error instanceof Error) {
        message = error.message;
    } else if (error && typeof error === 'object' && 'message' in error && typeof (error as any).message === 'string') {
        message = (error as any).message;
    } else if (typeof error === 'string') {
        message = error;
    } else {
        try {
            message = JSON.stringify(error);
        } catch {
            // Fallback if stringify fails (e.g., circular reference)
            message = 'Unserializable error object.';
        }
    }
    return message;
};

/**
 * Maps a user profile from the database to the application's User type.
 */
const mapProfileToUser = (
  profile: UserProfileData
): User => {
  return {
    id: profile.id,
    email: profile.email,
    createdAt: profile.created_at,
    username: (profile.email || '').split('@')[0], // Fallback username
    fullName: profile.full_name || undefined,
    phone: profile.phone,
    role: profile.role as UserRole,
    status: profile.status as UserStatus,
    apiKey: profile.api_key,
    avatarUrl: profile.avatar_url || undefined,
    subscriptionExpiry: profile.subscription_expiry ? new Date(profile.subscription_expiry).getTime() : undefined,
    webhookUrl: profile.webhook_url || undefined,
    totalImage: profile.total_image ?? undefined,
    totalVideo: profile.total_video ?? undefined,
  };
};

/**
 * Maps a trial user profile from the database to the application's User type.
 */
const mapTrialProfileToUser = (profile: TrialUserProfileData): User => {
  return {
    id: `trial-${profile.id}`, // Create a unique ID format for trial users
    email: profile.email,
    createdAt: profile.created_at,
    username: profile.username || profile.email.split('@')[0],
    fullName: profile.username,
    phone: profile.phone,
    role: 'user', // Trial users have 'user' role
    status: 'trial', // Their status is 'trial'
    apiKey: null, // Trial users don't have personal API keys
    storyboardUsageCount: profile.storyboard_usage_count,
  };
};

// Log in a user by checking their email directly against the database.
export const loginUser = async (email: string): Promise<LoginResult> => {
    const cleanedEmail = email.trim().toLowerCase();
    if (!cleanedEmail) {
        return { success: false, message: 'Please enter your email address.' };
    }
    
    // 1. Check for a full user (lifetime, admin, etc.) first
    const { data: userData, error: userError } = await supabase
        .from('users')
        .select('*')
        .eq('email', cleanedEmail)
        .single();
    
    // If a user is found in the main 'users' table, they are a full user.
    if (userData && !userError) {
        const typedData = userData as UserProfileData;
        const user = mapProfileToUser(typedData);
        return { success: true, user };
    }

    // 2. If not a full user, check for a trial user
    const { data: trialUserData, error: trialUserError } = await supabase
        .from('trial_user')
        .select('*')
        .eq('email', cleanedEmail)
        .single();

    if (trialUserData && !trialUserError) {
        const typedData = trialUserData as TrialUserProfileData;
        const user = mapTrialProfileToUser(typedData);
        return { success: true, user };
    }
    
    // 3. If not found in either table
    return { success: false, message: 'This email is not registered. Please check your email or register for an account.' };
};

// Sign out the current user (clears Supabase session)
export const signOutUser = async (): Promise<void> => {
    // Session is managed in App.tsx via localStorage. No Supabase call needed.
    // This function is kept for structural consistency if called from somewhere.
    return Promise.resolve();
};

// Get all users (for admin dashboard)
export const getAllUsers = async (): Promise<User[] | null> => {
    const { data, error } = await supabase.from('users').select('*');

    if (error) {
        console.error('Error fetching all users:', getErrorMessage(error));
        return null;
    }

    return (data as UserProfileData[]).map(profile => mapProfileToUser(profile));
};

// Update a user's status
export const updateUserStatus = async (userId: string, status: UserStatus): Promise<boolean> => {
    const { error } = await supabase
        .from('users')
        // FIX: This operation is now correctly typed after fixing supabaseClient.ts types.
        .update({ status: status })
        .eq('id', userId);

    if (error) {
        console.error("Failed to update status:", getErrorMessage(error));
        return false;
    }
    return true;
};

// Update user profile details (non-sensitive)
export const updateUserProfile = async (
  userId: string,
  updates: { fullName?: string; email?: string; avatarUrl?: string }
): Promise<{ success: true; user: User } | { success: false; message: string }> => {
    
    const profileUpdates: { full_name?: string; avatar_url?: string } = {};
    if (updates.fullName) profileUpdates.full_name = updates.fullName;
    if (updates.avatarUrl) profileUpdates.avatar_url = updates.avatarUrl;

    const { data: updatedData, error } = await supabase
        .from('users')
        // FIX: This operation is now correctly typed after fixing supabaseClient.ts types.
        .update(profileUpdates)
        .eq('id', userId)
        .select()
        .single();

    if (error || !updatedData) {
        return { success: false, message: getErrorMessage(error) };
    }
    
    const typedData = updatedData as UserProfileData;
    const updatedProfile = mapProfileToUser(typedData);
    
    return { success: true, user: updatedProfile };
};


/**
 * Replaces the entire user database with an imported list.
 */
export const replaceUsers = async (importedUsers: User[]): Promise<{ success: boolean; message: string }> => {
    try {
        if (!Array.isArray(importedUsers)) {
            return { success: false, message: 'Import file must be an array of users.' };
        }
        
        const profilesToInsert: Database['public']['Tables']['users']['Insert'][] = importedUsers.map(user => ({
            id: user.id,
            created_at: user.createdAt,
            full_name: user.fullName || null,
            email: user.email,
            phone: user.phone,
            role: user.role,
            status: user.status,
            api_key: user.apiKey || null,
            avatar_url: user.avatarUrl || null,
            subscription_expiry: user.subscriptionExpiry ? new Date(user.subscriptionExpiry).toISOString() : null,
            webhook_url: user.webhookUrl || null,
            total_image: user.totalImage || 0,
            total_video: user.totalVideo || 0,
        }));
        
        const { error: deleteError } = await supabase.from('users').delete().neq('role', 'admin');
        if (deleteError) throw deleteError;

        // FIX: This operation is now correctly typed after fixing supabaseClient.ts types.
        const { error: insertError } = await supabase.from('users').insert(profilesToInsert);
        if (insertError) throw insertError;

        return { success: true, message: 'User database successfully imported.' };

    } catch (error) {
        const message = getErrorMessage(error);
        console.error("Failed to import users:", message);
        return { success: false, message: `An error occurred during import: ${message}` };
    }
};

export const exportAllUserData = async (): Promise<UserProfileData[] | null> => {
     const { data, error } = await supabase.from('users').select('*');
     if (error) {
        console.error('Error exporting user data:', getErrorMessage(error));
        return null;
     }
     return data as UserProfileData[];
};

/**
 * Initializes/repairs the admin account.
 */
export const initializeAdminAccount = async () => {
    console.log("Checking/repairing admin account profile...");

    const adminEmail = 'izzat.enquiry@gmail.com';
    
    const { data: adminUser, error: findError } = await supabase
        .from('users')
        .select('id')
        .eq('email', adminEmail)
        .eq('role', 'admin')
        .single();
        
    if (findError || !adminUser) {
        console.warn('Admin user profile not found in public.users. Manual creation might be needed if this is the first run.');
        return;
    }
    
    // FIX: The type of `adminUser` is now correctly inferred, so `adminUser.id` is accessible.
    const adminUserId = adminUser.id;

    const profileData: Database['public']['Tables']['users']['Insert'] = {
        id: adminUserId,
        full_name: 'MONOklix Admin',
        email: adminEmail,
        phone: '+601111303527', // Default phone
        role: 'admin',
        status: 'admin',
    };
    
    // FIX: This operation is now correctly typed after fixing supabaseClient.ts types.
    const { error: upsertError } = await supabase.from('users').upsert(profileData, { onConflict: 'id' });

    if (upsertError) {
        console.error('Failed to upsert admin profile:', getErrorMessage(upsertError));
    } else {
        console.log('Admin profile successfully configured in database.');
    }
};

// Update user webhook URL
export const updateUserWebhookUrl = async (
  userId: string,
  webhookUrl: string | null
): Promise<{ success: true; user: User } | { success: false; message: string }> => {
    const { data: updatedData, error } = await supabase
        .from('users')
        // FIX: This operation is now correctly typed after fixing supabaseClient.ts types.
        .update({ webhook_url: webhookUrl })
        .eq('id', userId)
        .select()
        .single();

    if (error || !updatedData) {
        return { success: false, message: getErrorMessage(error) };
    }
    
    const typedData = updatedData as UserProfileData;
    const updatedProfile = mapProfileToUser(typedData);
    
    return { success: true, user: updatedProfile };
};

export const getAvailableApiKeys = async (): Promise<AvailableApiKey[]> => {
    const { data, error } = await supabase
        .from('generated_api_keys')
        .select('id, api_key, created_at')
        .order('created_at', { ascending: false })
        .limit(10);
    
    if (error) {
        console.error('Error fetching available API keys:', error);
        return [];
    }
    
    return data.map(item => ({
        id: item.id,
        apiKey: item.api_key,
        createdAt: item.created_at,
    }));
};

export const claimApiKey = async (keyId: number, userId: string, username: string): Promise<{ success: boolean; message?: string }> => {
    // First, get the user's role to check if they are an admin.
    const { data: user, error: userError } = await supabase
        .from('users')
        .select('role')
        .eq('id', userId)
        .single();

    if (userError) {
        console.error('Error fetching user role:', userError);
        return { success: false, message: 'Could not verify user role. Please try again.' };
    }

    // Only apply the daily limit check if the user is NOT an admin.
    if (user.role !== 'admin') {
        const DAILY_CLAIM_LIMIT = 5;
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const { count, error: countError } = await supabase
            .from('generated_api_keys')
            .select('id', { count: 'exact', head: true })
            .eq('claimed_by_user_id', userId)
            .gt('claimed_at', twentyFourHoursAgo);

        if (countError) {
            console.error('Error checking claim limit:', countError);
            return { success: false, message: 'Could not verify your claim limit. Please try again.' };
        }

        if (count !== null && count >= DAILY_CLAIM_LIMIT) {
            return { success: false, message: 'You have reached your daily limit of 5 key claims. This feature is still in a development phase, so we cannot provide more keys at this time. If you need more, please contact the admin via WhatsApp to purchase the API Generator Tool. Please try again tomorrow.' };
        }
    }

    // Continue with the claim process for both admins and regular users who are within their limit.
    const { error: updateError } = await supabase
        .from('generated_api_keys')
        .update({
            claimed_by_user_id: userId,
            claimed_by_username: username,
            claimed_at: new Date().toISOString(),
        })
        .eq('id', keyId);

    if (updateError) {
        console.error('Error claiming API key:', updateError);
        return { success: false, message: updateError.message };
    }
    return { success: true };
};


/**
 * Type definition for the structured details of an AI generation log.
 * Keys use snake_case to match the database schema directly.
 */
type AiGenerationLogData = {
    model: string;
    prompt: string;
    output: string;
    token_count: number;
    status: 'Success' | 'Error';
    error_message?: string | null;
};

/**
 * Logs a user activity to the Supabase database.
 * This is a fire-and-forget operation; errors are logged to the console but not thrown.
 * @param activity_type Describes the activity ('login' or 'ai_generation').
 * @param details An optional structured object for AI generation activities.
 */
export const logActivity = async (
    activity_type: 'login' | 'ai_generation',
    details?: AiGenerationLogData
): Promise<void> => {
    const getCurrentUserInternal = (): User | null => {
        try {
            const savedUserJson = localStorage.getItem('currentUser');
            if (savedUserJson) {
                const user = JSON.parse(savedUserJson) as User;
                if (user && user.id) {
                    return user;
                }
            }
        } catch (error) {
            console.error("Failed to parse user from localStorage for activity log.", error);
        }
        return null;
    };

    const user = getCurrentUserInternal();

    if (!user) {
        // Fail silently if no user. We don't want to block user actions for logging.
        console.warn('Cannot log activity: user not found.');
        return;
    }

    // For the demo site, trial users are not logged to the main activity_log
    // because their IDs are not UUIDs and would cause a foreign key constraint violation.
    if (user.status === 'trial') {
        console.log("Skipping Supabase activity log for trial user.");
        return;
    }

    try {
        const baseLog = {
            user_id: user.id,
            username: user.username,
            email: user.email,
            activity_type,
        };

        // Conditionally add details for AI generation logs
        const logData = activity_type === 'ai_generation' && details
            ? { ...baseLog, ...details }
            : baseLog;

        const { error } = await supabase
            .from('activity_log')
            .insert(logData);
        
        if (error) {
            console.error('Failed to log activity to Supabase:', error.message);
        }
    } catch (e) {
        console.error('Exception while logging activity:', e);
    }
};

/**
 * Fetches the most recent VEO 3.0 auth tokens from the Supabase auth_token table.
 * @returns {Promise<{ token: string; createdAt: string }[] | null>} An array of token objects or null if not found/error.
 */
export const getVeoAuthTokens = async (): Promise<{ token: string; createdAt: string }[] | null> => {
    const { data, error } = await supabase
        .from('auth_token')
        .select('token, created_at')
        .order('created_at', { ascending: false })
        .limit(5);

    if (error) {
        console.error('Error fetching VEO auth tokens:', getErrorMessage(error));
        return null;
    }

    if (data && data.length > 0) {
        return data.map(item => ({ token: item.token, createdAt: item.created_at }));
    }
    
    return null;
};


/**
 * Fetches the latest master API key designated for trial users.
 * @returns {Promise<string | null>} The API key string or null if not found/error.
 */
export const getTrialMasterApiKey = async (): Promise<string | null> => {
    const { data, error } = await supabase
        .from('master_api_key')
        .select('api_key')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (error) {
        console.error('Error fetching trial master API key:', getErrorMessage(error));
        return null;
    }

    return data?.api_key || null;
};

export const incrementStoryboardUsage = async (userId: string): Promise<{ success: true; user: User } | { success: false; message: string }> => {
    try {
        // Check if it's a trial user by the ID format
        if (userId.startsWith('trial-')) {
            const trialUserId = parseInt(userId.replace('trial-', ''), 10);
            if (isNaN(trialUserId)) throw new Error("Invalid trial user ID format.");

            const { data: currentData, error: fetchError } = await supabase
                .from('trial_user')
                .select('storyboard_usage_count')
                .eq('id', trialUserId)
                .single();
            
            if (fetchError) throw fetchError;
            
            const currentCount = currentData?.storyboard_usage_count || 0;

            const { data: updatedData, error: updateError } = await supabase
                .from('trial_user')
                .update({ storyboard_usage_count: currentCount + 1 })
                .eq('id', trialUserId)
                .select()
                .single();

            if (updateError) throw updateError;
            
            const typedData = updatedData as TrialUserProfileData;
            const user = mapTrialProfileToUser(typedData);
            
            return { success: true, user };

        } else {
            // This is a regular user. Storyboard usage is not tracked for them.
            // We just fetch their latest profile and return it to satisfy the function signature.
            const { data: userData, error: userError } = await supabase
                .from('users')
                .select('*')
                .eq('id', userId)
                .single();

            if (userError) throw userError;
            
            const typedData = userData as UserProfileData;
            const user = mapProfileToUser(typedData);
            
            return { success: true, user: user };
        }

    } catch (error) {
        const message = getErrorMessage(error);
        console.error("Failed to increment storyboard usage:", message);
        return { success: false, message };
    }
};

export const incrementImageUsage = async (userId: string): Promise<{ success: true; user: User } | { success: false; message: string }> => {
    if (userId.startsWith('trial-')) {
        const trialUserId = parseInt(userId.replace('trial-', ''), 10);
        if (isNaN(trialUserId)) return { success: false, message: "Invalid trial user ID." };
        
        const { data, error } = await supabase.from('trial_user').select('*').eq('id', trialUserId).single();
        if (error || !data) return { success: false, message: "Trial user not found." };
        return { success: true, user: mapTrialProfileToUser(data as TrialUserProfileData) };
    }
    try {
        const { data: currentData, error: fetchError } = await supabase
            .from('users')
            .select('total_image')
            .eq('id', userId)
            .single();
        if (fetchError) throw fetchError;
        const currentCount = Number(currentData?.total_image || 0);
        const { data: updatedData, error: updateError } = await supabase
            .from('users')
            .update({ total_image: currentCount + 1 })
            .eq('id', userId)
            .select()
            .single();
        if (updateError) throw updateError;
        return { success: true, user: mapProfileToUser(updatedData as UserProfileData) };
    } catch (error) {
        const message = getErrorMessage(error);
        console.error("Failed to increment image usage:", message);
        return { success: false, message };
    }
};

export const incrementVideoUsage = async (userId: string): Promise<{ success: true; user: User } | { success: false; message: string }> => {
    if (userId.startsWith('trial-')) {
        const trialUserId = parseInt(userId.replace('trial-', ''), 10);
        if (isNaN(trialUserId)) return { success: false, message: "Invalid trial user ID." };
        
        const { data, error } = await supabase.from('trial_user').select('*').eq('id', trialUserId).single();
        if (error || !data) return { success: false, message: "Trial user not found." };
        return { success: true, user: mapTrialProfileToUser(data as TrialUserProfileData) };
    }
    try {
        const { data: currentData, error: fetchError } = await supabase
            .from('users')
            .select('total_video')
            .eq('id', userId)
            .single();
        if (fetchError) throw fetchError;
        const currentCount = Number(currentData?.total_video || 0);
        const { data: updatedData, error: updateError } = await supabase
            .from('users')
            .update({ total_video: currentCount + 1 })
            .eq('id', userId)
            .select()
            .single();
        if (updateError) throw updateError;
        return { success: true, user: mapProfileToUser(updatedData as UserProfileData) };
    } catch (error) {
        const message = getErrorMessage(error);
        console.error("Failed to increment video usage:", message);
        return { success: false, message };
    }
};