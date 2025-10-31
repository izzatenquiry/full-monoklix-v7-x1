import { GoogleGenAI, Chat, GenerateContentResponse, Modality } from "@google/genai";
import { addLogEntry } from './aiLogService';
import { triggerUserWebhook } from './webhookService';
import { MODELS } from './aiConfig';
import { handleApiError } from "./errorHandler";
import { generateVideoWithVeo3, checkVideoStatus, uploadImageForVeo3 } from './veo3Service';
import { cropImageToAspectRatio } from "./imageService";
import { decodeBase64, createWavBlob } from '../utils/audioUtils';
import { incrementImageUsage, incrementVideoUsage } from './userService';
// FIX: Import addHistoryItem from historyService to resolve the 'Cannot find name' error.
import { addHistoryItem } from "./historyService";
import eventBus from "./eventBus";


const getActiveApiKey = (): string | null => {
    // This key is set and managed by App.tsx, which places the correct key
    // (either user's personal key or a temporary claimed key) into session storage.
    return sessionStorage.getItem('monoklix_session_api_key');
};

const getAiInstance = () => { // No longer async
    const keyToUse = getActiveApiKey();
    if (!keyToUse) {
        throw new Error(`API Key not found. Please set a key in Settings or claim a temporary one.`);
    }
    return new GoogleGenAI({ apiKey: keyToUse });
};

// Smart proxy URL that works for both production and local development
const getProxyBaseUrl = (): string => {
  const isProduction = window.location.hostname !== 'localhost' && 
                       window.location.hostname !== '127.0.0.1';

  if (isProduction) {
    // Production proxy server
    return 'https://s2.monoklix.com';
  } else {
    // Local development proxy server
    return 'http://localhost:3001';
  }
};

const getCurrentUserId = (): string | null => {
    try {
        const savedUserJson = localStorage.getItem('currentUser');
        if (savedUserJson) {
            const user = JSON.parse(savedUserJson);
            if (user && user.id) {
                return user.id;
            }
        }
    } catch (error) {
        console.error("Failed to parse user from localStorage for usage tracking.", error);
    }
    return null;
};

export interface MultimodalContent {
    base64: string;
    mimeType: string;
}

/**
 * Creates a new chat session with a given system instruction.
 * @param {string} systemInstruction - The system instruction for the chat model.
 * @returns {Promise<Chat>} A new chat instance.
 */
