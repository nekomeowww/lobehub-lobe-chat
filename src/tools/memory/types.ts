export type {
  CategorizeMemoryContextParams,
  CategorizeMemoryContextResult,
  CategorizeMemoryPreferenceParams,
  CategorizeMemoryPreferenceResult,
  RetrieveMemoryParams,
  RetrieveMemoryResult,
  SaveMemoryParams,
  SaveMemoryResult,
} from '@/types/userMemory';

// API function names
export const MemoryApiName = {
  categorizeContext: 'categorizeContext',
  categorizePreference: 'categorizePreference',
  retrieveMemory: 'retrieveMemory',
  saveMemory: 'saveMemory',
} as const;
