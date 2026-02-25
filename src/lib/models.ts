import { providerRefreshModels } from './db';

export async function syncModelsToDb(): Promise<{ count: number }> {
  try {
    const result = await providerRefreshModels();
    return { count: result.total_count };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
      throw new Error((error as { message: string }).message);
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error('Unable to refresh models from providers.');
  }
}
