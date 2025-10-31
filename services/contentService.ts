import { type TutorialContent, type PlatformStatus, type Announcement, type ViralPrompt } from '../types';
import { saveData, loadData } from './indexedDBService';
import { supabase } from './supabaseClient';
import { MODELS } from './aiConfig';

const TUTORIAL_CONTENT_KEY = 'monoklix-ai-tutorial-content';
const PLATFORM_STATUS_KEY = 'monoklix-ai-platform-status';
const ANNOUNCEMENTS_KEY = 'monoklix-ai-announcements';

const defaultTutorialContent: TutorialContent = {
  mainVideoUrl: 'https://www.youtube.com/embed/G6G8JJrV9VM',
  mainTitle: 'Welcome to the MONOKlix.com',
  mainDescription: 'Welcome! This video is your introduction to the MONOKlix.com platform. Understand the overview, powerful features, and how to get started on your creative projects with the help of AI.',
  tutorials: [
    // Temporarily disabled as per user request.
  ]
};

const defaultPlatformStatus: PlatformStatus = {
    status: 'operational',
    message: 'All services are running smoothly.',
    lastUpdated: new Date().toISOString(),
};

const defaultAnnouncements: Announcement[] = [
    {
        id: 'anno-1',
        title: 'Welcome to the New Platform!',
        content: 'We are excited to launch the all-new MONOKlix.com AI platform. Explore the features and start creating today.',
        category: 'General',
        createdAt: new Date().toISOString(),
    },
];

export const getContent = async (): Promise<TutorialContent> => {
  try {
    const savedContent = await loadData<TutorialContent>(TUTORIAL_CONTENT_KEY);
    if (savedContent) {
      // Basic validation to merge with default if structure changed
      return { ...defaultTutorialContent, ...savedContent, tutorials: savedContent.tutorials || defaultTutorialContent.tutorials };
    }
    return defaultTutorialContent;
  } catch (error) {
    console.error("Failed to parse tutorial content from IndexedDB:", error);
    return defaultTutorialContent;
  }
};

export const saveContent = async (content: TutorialContent) => {
  try {
    await saveData(TUTORIAL_CONTENT_KEY, content);
  } catch (error) {
    console.error("Failed to save tutorial content to IndexedDB:", error);
  }
};

// --- Platform Status and Announcements ---

export const getPlatformStatus = async (): Promise<PlatformStatus> => {
    const savedStatus = await loadData<PlatformStatus>(PLATFORM_STATUS_KEY);
    return savedStatus || defaultPlatformStatus;
};

export const savePlatformStatus = async (status: PlatformStatus) => {
    await saveData(PLATFORM_STATUS_KEY, status);
};

export const getAnnouncements = async (): Promise<Announcement[]> => {
    const savedAnnouncements = await loadData<Announcement[]>(ANNOUNCEMENTS_KEY);
    return savedAnnouncements || defaultAnnouncements;
};

export const saveAnnouncements = async (announcements: Announcement[]) => {
    await saveData(ANNOUNCEMENTS_KEY, announcements);
};

export const getGenerationStats = async (): Promise<{ imageCount: number; videoCount: number }> => {
    try {
        // Count successful image generations from both image generation and image editing models
        const { count: imageCount, error: imageError } = await supabase
            .from('activity_log')
            .select('id', { count: 'exact', head: true })
            .eq('activity_type', 'ai_generation')
            .eq('status', 'Success')
            .in('model', [MODELS.imageGeneration, MODELS.imageEdit]);

        if (imageError) {
            console.error("Error fetching image generation stats:", imageError);
            throw imageError;
        }

        // Count successful video generations by looking for 'veo' in the model name
        const { count: videoCount, error: videoError } = await supabase
            .from('activity_log')
            .select('id', { count: 'exact', head: true })
            .eq('activity_type', 'ai_generation')
            .eq('status', 'Success')
            .like('model', '%veo%');

        if (videoError) {
            console.error("Error fetching video generation stats:", videoError);
            throw videoError;
        }

        return {
            imageCount: imageCount ?? 0,
            videoCount: videoCount ?? 0,
        };
    } catch (error) {
        console.error("Error fetching overall generation stats:", error);
        // Return 0 on error to prevent UI crashing
        return { imageCount: 0, videoCount: 0 };
    }
};


// --- Prompt Viral MY ---
export const getViralPrompts = async (): Promise<ViralPrompt[]> => {
    const { data, error } = await supabase
        .from('prompt_viral_my')
        .select('*')
        .order('id', { ascending: true });

    if (error) {
        console.error("Error fetching viral prompts:", error);
        return [];
    }

    // Map snake_case from DB to camelCase for frontend consistency
    return data.map(item => ({
        id: item.id,
        title: item.title,
        author: item.author,
        imageUrl: item.image_url,
        prompt: item.prompt,
    }));
};