// FIX: Made `createChatSession` an async function to correctly return a Promise<Chat> as declared in its signature, resolving the type mismatch where a sync `Chat` object was being returned.
export const createChatSession = async (systemInstruction: string): Promise<Chat> => {
  const ai = getAiInstance();
  return ai.chats.create({
    model: MODELS.text,
    config: {
      systemInstruction: systemInstruction,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
};

/**
 * Sends a message in a chat session and returns the streaming response.
 * @param {Chat} chat - The chat instance.
 * @param {string} prompt - The user's prompt.
 * @returns {Promise<AsyncGenerator<GenerateContentResponse>>} The streaming response from the model.
 */
export const streamChatResponse = async (chat: Chat, prompt: string) => {
    try {
        const stream = await chat.sendMessageStream({ message: prompt });
        addLogEntry({
            model: `${MODELS.text} (stream)`,
            prompt,
            output: 'Streaming response started...',
            tokenCount: 0, 
            status: 'Success'
        });
        return stream;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLogEntry({
            model: `${MODELS.text} (stream)`,
            prompt,
            output: `Error: ${errorMessage}`,
            tokenCount: 0,
            status: 'Error',
            error: errorMessage
        });
        handleApiError(error); // This will re-throw a formatted error
        throw error; // This line is technically unreachable but good for type safety
    }
};

/**
 * Generates images based on a text prompt.
 * @param {string} prompt - The text prompt for image generation.
 * @param {string} [negativePrompt] - A prompt of what not to include.
 * @returns {Promise<string[]>} An array of base64 encoded image strings.
 */
export const generateImages = async (
    prompt: string, 
    negativePrompt?: string
): Promise<string[]> => {
    const model = MODELS.imageGeneration;
    
    // Construct the full prompt
    let fullPrompt = prompt;
    // Add negative prompt instruction to the prompt
    if (negativePrompt) {
        fullPrompt += `\n\nNegative prompt (things to avoid in the image): ${negativePrompt}`;
    }

    try {
        const ai = getAiInstance();
        const response = await ai.models.generateContent({
            model,
            contents: {
                parts: [{ text: fullPrompt }],
            },
            config: {
                responseModalities: [Modality.IMAGE],
            },
        });

        const images: string[] = [];
        if (response.candidates && response.candidates.length > 0) {
            for (const candidate of response.candidates) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inlineData) {
                            images.push(part.inlineData.data);
                        }
                    }
                }
            }
        }
        
        if (images.length === 0) {
             const safetyFeedback = response.candidates?.[0]?.safetyRatings;
            if (safetyFeedback) {
                const blockedCategories = safetyFeedback
                    .filter(rating => rating.blocked)
                    .map(rating => rating.category);
                if (blockedCategories.length > 0) {
                     throw new Error(`The AI did not return an image. Your prompt may have been blocked by safety filters for these categories: ${blockedCategories.join(', ')}. Please try a different prompt.`);
                }
            }
            throw new Error("The AI did not return an image. This could be due to a safety block or an issue with the prompt. Please try again with a different prompt.");
        }

        addLogEntry({
            model,
            prompt: fullPrompt,
            output: `${images.length} image(s) generated.`,
            tokenCount: response.usageMetadata?.totalTokenCount ?? 0,
            status: 'Success',
            mediaOutput: images.length > 0 ? images[0] : undefined
        });

        const userId = getCurrentUserId();
        if (userId) {
            const updateResult = await incrementImageUsage(userId);
            if (updateResult.success && updateResult.user) {
                eventBus.dispatch('userUsageUpdated', updateResult.user);
            }
        }

        images.forEach(imgBase64 => {
            triggerUserWebhook({ type: 'image', prompt: fullPrompt, result: imgBase64, mimeType: 'image/png' });
        });
        return images;

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLogEntry({ model, prompt: fullPrompt, output: `Error: ${errorMessage}`, tokenCount: 0, status: 'Error', error: errorMessage });
        handleApiError(error);
        throw error;
    }
};

/**
 * Generates a video from a text prompt and an optional image using the Veo3 service.
 * @param {string} prompt - The text prompt for video generation.
 * @param {string} model - The video generation model to use.
 * @param {string} aspectRatio - The desired aspect ratio.
 * @param {string} resolution - The resolution (used by Veo3).
 * @param {string} negativePrompt - A negative prompt.
 * @param {{ imageBytes: string; mimeType: string }} [image] - Optional image data.
 * @returns {Promise<{ videoUrl?: string; thumbnailUrl: string | null; videoBlobPromise?: Promise<File> }>} The generated video as a streamable URL and a promise for the video blob.
 */
