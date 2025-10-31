// Import uuid for proper sessionId format
import { v4 as uuidv4 } from 'uuid';

interface Veo3Config {
  authToken: string;
  aspectRatio: 'landscape' | 'portrait';
  seed?: number;
  useStandardModel?: boolean;
}

interface VideoGenerationRequest {
  prompt: string;
  imageMediaId?: string;
  config: Veo3Config;
}

// ============ PROXY CONFIGURATION ============
const USE_PROXY = true;

// Smart proxy URL that works for both production and local development
const getProxyBaseUrl = (): string => {
  const isProduction = window.location.hostname !== 'localhost' && 
                       window.location.hostname !== '127.0.0.1';

  if (isProduction) {
    // Production proxy server
    return 'https://s2.monoklix.com/api/veo';
  } else {
    // Local development proxy server
    return 'http://localhost:3001/api/veo';
  }
};
const PROXY_BASE_URL = getProxyBaseUrl();


export const generateVideoWithVeo3 = async (request: VideoGenerationRequest) => {
  const { prompt, imageMediaId, config } = request;
  
  // Validate auth token
  if (!config.authToken || !config.authToken.trim()) {
    throw new Error('Veo Auth Token is required. Please set it via the Key icon in the header.');
  }
  
  const isImageToVideo = !!imageMediaId;
  
  // Model selection logic
  // Based on testing: ALL Veo3 models only support FAST variants
  const useFastModel = true; // Force Fast for all modes
  
  if (config.useStandardModel === true) {
    console.warn('⚠️ Standard models not currently available, using Fast models');
  }
  
  // ✅ MODEL NAMES (Verified from working code)
  let videoModelKey: string;
  
  if (isImageToVideo) {
    // Image-to-Video models for Veo 3.1
    if (config.aspectRatio === 'landscape') {
      videoModelKey = 'veo_3_1_i2v_s_fast_landscape_ultra'; // ← Removed _ultra
    } else {
      videoModelKey = 'veo_3_1_i2v_s_fast_portrait_ultra';  // ← Removed _ultra
    }
  } else {
    // Text-to-Video models for Veo 3.1
    if (config.aspectRatio === 'landscape') {
      videoModelKey = 'veo_3_1_t2v_fast_ultra';  // ← Removed _ultra AND aspect suffix
    } else {
      videoModelKey = 'veo_3_1_t2v_fast_portrait_ultra';  // ← Removed _ultra
    }
  }
  
  console.log('🎬 ===== VEO3 GENERATION REQUEST =====');
  console.log(`   Model: ${videoModelKey}`);
  console.log(`   Mode: ${isImageToVideo ? 'I2V' : 'T2V'}`);
  console.log(`   Speed: ${useFastModel ? 'Fast' : 'Standard'}`);
  console.log(`   Aspect: ${config.aspectRatio}`);
  console.log(`   Has Image: ${!!imageMediaId}`);
  console.log('=====================================');
  
  const aspectRatioValue = config.aspectRatio === 'landscape'
    ? 'VIDEO_ASPECT_RATIO_LANDSCAPE'
    : 'VIDEO_ASPECT_RATIO_PORTRAIT';

  // Generate unique seed and sceneId
  const seed = config.seed || Math.floor(Math.random() * 2147483647);
  const sceneId = uuidv4();

  const requestBody: any = {
    clientContext: {
      tool: 'PINHOLE',
      userPaygateTier: 'PAYGATE_TIER_TWO'
    },
    requests: [{
      aspectRatio: aspectRatioValue,
      seed: seed,
      textInput: { prompt },
      videoModelKey: videoModelKey,
      metadata: { sceneId: sceneId }
    }]
  };

  // Add image if I2V mode
  if (imageMediaId) {
    requestBody.requests[0].startImage = { mediaId: imageMediaId };
  }

  console.log('📦 Request Body:', JSON.stringify(requestBody, null, 2));

  const endpoint = imageMediaId ? '/generate-i2v' : '/generate-t2v';
  const url = USE_PROXY 
    ? `${PROXY_BASE_URL}${endpoint}` 
    : (imageMediaId 
        ? 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage'
        : 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.authToken}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Veo3 Error Response:', {
      status: response.status,
      statusText: response.statusText,
      body: errorText
    });
    throw new Error(`Veo3 API failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  console.log('✅ Veo3 Operations received:', JSON.stringify(data, null, 2));
  
  return data.operations || [];
};

export const checkVideoStatus = async (operations: any[], authToken: string) => {
  if (!authToken || !authToken.trim()) {
    throw new Error('Auth token is required for status check');
  }

  const url = USE_PROXY
    ? `${PROXY_BASE_URL}/status`
    : 'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus';

  console.log('🔍 Checking status for operations:', operations.map(op => ({
    name: op.operation?.name || op.name,
    sceneId: op.sceneId,
    currentStatus: op.status
  })));

  const payload = { operations };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Status check failed:', response.status, errorText);
    throw new Error(`Status check failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  
  if (data.operations && data.operations.length > 0) {
    data.operations.forEach((op: any, idx: number) => {
      console.log(`📊 Operation ${idx + 1} status:`, {
        status: op.status,
        done: op.done,
        hasResult: !!op.result,
        hasError: !!op.error,
        operationName: op.operation?.name
      });
    });
  }

  return data;
};

export const uploadImageForVeo3 = async (
  base64Image: string,
  mimeType: string,
  aspectRatio: 'landscape' | 'portrait',
  authToken: string
): Promise<string> => {
  if (!authToken || !authToken.trim()) {
    throw new Error('Auth token is required for image upload');
  }

  const url = USE_PROXY
    ? `${PROXY_BASE_URL}/upload`
    : 'https://aisandbox-pa.googleapis.com/v1:uploadUserImage';

  console.log('📤 Uploading image...', {
    mimeType,
    aspectRatio,
    size: base64Image.length
  });

  const imageAspectRatioEnum = aspectRatio === 'landscape' 
    ? 'IMAGE_ASPECT_RATIO_LANDSCAPE' 
    : 'IMAGE_ASPECT_RATIO_PORTRAIT';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify({
      imageInput: {
        rawImageBytes: base64Image,
        mimeType: mimeType,
        isUserUploaded: true,
        aspectRatio: imageAspectRatioEnum
      },
      clientContext: {
        sessionId: uuidv4(),
        tool: 'ASSET_MANAGER'
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Upload failed:', errorText);
    throw new Error(`Image upload failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const mediaId = data.mediaGenerationId?.mediaGenerationId || data.mediaId;
  
  console.log('✅ Image uploaded, mediaId:', mediaId);
  
  if (!mediaId) {
    console.error('❌ No mediaId in response:', JSON.stringify(data, null, 2));
    throw new Error('Upload succeeded but no mediaId returned');
  }
  
  return mediaId;
};