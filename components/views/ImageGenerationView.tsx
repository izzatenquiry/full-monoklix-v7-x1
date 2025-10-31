import React, { useState, useCallback, useRef, useEffect } from 'react';
import { generateImages, composeImage } from '../../services/geminiService';
import { addHistoryItem } from '../../services/historyService';
import Spinner from '../common/Spinner';
import { UploadIcon, TrashIcon, DownloadIcon, VideoIcon, StarIcon, WandIcon, AlertTriangleIcon, RefreshCwIcon } from '../Icons';
import { type MultimodalContent } from '../../services/geminiService';
import TwoColumnLayout from '../common/TwoColumnLayout';
import { getImageEditingPrompt } from '../../services/promptManager';

interface ImageData extends MultimodalContent {
  id: string;
  previewUrl: string;
}

type ImageSlot = string | { error: string } | null;

const styleOptions = ["Select Style...", "Realism", "Photorealistic", "Cinematic", "Anime", "Vintage", "3D Animation", "Watercolor", "Claymation"];
const lightingOptions = ["Select Lighting...", "Golden Hour", "Studio Lighting", "Natural Light", "Dramatic Lighting", "Backlight", "Rim Lighting", "Neon Glow"];
const cameraAngleOptions = ["Select Angle...", "Wide Shot", "Close-Up", "Medium Shot", "Long Shot", "Dutch Angle", "Low Angle", "High Angle", "Overhead Shot"];
const compositionOptions = ["Select Composition...", "Rule of Thirds", "Leading Lines", "Symmetry", "Golden Ratio", "Centered", "Asymmetrical"];
const lensTypeOptions = ["Select Lens...", "Wide Angle Lens", "Telephoto Lens", "Fisheye Lens", "Macro Lens", "50mm lens", "85mm lens"];
const filmSimOptions = ["Select Film...", "Fujifilm Velvia", "Kodak Portra 400", "Cinematic Kodachrome", "Vintage Polaroid", "Ilford HP5 (B&W)"];