export const generateVideo = async (
    prompt: string,
    model: string,
    aspectRatio: string,
    resolution: string,
    negativePrompt: string,
    image: { imageBytes: string, mimeType: string } | undefined,
    historyPrompt?: string,
): Promise<{ videoUrl: string; thumbnailUrl: string | null; videoBlobPromise?: Promise<File> }> => {

    const getTokens = (): { token: string; createdAt: string }[] => {
        const tokensJSON = sessionStorage.getItem('veoAuthTokens');
        if (tokensJSON) {
            try {
                const parsed = JSON.parse(tokensJSON);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed;
                }
            } catch (e) {
                console.error("Could not parse VEO tokens from session storage", e);
            }
        }
        return [];
    };

    const tokens = getTokens();

    if (tokens.length === 0) {
        const error = new Error("Veo Auth Token is required for Veo 3.0 models. Please set it using the Key icon in the header.");
        handleApiError(error);
        throw error;
    }

    let lastError: any = null;

    for (let i = 0; i < tokens.length; i++) {
        const currentAuthToken = tokens[i].token;
        addLogEntry({ model, prompt: `Attempting video generation with token #${i + 1}`, output: `Using token ending in ...${currentAuthToken.slice(-6)}`, tokenCount: 0, status: "Success" });

        try {
            let processedImage = image;

            if (image && (aspectRatio === '16:9' || aspectRatio === '9:16')) {
                try {
                    addLogEntry({ model, prompt: "Cropping reference image...", output: `Cropping to ${aspectRatio}...`, tokenCount: 0, status: "Success" });
                    const croppedBase64 = await cropImageToAspectRatio(image.imageBytes, aspectRatio);
                    processedImage = {
                        ...image,
                        imageBytes: croppedBase64,
                    };
                } catch (cropError) {
                    console.error("Image cropping failed, proceeding with original image.", cropError);
                    addLogEntry({ model, prompt: "Image cropping failed", output: "Proceeding with original image.", tokenCount: 0, status: "Error", error: cropError instanceof Error ? cropError.message : String(cropError) });
                }
            }

            const veo3AspectRatio = (ar: string): 'landscape' | 'portrait' => {
                if (ar === '9:16' || ar === '3:4') return 'portrait';
                return 'landscape';
            };
            const aspectRatioForVeo3 = veo3AspectRatio(aspectRatio);

            let imageMediaId: string | undefined = undefined;
            if (processedImage) {
                addLogEntry({ model, prompt: "Uploading reference image...", output: "In progress...", tokenCount: 0, status: "Success" });
                imageMediaId = await uploadImageForVeo3(processedImage.imageBytes, processedImage.mimeType, aspectRatioForVeo3, currentAuthToken);
            }

            const useStandardModel = !model.includes('fast');
            
            addLogEntry({ model, prompt, output: "Starting video generation via proxy...", tokenCount: 0, status: "Success" });
            const initialOperations = await generateVideoWithVeo3({
                prompt,
                imageMediaId,
                config: { authToken: currentAuthToken, aspectRatio: aspectRatioForVeo3, useStandardModel },
            });

            if (!initialOperations || initialOperations.length === 0) {
                throw new Error("Video generation failed to start. The API did not return any operations.");
            }

            let finalOperations: any[] = initialOperations;
            let finalUrl: string | null = null;
            let thumbnailUrl: string | null = null;
            const POLL_INTERVAL = 10000;

            while (!finalUrl) {
                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
                addLogEntry({ model, prompt, output: `Checking video status...`, tokenCount: 0, status: "Success" });

                const statusResponse = await checkVideoStatus(finalOperations, currentAuthToken);
                if (!statusResponse?.operations || statusResponse.operations.length === 0) {
                    console.warn('⚠️ Empty status response, retrying...');
                    continue;
                }

                finalOperations = statusResponse.operations;
                const opStatus = finalOperations[0];
                
                const isCompleted = opStatus.done === true || ['MEDIA_GENERATION_STATUS_COMPLETED', 'MEDIA_GENERATION_STATUS_SUCCESS', 'MEDIA_GENERATION_STATUS_SUCCESSFUL'].includes(opStatus.status);

                if (isCompleted) {
                    finalUrl = opStatus.operation?.metadata?.video?.fifeUrl
                               || opStatus.metadata?.video?.fifeUrl
                               || opStatus.result?.generatedVideo?.[0]?.fifeUrl
                               || opStatus.result?.generatedVideos?.[0]?.fifeUrl
                               || opStatus.video?.fifeUrl
                               || opStatus.fifeUrl;
                    
                    thumbnailUrl = opStatus.operation?.metadata?.video?.servingBaseUri
                                || opStatus.metadata?.video?.servingBaseUri
                                || null;
                    
                    if (!finalUrl) {
                        console.error('Operation finished but no video URL was returned. Full operation object:', JSON.stringify(opStatus, null, 2));
                        throw new Error("Video generation finished without an error, but no output was produced. This may happen if your request was blocked by safety policies. Please try modifying your prompt or using a different image.");
                    }
                } else if (opStatus.error) {
                    throw new Error(`Video generation failed: ${opStatus.error.message || opStatus.error.code || 'Unknown error'}`);
                } else if (opStatus.status === 'MEDIA_GENERATION_STATUS_FAILED') {
                    console.error('❌ Video generation failed with status FAILED. Full operation object:', JSON.stringify(opStatus, null, 2));
                    throw new Error("Video generation failed on the server. This often happens if your request was blocked by safety policies. Please try modifying your prompt or using a different image.");
                }
            }
            
            addLogEntry({ model, prompt, output: "Video ready for streaming.", tokenCount: 0, status: "Success" });
            const proxyDownloadUrl = `${getProxyBaseUrl()}/api/veo/download-video?url=${encodeURIComponent(finalUrl)}`;

            const videoBlobPromise = fetch(proxyDownloadUrl)
                .then(res => {
                    if (!res.ok) throw new Error(`Background download failed: ${res.status}`);
                    return res.blob();
                })
                .then(blob => new File([blob], `monoklix-veo3-${Date.now()}.mp4`, { type: 'video/mp4' }));

            videoBlobPromise.then(async (file) => {
                const finalPrompt = historyPrompt || `Video: ${prompt}`;
                addLogEntry({ model, prompt: finalPrompt, output: '1 video generated successfully (streamed).', tokenCount: 0, status: 'Success', mediaOutput: file });
                triggerUserWebhook({ type: 'video', prompt: finalPrompt, result: file });
                await addHistoryItem({ type: 'Video', prompt: finalPrompt, result: file });
                const userId = getCurrentUserId();
                if (userId) {
                    const updateResult = await incrementVideoUsage(userId);
                    if (updateResult.success && updateResult.user) {
                        eventBus.dispatch('userUsageUpdated', updateResult.user);
                    }
                }
            }).catch(err => {
                console.error("Error saving streamed video to history:", err);
            });

            // If we get here, the token worked, so we return the result.
            return { videoUrl: proxyDownloadUrl, thumbnailUrl, videoBlobPromise };

        } catch (error) {
            lastError = error;
            const errorMessage = error instanceof Error ? error.message : String(error);
            addLogEntry({ model, prompt, output: `Token #${i + 1} failed: ${errorMessage}`, tokenCount: 0, status: 'Error', error: errorMessage });
            
            if (i < tokens.length - 1) {
                addLogEntry({ model, prompt: `Retrying with next token...`, output: 'Fallback mechanism initiated.', tokenCount: 0, status: "Success" });
            }
        }
    }

    // If the loop finishes, all tokens have failed.
    addLogEntry({ model, prompt, output: `All VEO auth tokens failed.`, tokenCount: 0, status: 'Error', error: lastError instanceof Error ? lastError.message : String(lastError) });
    handleApiError(lastError);
    throw lastError;
};


