import { type SQL, and, asc, eq, gte, lte } from 'drizzle-orm';
import { ModelProvider } from 'model-bank';
import pMap from 'p-map';
import { z } from 'zod';

import { DEFAULT_FILE_EMBEDDING_MODEL_ITEM } from '@/const/settings/knowledge';
import { IdentityEntryPayload, UserMemoryModel } from '@/database/models/userMemory';
import {
  userMemories,
  userMemoriesContexts,
  userMemoriesExperiences,
  userMemoriesIdentities,
  userMemoriesPreferences,
} from '@/database/schemas';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { keyVaults, serverDatabase } from '@/libs/trpc/lambda/middleware';
import { getServerDefaultFilesConfig } from '@/server/globalConfig';
import { initModelRuntimeWithUserPayload } from '@/server/modules/ModelRuntime';
import { ClientSecretPayload } from '@/types/auth';
import {
  SearchMemoryResult,
  addContextMemorySchema,
  addExperienceMemorySchema,
  addIdentityMemorySchema,
  addPreferenceMemorySchema,
  removeIdentityMemorySchema,
  searchMemorySchema,
  updateIdentityMemorySchema,
} from '@/types/userMemory';

const EMBEDDING_VECTOR_DIMENSION = 1024;
const EMPTY_SEARCH_RESULT: SearchMemoryResult = {
  contexts: [],
  experiences: [],
  preferences: [],
};

type MemorySearchContext = {
  jwtPayload: ClientSecretPayload;
  memoryModel: UserMemoryModel;
};

type MemorySearchResult = Awaited<ReturnType<UserMemoryModel['searchWithEmbedding']>>;

const mapMemorySearchResult = (layeredResults: MemorySearchResult): SearchMemoryResult => {
  return {
    contexts: layeredResults.contexts.map((context) => ({
      accessedAt: context.accessedAt,
      associatedObjects: context.associatedObjects,
      associatedSubjects: context.associatedSubjects,
      createdAt: context.createdAt,
      currentStatus: context.currentStatus,
      description: context.description,
      id: context.id,
      metadata: context.metadata,
      scoreImpact: context.scoreImpact,
      scoreUrgency: context.scoreUrgency,
      tags: context.tags,
      title: context.title,
      type: context.type,
      updatedAt: context.updatedAt,
      userMemoryIds: Array.isArray(context.userMemoryIds)
        ? (context.userMemoryIds as string[])
        : null,
    })),
    experiences: layeredResults.experiences.map((experience) => ({
      accessedAt: experience.accessedAt,
      action: experience.action,
      createdAt: experience.createdAt,
      id: experience.id,
      keyLearning: experience.keyLearning,
      metadata: experience.metadata,
      possibleOutcome: experience.possibleOutcome,
      reasoning: experience.reasoning,
      scoreConfidence: experience.scoreConfidence,
      situation: experience.situation,
      tags: experience.tags,
      type: experience.type,
      updatedAt: experience.updatedAt,
      userMemoryId: experience.userMemoryId,
    })),
    preferences: layeredResults.preferences.map((preference) => ({
      accessedAt: preference.accessedAt,
      conclusionDirectives: preference.conclusionDirectives,
      createdAt: preference.createdAt,
      id: preference.id,
      metadata: preference.metadata,
      scorePriority: preference.scorePriority,
      suggestions: preference.suggestions,
      tags: preference.tags,
      type: preference.type,
      updatedAt: preference.updatedAt,
      userMemoryId: preference.userMemoryId,
    })),
  } satisfies SearchMemoryResult;
};

const searchUserMemories = async (
  ctx: MemorySearchContext,
  input: z.infer<typeof searchMemorySchema>,
): Promise<SearchMemoryResult> => {
  const agentRuntime = await initModelRuntimeWithUserPayload(ModelProvider.OpenAI, ctx.jwtPayload);

  const { model: embeddingModel } =
    getServerDefaultFilesConfig().embeddingModel || DEFAULT_FILE_EMBEDDING_MODEL_ITEM;

  const queryEmbeddings = await agentRuntime.embeddings({
    dimensions: EMBEDDING_VECTOR_DIMENSION,
    input: input.query,
    model: embeddingModel,
  });

  const limit = input.limit ? parseInt(input.limit, 10) : 5;
  const limits = {
    contexts: input.topK?.contexts,
    experiences: input.topK?.experiences,
    preferences: input.topK?.preferences,
  };

  const layeredResults = await ctx.memoryModel.searchWithEmbedding({
    embedding: queryEmbeddings?.[0] || [],
    limit,
    limits,
    memoryCategory: input.memoryCategory,
    memoryType: input.memoryType,
  });

  return mapMemorySearchResult(layeredResults);
};

