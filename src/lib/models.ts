import { z } from 'zod';

import { dbSetModelsLastSync, dbUpsertModels } from './db';
import type { ModelRowPayload, OpenRouterModel } from './types';

const OpenRouterModelsResponseSchema = z.union([
  z.object({
    data: z.array(z.unknown()),
  }),
  z.array(z.unknown()),
]);

const OpenRouterModelSchema = z
  .object({
    id: z.string().min(1),
  })
  .catchall(z.unknown());

const OpenRouterModelFieldSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    context_length: z.unknown().optional(),
    pricing: z.unknown().optional(),
  })
  .catchall(z.unknown());

function getModelListFromPayload(payload: unknown): unknown[] {
  const parsed = OpenRouterModelsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('OpenRouter model catalog response validation failed.');
  }

  return Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
}

function normalizeContextLength(value: unknown): number | null {
  const parsedNumber = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsedNumber)) {
    return null;
  }

  const rounded = Math.floor(parsedNumber);
  return rounded >= 0 ? rounded : null;
}

function toJsonString(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? 'null';
  } catch {
    return 'null';
  }
}

function parseOpenRouterError(payload: unknown, status: number): string {
  const message =
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as { error?: { message?: unknown } }).error?.message === 'string'
      ? (payload as { error: { message: string } }).error.message
      : null;

  return message ?? `OpenRouter models request failed with status ${status}.`;
}

export async function fetchOpenRouterModels(apiKey: string): Promise<OpenRouterModel[]> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new Error('OpenRouter API key is missing.');
  }

  const response = await fetch('https://openrouter.ai/api/v1/models', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${trimmedKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Basecamp',
    },
  });

  let responsePayload: unknown = null;
  try {
    responsePayload = await response.json();
  } catch {
    responsePayload = null;
  }

  if (!response.ok) {
    throw new Error(parseOpenRouterError(responsePayload, response.status));
  }

  const rawModels = getModelListFromPayload(responsePayload);

  const models: OpenRouterModel[] = [];
  for (const rawModel of rawModels) {
    const parsedModel = OpenRouterModelSchema.safeParse(rawModel);
    if (!parsedModel.success) {
      continue;
    }

    models.push(parsedModel.data as OpenRouterModel);
  }

  return models;
}

export async function syncModelsToDb(apiKey: string): Promise<{ count: number }> {
  const models = await fetchOpenRouterModels(apiKey);
  const updatedAt = Date.now();

  const dedupedRows = new Map<string, ModelRowPayload>();
  for (const model of models) {
    const parsedFields = OpenRouterModelFieldSchema.safeParse(model);

    const normalizedName =
      parsedFields.success && typeof parsedFields.data.name === 'string' && parsedFields.data.name.trim()
        ? parsedFields.data.name.trim()
        : null;
    const normalizedDescription =
      parsedFields.success && typeof parsedFields.data.description === 'string' && parsedFields.data.description.trim()
        ? parsedFields.data.description.trim()
        : null;
    const normalizedContextLength = parsedFields.success
      ? normalizeContextLength(parsedFields.data.context_length)
      : null;
    const normalizedPricingJson =
      parsedFields.success && 'pricing' in parsedFields.data && parsedFields.data.pricing !== undefined
        ? toJsonString(parsedFields.data.pricing)
        : null;

    dedupedRows.set(model.id, {
      id: model.id,
      name: normalizedName,
      description: normalizedDescription,
      context_length: normalizedContextLength,
      pricing_json: normalizedPricingJson,
      raw_json: toJsonString(model),
      updated_at: updatedAt,
    });
  }

  const rows = Array.from(dedupedRows.values());
  await dbUpsertModels(rows);
  await dbSetModelsLastSync(updatedAt);

  return { count: rows.length };
}