/**
 * Generates text content from a prompt and one or more images.
 * @param {string} prompt - The text prompt.
 * @param {MultimodalContent[]} images - An array of image objects.
 * @returns {Promise<string>} The text response from the model.
 */
export const generateMultimodalContent = async (prompt: string, images: MultimodalContent[]): Promise<string> => {
    const model = MODELS.text;
    try {
        const ai = getAiInstance();
        const textPart = { text: prompt };
        const imageParts = images.map(image => ({
            inlineData: {
                mimeType: image.mimeType,
                data: image.base64,
            },
        }));

        const response = await ai.models.generateContent({
            model,
            contents: { parts: [...imageParts, textPart] },
            config: {
                thinkingConfig: { thinkingBudget: 0 },
            }
        });
        
        const textOutput = response.text ?? '';

        addLogEntry({
            model,
            prompt: `${prompt} [${images.length} image(s)]`,
            output: textOutput,
            tokenCount: response.usageMetadata?.totalTokenCount ?? 0,
            status: 'Success'
        });
        triggerUserWebhook({ type: 'text', prompt, result: textOutput });
        return textOutput;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLogEntry({ model, prompt: `${prompt} [${images.length} image(s)]`, output: `Error: ${errorMessage}`, tokenCount: 0, status: 'Error', error: errorMessage });
        handleApiError(error);
        throw error;
    }
};