const getEmbeddingRuntime = async (jwtPayload: ClientSecretPayload) => {
  const agentRuntime = await initModelRuntimeWithUserPayload(ModelProvider.OpenAI, jwtPayload);
  const { model: embeddingModel } =
    getServerDefaultFilesConfig().embeddingModel || DEFAULT_FILE_EMBEDDING_MODEL_ITEM;

  return { agentRuntime, embeddingModel };
};

const createEmbedder = (agentRuntime: any, embeddingModel: string) => {
  return async (value?: string | null): Promise<number[] | undefined> => {
    if (!value || value.trim().length === 0) return undefined;

    const embeddings = await agentRuntime.embeddings({
      dimensions: EMBEDDING_VECTOR_DIMENSION,
      input: value,
      model: embeddingModel,
    });

    return embeddings?.[0];
  };
};

const REEMBED_TABLE_KEYS = [
  'userMemories',
  'contexts',
  'preferences',
  'identities',
  'experiences',
] as const;
type ReEmbedTableKey = (typeof REEMBED_TABLE_KEYS)[number];

const reEmbedInputSchema = z.object({
  concurrency: z.coerce.number().int().min(1).max(50).optional(),
  endDate: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).optional(),
  only: z.array(z.enum(REEMBED_TABLE_KEYS)).optional(),
  startDate: z.coerce.date().optional(),
});

interface ReEmbedStats {
  failed: number;
  skipped: number;
  succeeded: number;
  total: number;
}

const combineConditions = (conditions: Array<SQL | undefined>): SQL | undefined => {
  const filtered = conditions.filter((condition): condition is SQL => condition !== undefined);
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];

  return and(...filtered);
};

const normalizeEmbeddable = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
};

const memoryProcedure = authedProcedure
  .use(serverDatabase)
  .use(keyVaults)
  .use(async (opts) => {
    const { ctx } = opts;
    return opts.next({
      ctx: {
        memoryModel: new UserMemoryModel(ctx.serverDB, ctx.userId),
      },
    });
  });

