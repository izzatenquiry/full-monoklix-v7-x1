/**
 * Centralized configuration for AI models.
 * This separates model names from the application logic, making it easier
 * to update or swap models in the future without changing service code.
 */
export const MODELS = {
  text: 'gemini-2.5-flash',
  imageGeneration: 'gemini-2.5-flash-image',
  imageEdit: 'gemini-2.5-flash-image',
  videoGenerationDefault: 'veo-3.1-fast-generate-001',
  videoGenerationOptions: [
    { id: 'veo-3.1-fast-generate-001', label: 'Veo 3 (Fast)' },
    { id: 'veo-3.1-generate-001', label: 'Veo 3 (Standard)' },
  ],
};

export const TRIAL_USAGE_LIMIT = 5;