/**
 * Edits or composes an image based on a text prompt and one or more source images.
 * @param {string} prompt - The editing instruction.
 * @param {MultimodalContent[]} images - The base64 encoded images to use.
 * @returns {Promise<{text?: string, imageBase64?: string}>} An object containing the text response and/or the edited image.
 */
export const composeImage = async (prompt: string, images: MultimodalContent[]): Promise<{text?: string, imageBase64?: string}> => {
    const model = MODELS.imageEdit;
    const webhookPrompt = `${prompt} [${images.length} image(s)]`;
    try {
        const ai = getAiInstance();
        const textPart = { text: prompt };
        const imageParts = images.map(image => ({
            inlineData: {
                data: image.base64,
                mimeType: image.mimeType,
            },
        }));

        const response = await ai.models.generateContent({
            model,
            contents: {
                parts: [...imageParts, textPart ],
            },
            config: {
                responseModalities: [Modality.IMAGE, Modality.TEXT],
            },
        });

        const result: { text?: string; imageBase64?: string } = {};

        if (response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.text) {
                    result.text = part.text;
                } else if (part.inlineData) {
                    result.imageBase64 = part.inlineData.data;
                }
            }
        }
        
        addLogEntry({
            model,
            prompt: webhookPrompt,
            output: result.imageBase64 ? '1 image generated.' : (result.text || 'No output.'),
            tokenCount: response.usageMetadata?.totalTokenCount ?? 0,
            status: 'Success',
            mediaOutput: result.imageBase64
        });

        if (result.imageBase64) {
            triggerUserWebhook({ type: 'image', prompt: webhookPrompt, result: result.imageBase64, mimeType: 'image/png' });
            const userId = getCurrentUserId();
            if (userId) {
                const updateResult = await incrementImageUsage(userId);
                if (updateResult.success && updateResult.user) {
                    eventBus.dispatch('userUsageUpdated', updateResult.user);
                }
            }
        }
        if (result.text) {
             triggerUserWebhook({ type: 'text', prompt: webhookPrompt, result: result.text });
        }
        return result;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLogEntry({ model, prompt: webhookPrompt, output: `Error: ${errorMessage}`, tokenCount: 0, status: 'Error', error: errorMessage });
        handleApiError(error);
        throw error;
    }
};

/**
 * Generates text content from a text-only prompt.
 * @param {string} prompt - The text prompt.
 * @returns {Promise<string>} The text response from the model.
 */
export const generateText = async (prompt: string): Promise<string> => {
    const model = MODELS.text;
    try {
        const ai = getAiInstance();
        const response = await ai.models.generateContent({
            model,
            contents: { parts: [{ text: prompt }] },
            config: {
                thinkingConfig: { thinkingBudget: 0 },
            }
        });
        
        const textOutput = response.text ?? '';

        addLogEntry({
            model,
            prompt,
            output: textOutput,
            tokenCount: response.usageMetadata?.totalTokenCount ?? 0,
            status: 'Success'
        });
        triggerUserWebhook({ type: 'text', prompt, result: textOutput });
        return textOutput;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLogEntry({ model, prompt, output: `Error: ${errorMessage}`, tokenCount: 0, status: 'Error', error: errorMessage });
        handleApiError(error);
        throw error;
    }
};

/**
 * Generates text content with Google Search grounding for up-to-date information.
 * @param {string} prompt - The text prompt.
 * @returns {Promise<GenerateContentResponse>} The full response object from the model, including grounding metadata.
 */
export const generateContentWithGoogleSearch = async (prompt: string): Promise<GenerateContentResponse> => {
    const model = MODELS.text;
    try {
        const ai = getAiInstance();
        const response = await ai.models.generateContent({
            model,
            contents: { parts: [{ text: prompt }] },
            config: {
                tools: [{ googleSearch: {} }],
                thinkingConfig: { thinkingBudget: 0 },
            },
        });

        const textOutput = response.text ?? '';

        addLogEntry({
            model,
            prompt,
            output: textOutput,
            tokenCount: response.usageMetadata?.totalTokenCount ?? 0,
            status: 'Success'
        });
        triggerUserWebhook({ type: 'text', prompt, result: textOutput });
        return response; // Return the whole object
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLogEntry({ model, prompt, output: `Error: ${errorMessage}`, tokenCount: 0, status: 'Error', error: errorMessage });
        handleApiError(error);
        throw error;
    }
};