export const userMemoriesRouter = router({
  // REVIEW：根据当前 topic 直接提取记忆

  // REVIEW： 我们需要一个既可以 cron 也可以主动用户触发进行「每日/每周/每隔一段时间的」记忆提取/生成的函数实现
  // REVIEW： 定时任务
  // 不用 tRPC，直接 server/service
  // 可以参考 https://github.com/lobehub/lobe-chat-cloud/blob/886ff2fcd44b7b00a3aa8906f84914a6dcaa1815/src/app/(backend)/cron/reset-budgets/route.ts#L214

  reEmbedMemories: memoryProcedure
    .input(reEmbedInputSchema.optional())
    .mutation(async ({ ctx, input }) => {
      try {
        const options = input ?? {};
        const { agentRuntime, embeddingModel } = await getEmbeddingRuntime(ctx.jwtPayload);
        const concurrency = options.concurrency ?? 10;
        const shouldProcess = (key: ReEmbedTableKey) =>
          !options.only || options.only.length === 0 || options.only.includes(key);

        const embedTexts = async (texts: string[]): Promise<number[][]> => {
          if (texts.length === 0) return [];

          const response = await agentRuntime.embeddings({
            dimensions: EMBEDDING_VECTOR_DIMENSION,
            input: texts,
            model: embeddingModel,
          });

          if (!response || response.length !== texts.length) {
            throw new Error('Embedding response length mismatch');
          }

          return response;
        };

        const results: Partial<Record<ReEmbedTableKey, ReEmbedStats>> = {};

        const run = async (key: ReEmbedTableKey, handler: () => Promise<ReEmbedStats>) => {
          if (!shouldProcess(key)) return;
          results[key] = await handler();
        };

        // Individual re-embed handlers are appended below.
        await run('userMemories', async () => {
          const where = combineConditions([
            eq(userMemories.userId, ctx.userId),
            options.startDate ? gte(userMemories.createdAt, options.startDate) : undefined,
            options.endDate ? lte(userMemories.createdAt, options.endDate) : undefined,
          ]);

          const rows = await ctx.serverDB.query.userMemories.findMany({
            columns: { details: true, id: true, summary: true },
            limit: options.limit,
            orderBy: [asc(userMemories.createdAt)],
            where,
          });

          let succeeded = 0;
          let failed = 0;
          let skipped = 0;

          await pMap(
            rows,
            async (row) => {
              const summaryText = normalizeEmbeddable(row.summary);
              const detailsText = normalizeEmbeddable(row.details);

              try {
                if (!summaryText && !detailsText) {
                  await ctx.memoryModel.updateUserMemoryVectors(row.id, {
                    detailsVector1024: null,
                    summaryVector1024: null,
                  });
                  skipped += 1;
                  return;
                }

                const inputs: string[] = [];
                if (summaryText) inputs.push(summaryText);
                if (detailsText) inputs.push(detailsText);

                const embeddings = await embedTexts(inputs);
                let embedIndex = 0;

                const summaryVector = summaryText ? (embeddings[embedIndex++] ?? null) : null;
                const detailsVector = detailsText ? (embeddings[embedIndex++] ?? null) : null;

                await ctx.memoryModel.updateUserMemoryVectors(row.id, {
                  detailsVector1024: detailsVector,
                  summaryVector1024: summaryVector,
                });

                succeeded += 1;
              } catch (err) {
                failed += 1;
                console.error(
                  `[memoryRouter.reEmbed] Failed to re-embed user memory ${row.id}`,
                  err,
                );
              }
            },
            { concurrency },
          );

          return {
            failed,
            skipped,
            succeeded,
            total: rows.length,
          } satisfies ReEmbedStats;
        });

        await run('contexts', async () => {
          const where = combineConditions([
            eq(userMemoriesContexts.userId, ctx.userId),
            options.startDate ? gte(userMemoriesContexts.createdAt, options.startDate) : undefined,
            options.endDate ? lte(userMemoriesContexts.createdAt, options.endDate) : undefined,
          ]);

          const rows = await ctx.serverDB.query.userMemoriesContexts.findMany({
            columns: { description: true, id: true },
            limit: options.limit,
            orderBy: [asc(userMemoriesContexts.createdAt)],
            where,
          });

          let succeeded = 0;
          let failed = 0;
          let skipped = 0;

          await pMap(
            rows,
            async (row) => {
              const description = normalizeEmbeddable(row.description);

              try {
                if (!description) {
                  await ctx.memoryModel.updateContextVectors(row.id, {
                    descriptionVector: null,
                  });
                  skipped += 1;
                  return;
                }

                const [embedding] = await embedTexts([description]);

                await ctx.memoryModel.updateContextVectors(row.id, {
                  descriptionVector: embedding ?? null,
                });
                succeeded += 1;
              } catch (err) {
                failed += 1;
                console.error(`[memoryRouter.reEmbed] Failed to re-embed context ${row.id}`, err);
              }
            },
            { concurrency },
          );

          return {
            failed,
            skipped,
            succeeded,
            total: rows.length,
          } satisfies ReEmbedStats;
        });

        await run('preferences', async () => {
          const where = combineConditions([
            eq(userMemoriesPreferences.userId, ctx.userId),
            options.startDate
              ? gte(userMemoriesPreferences.createdAt, options.startDate)
              : undefined,
            options.endDate ? lte(userMemoriesPreferences.createdAt, options.endDate) : undefined,
          ]);

          const rows = await ctx.serverDB.query.userMemoriesPreferences.findMany({
            columns: { conclusionDirectives: true, id: true },
            limit: options.limit,
            orderBy: [asc(userMemoriesPreferences.createdAt)],
            where,
          });

          let succeeded = 0;
          let failed = 0;
          let skipped = 0;

          await pMap(
            rows,
            async (row) => {
              const directives = normalizeEmbeddable(row.conclusionDirectives);

              try {
                if (!directives) {
                  await ctx.memoryModel.updatePreferenceVectors(row.id, {
                    conclusionDirectivesVector: null,
                  });
                  skipped += 1;
                  return;
                }

                const [embedding] = await embedTexts([directives]);
                await ctx.memoryModel.updatePreferenceVectors(row.id, {
                  conclusionDirectivesVector: embedding ?? null,
                });
                succeeded += 1;
              } catch (err) {
                failed += 1;
                console.error(
                  `[memoryRouter.reEmbed] Failed to re-embed preference ${row.id}`,
                  err,
                );
              }
            },
            { concurrency },
          );

          return {
            failed,
            skipped,
            succeeded,
            total: rows.length,
          } satisfies ReEmbedStats;
        });

        await run('identities', async () => {
          const where = combineConditions([
            eq(userMemoriesIdentities.userId, ctx.userId),
            options.startDate
              ? gte(userMemoriesIdentities.createdAt, options.startDate)
              : undefined,
            options.endDate ? lte(userMemoriesIdentities.createdAt, options.endDate) : undefined,
          ]);

          const rows = await ctx.serverDB.query.userMemoriesIdentities.findMany({
            columns: { description: true, id: true },
            limit: options.limit,
            orderBy: [asc(userMemoriesIdentities.createdAt)],
            where,
          });

          let succeeded = 0;
          let failed = 0;
          let skipped = 0;

          await pMap(
            rows,
            async (row) => {
              const description = normalizeEmbeddable(row.description);

              try {
                if (!description) {
                  await ctx.memoryModel.updateIdentityVectors(row.id, {
                    descriptionVector: null,
                  });
                  skipped += 1;
                  return;
                }

                const [embedding] = await embedTexts([description]);
                await ctx.memoryModel.updateIdentityVectors(row.id, {
                  descriptionVector: embedding ?? null,
                });
                succeeded += 1;
              } catch (err) {
                failed += 1;
                console.error(`[memoryRouter.reEmbed] Failed to re-embed identity ${row.id}`, err);
              }
            },
            { concurrency },
          );

          return {
            failed,
            skipped,
            succeeded,
            total: rows.length,
          } satisfies ReEmbedStats;
        });

        await run('experiences', async () => {
          const where = combineConditions([
            eq(userMemoriesExperiences.userId, ctx.userId),
            options.startDate
              ? gte(userMemoriesExperiences.createdAt, options.startDate)
              : undefined,
            options.endDate ? lte(userMemoriesExperiences.createdAt, options.endDate) : undefined,
          ]);

          const rows = await ctx.serverDB.query.userMemoriesExperiences.findMany({
            columns: { action: true, id: true, keyLearning: true, situation: true },
            limit: options.limit,
            orderBy: [asc(userMemoriesExperiences.createdAt)],
            where,
          });

          let succeeded = 0;
          let failed = 0;
          let skipped = 0;

          await pMap(
            rows,
            async (row) => {
              const situation = normalizeEmbeddable(row.situation);
              const action = normalizeEmbeddable(row.action);
              const keyLearning = normalizeEmbeddable(row.keyLearning);

              try {
                if (!situation && !action && !keyLearning) {
                  await ctx.memoryModel.updateExperienceVectors(row.id, {
                    actionVector: null,
                    keyLearningVector: null,
                    situationVector: null,
                  });
                  skipped += 1;
                  return;
                }

                const inputs: string[] = [];
                if (situation) inputs.push(situation);
                if (action) inputs.push(action);
                if (keyLearning) inputs.push(keyLearning);

                const embeddings = await embedTexts(inputs);
                let embedIndex = 0;

                const situationVector = situation ? (embeddings[embedIndex++] ?? null) : null;
                const actionVector = action ? (embeddings[embedIndex++] ?? null) : null;
                const keyLearningVector = keyLearning ? (embeddings[embedIndex++] ?? null) : null;

                await ctx.memoryModel.updateExperienceVectors(row.id, {
                  actionVector,
                  keyLearningVector,
                  situationVector,
                });
                succeeded += 1;
              } catch (err) {
                failed += 1;
                console.error(
                  `[memoryRouter.reEmbed] Failed to re-embed experience ${row.id}`,
                  err,
                );
              }
            },
            { concurrency },
          );

          return {
            failed,
            skipped,
            succeeded,
            total: rows.length,
          } satisfies ReEmbedStats;
        });

        const processedEntries = Object.entries(results) as Array<[ReEmbedTableKey, ReEmbedStats]>;

        if (processedEntries.length === 0) {
          return {
            message: 'No memory records matched re-embed criteria',
            results,
            success: true,
          };
        }

        const aggregate = processedEntries.reduce(
          (acc, [, stats]) => {
            acc.failed += stats.failed;
            acc.skipped += stats.skipped;
            acc.succeeded += stats.succeeded;
            acc.total += stats.total;

            return acc;
          },
          { failed: 0, skipped: 0, succeeded: 0, total: 0 },
        );

        const message =
          aggregate.total === 0
            ? 'No memory records required re-embedding'
            : `Re-embedded ${aggregate.succeeded} of ${aggregate.total} records`;

        return {
          aggregate,
          message,
          results,
          success: true,
        };
      } catch (error) {
        console.error('Failed to re-embed memories:', error);
        return {
          message: `Failed to re-embed memories: ${(error as Error).message}`,
          success: false,
        };
      }
    }),

  searchMemory: memoryProcedure.input(searchMemorySchema).query(async ({ input, ctx }) => {
    try {
      return await searchUserMemories(ctx, input);
    } catch (error) {
      console.error('Failed to retrieve memories:', error);
      return EMPTY_SEARCH_RESULT;
    }
  }),

  // REVIEW: 需要实现 tool memory api
  toolAddContextMemory: memoryProcedure
    .input(addContextMemorySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { agentRuntime, embeddingModel } = await getEmbeddingRuntime(ctx.jwtPayload);
        const embed = createEmbedder(agentRuntime, embeddingModel);

        const summaryEmbedding = await embed(input.summary);
        const detailsEmbedding = await embed(input.details);
        const contextDescriptionEmbedding = await embed(input.withContext.description);

        const { context, memory } = await ctx.memoryModel.createContextMemory({
          context: {
            associatedObjects: input.withContext.associatedObjects,
            associatedSubjects: input.withContext.associatedSubjects,
            currentStatus: input.withContext.currentStatus,
            description: input.withContext.description,
            descriptionVector: contextDescriptionEmbedding ?? null,
            metadata: {},
            scoreImpact: input.withContext.scoreImpact ?? null,
            scoreUrgency: input.withContext.scoreUrgency ?? null,
            tags: input.withContext.tags,
            title: input.withContext.title ?? null,
            type: input.withContext.type ?? null,
          },
          details: input.details,
          detailsEmbedding,
          memoryCategory: input.memoryCategory,
          memoryLayer: input.memoryLayer,
          memoryType: input.memoryType,
          summary: input.summary,
          summaryEmbedding,
          title: input.title,
        });

        return {
          contextId: context.id,
          memoryId: memory.id,
          message: 'Memory saved successfully',
          success: true,
        };
      } catch (error) {
        console.error('Failed to save memory:', error);
        return {
          message: `Failed to save memory: ${(error as Error).message}`,
          success: false,
        };
      }
    }),

  toolAddExperienceMemory: memoryProcedure
    .input(addExperienceMemorySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { agentRuntime, embeddingModel } = await getEmbeddingRuntime(ctx.jwtPayload);
        const embed = createEmbedder(agentRuntime, embeddingModel);

        const summaryEmbedding = await embed(input.summary);
        const detailsEmbedding = await embed(input.details);
        const situationVector = await embed(input.withExperience.situation);
        const actionVector = await embed(input.withExperience.action);
        const keyLearningVector = await embed(input.withExperience.keyLearning);

        const { experience, memory } = await ctx.memoryModel.createExperienceMemory({
          details: input.details,
          detailsEmbedding,
          experience: {
            action: input.withExperience.action ?? null,
            actionVector: actionVector ?? null,
            keyLearning: input.withExperience.keyLearning ?? null,
            keyLearningVector: keyLearningVector ?? null,
            metadata: {},
            possibleOutcome: input.withExperience.possibleOutcome ?? null,
            reasoning: input.withExperience.reasoning ?? null,
            scoreConfidence: input.withExperience.scoreConfidence ?? null,
            situation: input.withExperience.situation ?? null,
            situationVector: situationVector ?? null,
            tags: input.withExperience.tags ?? [],
            type: input.memoryType,
          },
          memoryCategory: input.memoryCategory,
          memoryLayer: input.memoryLayer,
          memoryType: input.memoryType,
          summary: input.summary,
          summaryEmbedding,
          title: input.title,
        });

        return {
          experienceId: experience.id,
          memoryId: memory.id,
          message: 'Memory saved successfully',
          success: true,
        };
      } catch (error) {
        console.error('Failed to save memory:', error);
        return {
          message: `Failed to save memory: ${(error as Error).message}`,
          success: false,
        };
      }
    }),

  toolAddIdentityMemory: memoryProcedure
    .input(addIdentityMemorySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { agentRuntime, embeddingModel } = await getEmbeddingRuntime(ctx.jwtPayload);
        const embed = createEmbedder(agentRuntime, embeddingModel);

        const summaryEmbedding = await embed(input.summary);
        const detailsEmbedding = await embed(input.details);
        const descriptionEmbedding = await embed(input.withIdentity.description);

        const identityMetadata: Record<string, unknown> = {};
        if (
          input.withIdentity.scoreConfidence !== null &&
          input.withIdentity.scoreConfidence !== undefined
        ) {
          identityMetadata.scoreConfidence = input.withIdentity.scoreConfidence;
        }
        if (
          input.withIdentity.sourceEvidence !== null &&
          input.withIdentity.sourceEvidence !== undefined
        ) {
          identityMetadata.sourceEvidence = input.withIdentity.sourceEvidence;
        }

        const { identityId, userMemoryId } = await ctx.memoryModel.addIdentityEntry({
          base: {
            details: input.details,
            detailsVector1024: detailsEmbedding ?? null,
            memoryCategory: input.memoryCategory,
            memoryLayer: input.memoryLayer,
            memoryType: input.memoryType,
            metadata: Object.keys(identityMetadata).length > 0 ? identityMetadata : undefined,
            summary: input.summary,
            summaryVector1024: summaryEmbedding ?? null,
            tags: input.withIdentity.tags,
            title: input.title,
          },
          identity: {
            description: input.withIdentity.description,
            descriptionVector: descriptionEmbedding ?? null,
            episodicDate: input.withIdentity.episodicDate,
            metadata: Object.keys(identityMetadata).length > 0 ? identityMetadata : undefined,
            relationship: input.withIdentity.relationship,
            role: input.withIdentity.role,
            tags: input.withIdentity.tags,
            type: input.withIdentity.type,
          },
        });

        return {
          identityId,
          memoryId: userMemoryId,
          message: 'Identity memory saved successfully',
          success: true,
        };
      } catch (error) {
        console.error('Failed to save identity memory:', error);
        return {
          message: `Failed to save identity memory: ${(error as Error).message}`,
          success: false,
        };
      }
    }),

  toolAddPreferenceMemory: memoryProcedure
    .input(addPreferenceMemorySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { agentRuntime, embeddingModel } = await getEmbeddingRuntime(ctx.jwtPayload);
        const embed = createEmbedder(agentRuntime, embeddingModel);

        const summaryEmbedding = await embed(input.summary);
        const detailsEmbedding = await embed(input.details);
        const conclusionVector = await embed(input.withPreference.conclusionDirectives);

        const suggestionsText =
          input.withPreference.suggestions.length > 0
            ? input.withPreference.suggestions.join('\n')
            : null;

        const metadata = {
          appContext: input.withPreference.appContext,
          extractedScopes: input.withPreference.extractedScopes,
          originContext: input.withPreference.originContext,
        } satisfies Record<string, unknown>;

        const { memory, preference } = await ctx.memoryModel.createPreferenceMemory({
          details: input.details,
          detailsEmbedding,
          memoryCategory: input.memoryCategory,
          memoryLayer: input.memoryLayer,
          memoryType: input.memoryType,
          preference: {
            conclusionDirectives: input.withPreference.conclusionDirectives,
            conclusionDirectivesVector: conclusionVector ?? null,
            metadata,
            scorePriority: input.withPreference.scorePriority ?? null,
            suggestions: suggestionsText,
            tags: input.withPreference.tags,
            type: input.memoryType,
          },
          summary: input.summary,
          summaryEmbedding,
          title: input.title,
        });

        return {
          memoryId: memory.id,
          message: 'Memory saved successfully',
          preferenceId: preference.id,
          success: true,
        };
      } catch (error) {
        console.error('Failed to save memory:', error);
        return {
          message: `Failed to save memory: ${(error as Error).message}`,
          success: false,
        };
      }
    }),

  toolRemoveIdentityMemory: memoryProcedure
    .input(removeIdentityMemorySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const removed = await ctx.memoryModel.removeIdentityEntry(input.id);

        if (!removed) {
          return {
            message: 'Identity memory not found',
            success: false,
          };
        }

        return {
          identityId: input.id,
          message: 'Identity memory removed successfully',
          reason: input.reason,
          success: true,
        };
      } catch (error) {
        console.error('Failed to remove identity memory:', error);
        return {
          message: `Failed to remove identity memory: ${(error as Error).message}`,
          success: false,
        };
      }
    }),

  toolSearchMemory: memoryProcedure.input(searchMemorySchema).query(async ({ input, ctx }) => {
    try {
      return await searchUserMemories(ctx, input);
    } catch (error) {
      console.error('Failed to retrieve memories:', error);
      return EMPTY_SEARCH_RESULT;
    }
  }),

  toolUpdateIdentityMemory: memoryProcedure
    .input(updateIdentityMemorySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { agentRuntime, embeddingModel } = await getEmbeddingRuntime(ctx.jwtPayload);
        const embed = createEmbedder(agentRuntime, embeddingModel);

        let descriptionVector: number[] | null | undefined;
        if (input.set.description !== undefined) {
          const vector = await embed(input.set.description);
          descriptionVector = vector ?? null;
        }

        const metadataUpdates: Record<string, unknown> = {};
        if (Object.prototype.hasOwnProperty.call(input.set, 'scoreConfidence')) {
          metadataUpdates.scoreConfidence = input.set.scoreConfidence ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(input.set, 'sourceEvidence')) {
          metadataUpdates.sourceEvidence = input.set.sourceEvidence ?? null;
        }

        const identityPayload: Partial<IdentityEntryPayload> = {};
        if (input.set.description !== undefined) {
          identityPayload.description = input.set.description;
          identityPayload.descriptionVector = descriptionVector;
        }
        if (input.set.episodicDate !== undefined) {
          identityPayload.episodicDate = input.set.episodicDate;
        }
        if (input.set.relationship !== undefined) {
          identityPayload.relationship = input.set.relationship;
        }
        if (input.set.role !== undefined) {
          identityPayload.role = input.set.role;
        }
        if (input.set.tags !== undefined) {
          identityPayload.tags = input.set.tags;
        }
        if (input.set.type !== undefined) {
          identityPayload.type = input.set.type;
        }
        if (Object.keys(metadataUpdates).length > 0) {
          identityPayload.metadata = metadataUpdates;
        }

        const updated = await ctx.memoryModel.updateIdentityEntry({
          identity: Object.keys(identityPayload).length > 0 ? identityPayload : undefined,
          identityId: input.id,
          mergeStrategy: input.mergeStrategy,
        });

        if (!updated) {
          return {
            message: 'Identity memory not found',
            success: false,
          };
        }

        return {
          identityId: input.id,
          message: 'Identity memory updated successfully',
          success: true,
        };
      } catch (error) {
        console.error('Failed to update identity memory:', error);
        return {
          message: `Failed to update identity memory: ${(error as Error).message}`,
          success: false,
        };
      }
    }),
});