const downloadImage = (base64Image: string, fileName: string) => {
  const link = document.createElement('a');
  link.href = `data:image/png;base64,${base64Image}`;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

interface VideoGenPreset {
  prompt: string;
  image: { base64: string; mimeType: string; };
}

interface ImageEditPreset {
  base64: string;
  mimeType: string;
}

interface ImageGenerationViewProps {
  onCreateVideo: (preset: VideoGenPreset) => void;
  onReEdit: (preset: ImageEditPreset) => void;
  imageToReEdit: ImageEditPreset | null;
  clearReEdit: () => void;
  presetPrompt: string | null;
  clearPresetPrompt: () => void;
}

const SESSION_KEY = 'imageGenerationState';

const ImageGenerationView: React.FC<ImageGenerationViewProps> = ({ onCreateVideo, onReEdit, imageToReEdit, clearReEdit, presetPrompt, clearPresetPrompt }) => {
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<ImageSlot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceImages, setReferenceImages] = useState<ImageData[]>([]);
  const [numberOfImages, setNumberOfImages] = useState(1);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);

  const [negativePrompt, setNegativePrompt] = useState('');

  const isEditing = referenceImages.length > 0;

  useEffect(() => {
    try {
      const savedState = sessionStorage.getItem(SESSION_KEY);
      if (savedState) {
        const state = JSON.parse(savedState);
        if (state.prompt) setPrompt(state.prompt);
        // Do not load images from session storage
        // if (state.images) setImages(state.images);
        // if (state.referenceImages) setReferenceImages(state.referenceImages);
        if (state.numberOfImages) setNumberOfImages(state.numberOfImages);
        if (state.selectedImageIndex) setSelectedImageIndex(state.selectedImageIndex);
        if (state.negativePrompt) setNegativePrompt(state.negativePrompt);
      }
    } catch (e) { console.error("Failed to load state from session storage", e); }
  }, []);

  useEffect(() => {
    try {
      // Exclude large image data ('images', 'referenceImages') to prevent exceeding sessionStorage quota
      const stateToSave = { prompt, numberOfImages, selectedImageIndex, negativePrompt };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(stateToSave));
    } catch (e) { console.error("Failed to save state to session storage", e); }
  }, [prompt, numberOfImages, selectedImageIndex, negativePrompt]);

  useEffect(() => {
    if (imageToReEdit) {
      const newImage: ImageData = {
        id: `re-edit-${Date.now()}`,
        previewUrl: `data:${imageToReEdit.mimeType};base64,${imageToReEdit.base64}`,
        base64: imageToReEdit.base64,
        mimeType: imageToReEdit.mimeType,
      };
      setReferenceImages([newImage]);
      setImages([]);
      setPrompt('');
      clearReEdit();
    }
  }, [imageToReEdit, clearReEdit]);

  useEffect(() => {
    if (presetPrompt) {
      setPrompt(presetPrompt);
      window.scrollTo(0, 0);
      clearPresetPrompt();
    }
  }, [presetPrompt, clearPresetPrompt]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    const filesToProcess = Array.from(files).slice(0, 5 - referenceImages.length);
    
    filesToProcess.forEach((file: File) => {
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result === 'string') {
                    const base64String = reader.result.split(',')[1];
                    const newImage: ImageData = {
                        id: `${file.name}-${Date.now()}`,
                        previewUrl: reader.result as string,
                        base64: base64String,
                        mimeType: file.type,
                    };
                    setReferenceImages(prevImages => [...prevImages, newImage]);
                    setImages([]);
                }
            };
            reader.readAsDataURL(file);
        }
    });

    if(event.target) {
        event.target.value = '';
    }
  };

  const removeImage = (id: string) => {
    setReferenceImages(prev => prev.filter(img => img.id !== id));
  };
  
  const generateOneImage = useCallback(async (index: number) => {
      setImages(prev => {
          const newImages = [...prev];
          newImages[index] = null; // Set to loading
          return newImages;
      });
      
      try {
          let resultImage: string | undefined;
          if (isEditing) {
              const editingPrompt = getImageEditingPrompt(prompt);
              const result = await composeImage(editingPrompt, referenceImages);
              resultImage = result.imageBase64;
          } else {
              const result = await generateImages(prompt, negativePrompt);
              resultImage = result[0];
          }

          if (!resultImage) {
              throw new Error("The AI did not return an image. Please try a different prompt or reference image.");
          }
          
          await addHistoryItem({
              type: 'Image',
              prompt: isEditing ? `Image Edit: ${prompt}` : `Generate Image: ${prompt}`,
              result: resultImage
          });

          setImages(prev => {
              const newImages = [...prev];
              newImages[index] = resultImage!;
              return newImages;
          });

      } catch (e) {
          const errorMessage = e instanceof Error ? e.message : "An unknown error occurred.";
          setImages(prev => {
              const newImages = [...prev];
              newImages[index] = { error: errorMessage };
              return newImages;
          });
      }
  }, [prompt, referenceImages, isEditing, negativePrompt]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() && !isEditing) {
      setError("Please enter a prompt to describe the image you want to create.");
      return;
    }
    setIsLoading(true);
    setError(null);
    setImages(Array(numberOfImages).fill(null));
    setSelectedImageIndex(0);

    for (let i = 0; i < numberOfImages; i++) {
        setProgress(i + 1);
        await generateOneImage(i);
    }

    setIsLoading(false);
    setProgress(0);
  }, [numberOfImages, isEditing, prompt, generateOneImage]);
  
  const handleRetry = useCallback(async (index: number) => {
    await generateOneImage(index);
  }, [generateOneImage]);

  const handleLocalReEdit = (base64: string, mimeType: string) => {
      const newImage: ImageData = { id: `re-edit-${Date.now()}`, previewUrl: `data:${mimeType};base64,${base64}`, base64, mimeType };
      setReferenceImages([newImage]);
      setImages([]);
      setPrompt('');
  };

  const handleAppendToPrompt = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const selectElement = e.target;
    if (selectElement.selectedIndex === 0) return;
    setPrompt(prev => {
        const trimmedPrev = prev.trim();
        if (!trimmedPrev) return value;
        if (trimmedPrev.endsWith(',')) return `${trimmedPrev} ${value}`;
        return `${trimmedPrev}, ${value}`;
    });
    selectElement.selectedIndex = 0;
  }, [setPrompt]);

  const handleReset = useCallback(() => {
    setPrompt('');
    setImages([]);
    setError(null);
    setReferenceImages([]);
    setNumberOfImages(1);
    setSelectedImageIndex(0);
    if(fileInputRef.current) fileInputRef.current.value = '';
    setNegativePrompt('');
    setProgress(0);
    sessionStorage.removeItem(SESSION_KEY);
  }, []);

  const leftPanel = (
    <>
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">{isEditing ? 'AI Image Editor' : 'AI Image Generator'}</h1>
        <p className="text-neutral-500 dark:text-neutral-400 mt-1">{isEditing ? 'Edit your image with simple text commands.' : 'Create stunning images from text descriptions.'}</p>
      </div>
      
      <div>
        <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Reference / Source Images (up to 5)</label>
          <div className="bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-3 min-h-[116px]">
              <div className="flex items-center gap-3 flex-wrap">
                  {referenceImages.map(img => (
                      <div key={img.id} className="relative w-20 h-20">
                          <img src={img.previewUrl} alt="upload preview" className="w-full h-full object-cover rounded-md"/>
                          <button onClick={() => removeImage(img.id)} className="absolute -top-1 -right-1 bg-red-500 rounded-full p-0.5 text-white hover:bg-red-600 transition-colors">
                              <TrashIcon className="w-3 h-3"/>
                          </button>
                      </div>
                  ))}
                  {referenceImages.length < 5 && (
                      <button onClick={() => fileInputRef.current?.click()} className="w-20 h-20 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-md flex flex-col items-center justify-center text-gray-500 hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                          <UploadIcon className="w-6 h-6"/>
                          <span className="text-xs mt-1">Upload</span>
                      </button>
                  )}
                  <input type="file" accept="image/*" multiple ref={fileInputRef} onChange={handleFileChange} className="hidden" />
              </div>
               {isEditing ? (
                  <p className="text-xs text-primary-600 dark:text-primary-400 mt-2 p-2 bg-primary-500/10 rounded-md" dangerouslySetInnerHTML={{ __html: 'You are in <strong>Image Editing Mode</strong>. The prompt will be used as an instruction to edit the source image.' }}/>
              ) : (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Upload images to edit or combine them with your prompt.</p>
              )}
          </div>
      </div>

      <div>
        <label htmlFor="prompt" className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Prompt</label>
        <textarea id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={isEditing ? 'e.g., Change the background to a beach...' : 'e.g., A cute cat wearing sunglasses, cinematic style...'} rows={4} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-3 focus:ring-2 focus:ring-primary-500 focus:outline-none transition" />
      </div>

      <details className={`pt-4 border-t border-gray-200 dark:border-gray-700 ${isEditing ? 'opacity-50' : ''}`}>
          <summary className={`font-semibold cursor-pointer ${isEditing ? 'cursor-not-allowed' : ''}`}>Advanced Prompt Builder</summary>
          <fieldset disabled={isEditing} className="mt-4 space-y-4">
              <p className="text-xs text-gray-500 dark:text-gray-400">Select options to append them to your prompt. Disabled in editing mode.</p>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div><label htmlFor="builder-style" className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Style</label><select id="builder-style" onChange={handleAppendToPrompt} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none">{styleOptions.map(o => <option key={o} value={o}>{o}</option>)}</select></div>
                  <div><label htmlFor="builder-lighting" className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Lighting</label><select id="builder-lighting" onChange={handleAppendToPrompt} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none">{lightingOptions.map(o => <option key={o} value={o}>{o}</option>)}</select></div>
                  <div><label htmlFor="builder-cameraAngle" className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Camera Angle</label><select id="builder-cameraAngle" onChange={handleAppendToPrompt} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none">{cameraAngleOptions.map(o => <option key={o} value={o}>{o}</option>)}</select></div>
                  <div><label htmlFor="builder-composition" className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Composition</label><select id="builder-composition" onChange={handleAppendToPrompt} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none">{compositionOptions.map(o => <option key={o} value={o}>{o}</option>)}</select></div>
                  <div><label htmlFor="builder-lensType" className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Lens Type</label><select id="builder-lensType" onChange={handleAppendToPrompt} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none">{lensTypeOptions.map(o => <option key={o} value={o}>{o}</option>)}</select></div>
                  <div><label htmlFor="builder-filmSim" className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Film Simulation</label><select id="builder-filmSim" onChange={handleAppendToPrompt} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none">{filmSimOptions.map(o => <option key={o} value={o}>{o}</option>)}</select></div>
              </div>
          </fieldset>
      </details>
      
      <div>
        <label htmlFor="number-of-images" className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Number of Images</label>
        <select id="number-of-images" value={numberOfImages} onChange={(e) => setNumberOfImages(parseInt(e.target.value, 10))} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-3 focus:ring-2 focus:ring-primary-500 focus:outline-none">{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}</select>
      </div>
      
      <div className="space-y-4 pt-4 mt-4 border-t border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold mb-2">Advanced Settings</h2>
          <div>
            <label htmlFor="negative-prompt" className={`block text-sm font-medium mb-2 transition-colors ${isEditing ? 'text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-400'}`}>Negative Prompt (What to avoid)</label>
            <textarea id="negative-prompt" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} placeholder="e.g., text, watermarks, blurry, ugly" rows={2} className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-3 focus:ring-2 focus:ring-primary-500 focus:outline-none transition disabled:opacity-50 disabled:cursor-not-allowed" disabled={isEditing} />
          </div>
      </div>

      <div className="pt-4 mt-auto">
        <div className="flex gap-4">
          <button onClick={handleGenerate} disabled={isLoading} className="w-full flex items-center justify-center gap-2 bg-primary-600 text-white font-semibold py-3 px-4 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {isLoading ? <Spinner /> : isEditing ? 'Apply Edits' : 'Generate Images'}
          </button>
          <button
            onClick={handleReset}
            disabled={isLoading}
            className="flex-shrink-0 bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200 font-semibold py-3 px-4 rounded-lg hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors disabled:opacity-50"
          >
            Reset
          </button>
        </div>
        {error && !isLoading && <p className="text-red-500 dark:text-red-400 mt-2 text-center">{error}</p>}
      </div>
    </>
  );

  const ActionButtons: React.FC<{ imageBase64: string; mimeType: string }> = ({ imageBase64, mimeType }) => (
    <div className="absolute top-2 right-2 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
      <button onClick={() => handleLocalReEdit(imageBase64, mimeType)} title="Re-edit" className="flex items-center justify-center w-8 h-8 bg-black/60 text-white rounded-full hover:bg-black/80 transition-colors"><WandIcon className="w-4 h-4" /></button>
      <button onClick={() => onCreateVideo({ prompt, image: { base64: imageBase64, mimeType } })} title="Create Video" className="flex items-center justify-center w-8 h-8 bg-black/60 text-white rounded-full hover:bg-black/80 transition-colors"><VideoIcon className="w-4 h-4" /></button>
      <button onClick={() => downloadImage(imageBase64, `monoklix-image-${Date.now()}.png`)} title="Download" className="flex items-center justify-center w-8 h-8 bg-black/60 text-white rounded-full hover:bg-black/80 transition-colors"><DownloadIcon className="w-4 h-4" /></button>
    </div>
  );

  const rightPanel = (
    <>
      {images.length > 0 ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-2">
            <div className="flex-1 flex items-center justify-center min-h-0 w-full relative group">
                {(() => {
                    const selectedImage = images[selectedImageIndex];
                    if (typeof selectedImage === 'string') {
                        return (
                            <>
                                <img src={`data:image/png;base64,${selectedImage}`} alt={`Generated image ${selectedImageIndex + 1}`} className="rounded-md max-h-full max-w-full object-contain" />
                                <ActionButtons imageBase64={selectedImage} mimeType="image/png" />
                            </>
                        );
                    } else if (selectedImage && typeof selectedImage === 'object') {
                        return (
                            <div className="text-center text-red-500 dark:text-red-400 p-4">
                                <AlertTriangleIcon className="w-12 h-12 mx-auto mb-4" />
                                <p className="font-semibold">Generation Failed</p>
                                <p className="text-sm mt-2 max-w-md mx-auto">{selectedImage.error}</p>
                                <button
                                    onClick={() => handleRetry(selectedImageIndex)}
                                    className="mt-6 flex items-center justify-center gap-2 bg-primary-600 text-white font-semibold py-2 px-4 rounded-lg hover:bg-primary-700 transition-colors"
                                >
                                    <RefreshCwIcon className="w-4 h-4" />
                                    Try Again
                                </button>
                            </div>
                        );
                    }
                    return (
                        <div className="flex flex-col items-center justify-center h-full gap-2">
                            <Spinner />
                            {isLoading && numberOfImages > 1 && (
                                <p className="text-sm text-neutral-500">
                                    {`Generating... (${progress}/${numberOfImages})`}
                                </p>
                            )}
                        </div>
                    );
                })()}
            </div>
             {images.length > 1 && (
                <div className="flex-shrink-0 w-full flex justify-center">
                <div className="flex gap-2 overflow-x-auto p-2">
                    {images.map((img, index) => (
                    <button key={index} onClick={() => setSelectedImageIndex(index)} className={`w-16 h-16 md:w-20 md:h-20 rounded-md overflow-hidden flex-shrink-0 transition-all duration-200 flex items-center justify-center bg-neutral-200 dark:bg-neutral-800 ${selectedImageIndex === index ? 'ring-4 ring-primary-500' : 'ring-2 ring-transparent hover:ring-primary-300'}`}>
                        {typeof img === 'string' ? (
                            <img src={`data:image/png;base64,${img}`} alt={`Thumbnail ${index + 1}`} className="w-full h-full object-cover" />
                        ) : img && typeof img === 'object' ? (
                            <AlertTriangleIcon className="w-6 h-6 text-red-500" />
                        ) : (
                            <Spinner />
                        )}
                    </button>
                    ))}
                </div>
                </div>
            )}
        </div>
      ) : isLoading ? (
        <div className="flex flex-col items-center justify-center h-full gap-2">
            <Spinner />
            <p className="text-sm text-neutral-500">
                {`Generating...${numberOfImages > 1 ? ` (1/${numberOfImages})` : ''}`}
            </p>
        </div>
      ) : (
        <div className="flex items-center justify-center h-full text-center text-neutral-500 dark:text-neutral-600">
            <div><StarIcon className="w-16 h-16 mx-auto" /><p>Your generated images will appear here.</p></div>
        </div>
      )}
    </>
  );

  return <TwoColumnLayout leftPanel={leftPanel} rightPanel={rightPanel} />;
};

export default ImageGenerationView;