/**
 * Generates a voice-over from a text script using Google Cloud's Text-to-Speech API.
 * @param {string} script - The text to convert to speech.
 * @param {string} actorId - The ID of the voice actor (e.g., 'en-US-Standard-A').
 * @param {string} language - The language to speak in.
 * @param {string} mood - The desired mood for the voice.
 * @returns {Promise<Blob | null>} A blob containing the generated audio file, or null on error.
 */
export const generateVoiceOver = async (
    script: string,
    actorId: string,
    language: string,
    mood: string,
    generationMode: 'speak' | 'sing',
    musicStyle?: string
): Promise<Blob | null> => {
    const model = 'gemini-2.5-flash-preview-tts';
    const webhookPrompt = generationMode === 'sing'
        ? `Sing: ${musicStyle}, Voice: ${actorId}, Lang: ${language}, Script: ${script.substring(0, 100)}...`
        : `Voice: ${actorId}, Lang: ${language}, Mood: ${mood}, Script: ${script.substring(0, 100)}...`;
    
    try {
        const ai = getAiInstance();

        let fullPrompt = '';

        if (generationMode === 'sing') {
            let singInstruction = `Sing the following lyrics in a ${musicStyle || 'pop'} music style`;
            if (language === 'Bahasa Melayu') {
                singInstruction = `Nyanyikan lirik berikut dalam gaya muzik ${musicStyle || 'pop'} dalam Bahasa Melayu`;
            }
            fullPrompt = `${singInstruction}: "${script}"`;
        } else { // 'speak'
            const moodInstructionMap: { [key: string]: string } = {
                'Normal': '',
                'Ceria': 'Say cheerfully: ',
                'Semangat': 'Say with an energetic and enthusiastic tone: ',
                'Jualan': 'Say in a persuasive and compelling sales tone: ',
                'Sedih': 'Say in a sad and melancholic tone: ',
                'Berbisik': 'Say in a whispering tone: ',
                'Marah': 'Say in an angry tone: ',
                'Tenang': 'Say in a calm and soothing tone: ',
                'Rasmi': 'Say in a formal and professional tone: ',
                'Teruja': 'Say in an excited tone: ',
                'Penceritaan': 'Say in a storytelling tone: ',
                'Berwibawa': 'Say in an authoritative and firm tone: ',
                'Mesra': 'Say in a friendly and warm tone: '
            };
            
            const moodInstruction = moodInstructionMap[mood as keyof typeof moodInstructionMap] || '';
            
            let languageInstruction = '';
            if (language === 'Bahasa Melayu') {
                languageInstruction = 'Sebutkan yang berikut dalam Bahasa Melayu yang jelas: ';
            }
            
            fullPrompt = `${languageInstruction}${moodInstruction}${script}`;
        }


        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: fullPrompt }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: actorId },
                    },
                },
            },
        });

        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        
        if (!base64Audio) {
            throw new Error("No audio data received from API.");
        }
        
        // The TTS API returns raw PCM data at 24kHz, 1 channel, 16-bit.
        const pcmData = decodeBase64(base64Audio);
        const wavBlob = createWavBlob(pcmData, 24000, 1, 16);

        addLogEntry({
            model,
            prompt: webhookPrompt,
            output: '1 audio file generated.',
            tokenCount: 0, // Not applicable
            status: 'Success',
            mediaOutput: wavBlob
        });
        
        triggerUserWebhook({ type: 'audio', prompt: webhookPrompt, result: wavBlob });
        return wavBlob;

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLogEntry({
            model,
            prompt: webhookPrompt,
            output: `Error: ${errorMessage}`,
            tokenCount: 0,
            status: 'Error',
            error: errorMessage
        });
        handleApiError(error);
        throw error;
    }
};

