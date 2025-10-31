import eventBus from './eventBus';

/**
 * Handles API errors by identifying the error type, triggering auto-repair mechanisms,
 * and throwing a user-friendly error to be caught and displayed by the UI components.
 * This replaces the disruptive global error modal with inline error messaging.
 * @param {unknown} error - The error caught from the API call.
 */
export const handleApiError = (error: unknown): void => {
    console.error("Original API Error:", error);
    let message: string;
    let errorCode: string | undefined;

    if (error instanceof Error) {
        message = error.message;
    } else {
        message = String(error);
    }
    
    // Try to parse JSON-like error messages to get a specific code
    try {
        const jsonMatch = message.match(/(\{.*\})/s);
        if (jsonMatch && jsonMatch[0]) {
            const errorObj = JSON.parse(jsonMatch[0]);
            if (errorObj?.error?.code) {
                errorCode = String(errorObj.error.code);
            }
        }
    } catch (e) {
        // Not a valid JSON string, continue to regex matching
    }
    
    // If no code from JSON, try a regex on the whole message for bracketed codes
    if (!errorCode) {
        const codeMatch = message.match(/\[(\d{3})\]|\b(\d{3})\b/);
        if (codeMatch) {
            errorCode = codeMatch[1] || codeMatch[2];
        }
    }

    const lowerCaseMessage = message.toLowerCase();
    
    // Infer error code if not explicitly found
    if (!errorCode) {
        if (lowerCaseMessage.includes('permission denied') || lowerCaseMessage.includes('api key not valid')) {
            errorCode = '403';
        } else if (lowerCaseMessage.includes('resource exhausted')) {
            errorCode = '429';
        } else if (lowerCaseMessage.includes('bad request')) {
            errorCode = '400';
        } else if (lowerCaseMessage.includes('server error') || lowerCaseMessage.includes('503')) {
            errorCode = '500';
        } else if (lowerCaseMessage.includes('failed to fetch')) {
            errorCode = 'NET';
        }
    }

    // ============ VEO KEY ERROR DETECTION & AUTO-FIX TRIGGER ============
    const isVeoError = (
        (errorCode === '403' || errorCode === '401') &&
        (lowerCaseMessage.includes('veo') || 
         lowerCaseMessage.includes('video') ||
         lowerCaseMessage.includes('auth token') ||
         lowerCaseMessage.includes('unauthorized'))
    ) || lowerCaseMessage.includes('veo authentication failed') || lowerCaseMessage.includes('veo auth token is required');

    if (isVeoError) {
        console.log("VEO auth error detected, triggering auto-fix...");
        eventBus.dispatch('initiateAutoVeoKeyClaim');
        // Throw an error so the UI can update
        throw new Error("Veo authorization failed. Attempting to refresh token automatically. Please try again in a moment.");
    }

    // ============ API KEY ERROR DETECTION & AUTO-FIX TRIGGER ============
    const isApiKeyError = (errorCode === '403' || errorCode === '401') || 
                         (errorCode === '400' && lowerCaseMessage.includes('api key not valid'));

    if (isApiKeyError) {
        console.log("API key error detected, triggering auto-fix...");
        eventBus.dispatch('initiateAutoApiKeyClaim');
        // Throw an error so the UI can update
        throw new Error("API Key is invalid or has expired. Attempting to claim a new key automatically. Please try again in a moment.");
    }
    
    // For all other errors, create a user-friendly message and throw it.
    let suggestion = '';
    
    const hasExistingSuggestion = 
        lowerCaseMessage.includes('please ensure') || 
        lowerCaseMessage.includes('please try');

    if (!hasExistingSuggestion) {
        if (errorCode === '400') {
            suggestion = 'Your prompt or image may have been blocked by safety filters. Please try rephrasing your request or using a different image.';
        } else if (errorCode === '429') {
            suggestion = 'You\'ve sent too many requests in a short time. Please wait a minute before trying again.';
        } else if (errorCode === '500' || errorCode === '503') {
            suggestion = 'There was a temporary issue on Google\'s side. Please try again in a few moments.';
        }
    }
    
    let userFriendlyMessage = message.split('\n')[0];
    if (lowerCaseMessage.includes('api key not valid')) {
        userFriendlyMessage = 'Your API Key is not valid.';
    }
    if (suggestion) {
        userFriendlyMessage += `\n\nSuggestion: ${suggestion}`;
    }

    // Throw a new, formatted error that UI components can catch and display.
    throw new Error(`[Code: ${errorCode || 'N/A'}] ${userFriendlyMessage}`);
};