/**
 * Runs a minimal, non-blocking health check on an API key for critical services.
 * @param {string} apiKeyToCheck - The API key to test.
 * @returns {Promise<{ image: boolean; veo3: boolean; }>} A promise that resolves to the status of image and VEO 3 models.
 */
export const runMinimalHealthCheck = async (apiKeyToCheck: string): Promise<{ image: boolean; veo3: boolean; }> => {
    if (!apiKeyToCheck) {
        return { image: false, veo3: false };
    }

    const ai = new GoogleGenAI({ apiKey: apiKeyToCheck });

    // A tiny, valid transparent PNG for image model checks
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    const imageCheckPromise = ai.models.generateContent({
        model: MODELS.imageEdit,
        contents: { parts: [{ inlineData: { data: tinyPngBase64, mimeType: 'image/png' } }, { text: 'test' }] },
        config: { responseModalities: [Modality.TEXT] }, // Only need a successful call, not an image back.
    });

    const veo3CheckPromise = ai.models.generateVideos({ 
        model: 'veo-3.0-generate-001', 
        prompt: 'test', 
        config: { numberOfVideos: 1 } 
    });

    const [imageResult, veo3Result] = await Promise.allSettled([imageCheckPromise, veo3CheckPromise]);
    
    // Log failures for debugging without throwing
    if (imageResult.status === 'rejected') console.debug(`Minimal health check failed for image:`, (imageResult.reason as Error).message);
    if (veo3Result.status === 'rejected') console.debug(`Minimal health check failed for VEO 3:`, (veo3Result.reason as Error).message);

    const isImageOk = imageResult.status === 'fulfilled';
    // A fulfilled promise for generateVideos returns an Operation.
    // If the operation has an `error` property immediately, it's a failure.
    // This handles cases where the promise resolves but the operation is invalid from the start.
    const isVeo3Ok = veo3Result.status === 'fulfilled' && !(veo3Result.value as any).error;

    return {
        image: isImageOk,
        veo3: isVeo3Ok,
    };
};

/**
 * A lightweight check specifically for the image model, for auto-key-claiming.
 * @param {string} apiKeyToCheck - The API key to test.
 * @returns {Promise<boolean>} A promise that resolves to true if the image model is accessible.
 */
export const isImageModelHealthy = async (apiKeyToCheck: string): Promise<boolean> => {
    if (!apiKeyToCheck) return false;

    try {
        const ai = new GoogleGenAI({ apiKey: apiKeyToCheck });
        const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        
        await ai.models.generateContent({
            model: MODELS.imageEdit,
            contents: { parts: [{ inlineData: { data: tinyPngBase64, mimeType: 'image/png' } }, { text: 'test' }] },
            config: { responseModalities: [Modality.TEXT] },
        });
        
        return true;
    } catch (error) {
        console.debug(`Image model health check failed for key:`, (error as Error).message);
        return false;
    }
};

/**
 * Checks the validity of a specific user's API key.
 * @param {string} apiKeyToCheck The API key to validate.
 * @returns {Promise<{ success: boolean; message: string; }>} An object indicating if the key is valid.
 */
export const checkUserApiKey = async (apiKeyToCheck: string): Promise<{ success: boolean; message: string; }> => {
    if (!apiKeyToCheck) {
        return { success: false, message: 'API Key is empty.' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKeyToCheck });
        // Use a very lightweight call to check the key's validity.
        // The image editing model is a good target for this.
        const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        
        await ai.models.generateContent({
            model: MODELS.imageEdit,
            contents: { parts: [{ inlineData: { data: tinyPngBase64, mimeType: 'image/png' } }, { text: 'test' }] },
            config: { responseModalities: [Modality.TEXT] },
        });
        
        return { success: true, message: 'API Key is valid.' };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message.split('\n')[0] : 'Unknown validation error.';
        console.debug(`User API key check failed:`, errorMessage);
        return { success: false, message: errorMessage };
    }
};


// --- ADMIN API HEALTH CHECK ---

export interface HealthCheckResult {
    service: string;
    model: string;
    status: 'operational' | 'error' | 'degraded';
    message: string;
    details?: string;
}

const getShortErrorMessage = (e: any): string => {
    let message = e.message || String(e);
    try {
        // If the message is a JSON string, parse it and get the core message.
        const errorObj = JSON.parse(message);
        if (errorObj?.error?.message) {
            message = errorObj.error.message;
        } else if (errorObj?.message) {
            message = errorObj.message;
        }
    } catch (parseError) {
        // Not a JSON string, proceed with the original message.
    }

    // Return the first line of the potentially cleaned message.
    const firstLine = message.split('\n')[0];
    if (firstLine.startsWith('[GoogleGenerativeAI Error]: ')) {
        return firstLine.replace('[GoogleGenerativeAI Error]: ', '');
    }
    
    return firstLine;
};

export const runApiHealthCheck = async (keys: { textKey?: string }): Promise<HealthCheckResult[]> => {
    const { textKey } = keys;

    if (!textKey) {
        throw new Error("An API Key is required for a health check.");
    }

    const ai = new GoogleGenAI({ apiKey: textKey });
    const results: HealthCheckResult[] = [];

    // 1. Text Generation
    try {
        await ai.models.generateContent({ model: MODELS.text, contents: 'test', config: { maxOutputTokens: 2, thinkingConfig: { thinkingBudget: 1 } } });
        results.push({ service: 'Text Generation', model: MODELS.text, status: 'operational', message: 'OK' });
    } catch (e: any) {
        results.push({ service: 'Text Generation', model: MODELS.text, status: 'error', message: getShortErrorMessage(e) });
    }
    
    // 2. Image Generation/Editing
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    try {
        await ai.models.generateContent({
            model: MODELS.imageEdit,
            contents: { parts: [{ inlineData: { data: tinyPngBase64, mimeType: 'image/png' } }, { text: 'test' }] },
            config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
        });
        results.push({ service: 'Image Generation/Editing', model: MODELS.imageEdit, status: 'operational', message: 'OK' });
    } catch (e: any) {
        results.push({ service: 'Image Generation/Editing', model: MODELS.imageEdit, status: 'error', message: getShortErrorMessage(e) });
    }

    // 3. VEO 3.1 Generation
    const getTokens = (): { token: string; createdAt: string }[] => {
        const tokensJSON = sessionStorage.getItem('veoAuthTokens');
        if (tokensJSON) {
            try {
                const parsed = JSON.parse(tokensJSON);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            } catch (e) { console.error("Could not parse VEO tokens for health check", e); }
        }
        return [];
    };

    const veoTokens = getTokens();
    const videoModel = MODELS.videoGenerationDefault;

    if (veoTokens.length === 0) {
        results.push({ service: 'VEO 3.1 Generation', model: videoModel, status: 'degraded', message: 'Health check skipped. Auth Token not found.' });
    } else {
        let success = false;
        let lastError: any = null;

        for (let i = 0; i < veoTokens.length; i++) {
            const currentToken = veoTokens[i].token;
            try {
                const initialOperations = await generateVideoWithVeo3({
                    prompt: 'test',
                    config: {
                        authToken: currentToken,
                        aspectRatio: 'landscape',
                        useStandardModel: !videoModel.includes('fast'),
                    },
                });

                if (!initialOperations || initialOperations.length === 0 || (initialOperations[0] as any).error) {
                    throw new Error((initialOperations[0] as any)?.error?.message || 'Initial request failed without specific error.');
                }
                
                results.push({ 
                    service: 'VEO 3.1 Generation', 
                    model: videoModel, 
                    status: 'operational', 
                    message: 'Initial request successful.',
                    details: `(Using token #${i + 1})`
                });
                success = true;
                break;
            } catch (e: any) {
                lastError = e;
            }
        }

        if (!success) {
            results.push({ 
                service: 'VEO 3.1 Generation', 
                model: videoModel, 
                status: 'error', 
                message: getShortErrorMessage(lastError),
                details: '(All available tokens failed)'
            });
        }
    }

    return results;
};