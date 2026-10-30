/**
 * SupabaseRepository — v1 Repository backed by Supabase (Postgres + pgvector).
 *
 * CRUD goes through supabase-js (PostgREST); vector similarity search goes
 * through the match_entities / match_entity_media SQL functions (002_enrich_schema.sql)
 * called via supabase.rpc(...).
 *
 * Use the SERVICE ROLE key server-side so writes bypass RLS.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type {
  ConversationState,
  ConversationStateName,
  Embedding,
  Entity,
  EntityMatch,
  EntityMedia,
  EntityStatus,
  Job,
  MediaMatch,
  NewEntity,
  NewEntityMedia,
  NewJob,
  NewUser,
  User,
  UUID,
} from '../types/domain.js';
import type { Repository, VectorSearchOptions } from './Repository.js';

export class SupabaseRepository implements Repository {
  private readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /* ======================= users ======================= */

  async createUser(input: NewUser): Promise<User> {
    const { data, error } = await this.db
      .from('users')
      .insert({
        name: input.name,
        contact: input.contact ?? null,
        wa_id: input.waId ?? null,
        locale: input.locale ?? 'pt-BR',
      })
      .select('*')
      .single();
    if (error) throw mapError('createUser', error);
    return rowToUser(data);
  }

  async getUserById(id: UUID): Promise<User | null> {
    const { data, error } = await this.db.from('users').select('*').eq('id', id).maybeSingle();
    if (error) throw mapError('getUserById', error);
    return data ? rowToUser(data) : null;
  }

  async getUserByWaId(waId: string): Promise<User | null> {
    const { data, error } = await this.db.from('users').select('*').eq('wa_id', waId).maybeSingle();
    if (error) throw mapError('getUserByWaId', error);
    return data ? rowToUser(data) : null;
  }

  async upsertUserByWaId(waId: string, defaults: NewUser): Promise<User> {
    const existing = await this.getUserByWaId(waId);
    if (existing) return existing;
    return this.createUser({ ...defaults, waId });
  }

  async updateUser(id: UUID, patch: Partial<NewUser> & { lastSeenAt?: string }): Promise<User> {
    const { data, error } = await this.db
      .from('users')
      .update(pruneUndefined({
        name: patch.name,
        contact: patch.contact,
        wa_id: patch.waId,
        locale: patch.locale,
        last_seen_at: patch.lastSeenAt,
      }))
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw mapError('updateUser', error);
    return rowToUser(data);
  }

  /* ======================= entities ======================= */

  async createEntity(input: NewEntity): Promise<Entity> {
    const { data, error } = await this.db
      .from('entities')
      .insert(pruneUndefined({
        name: input.name,
        description: input.description ?? null,
        metadata: input.metadata ?? {},
        status: input.status ?? 'pending_review',
        source: input.source,
        phone: input.phone,
        email: input.email,
        website: input.website,
        address: input.address,
        category: input.category,
        confidence: input.confidence,
        enrichment: input.enrichment ?? {},
        created_by: input.createdBy,
      }))
      .select(ENTITY_COLS)
      .single();
    if (error) throw mapError('createEntity', error);
    return rowToEntity(data);
  }

  async getEntityById(id: UUID): Promise<Entity | null> {
    const { data, error } = await this.db
      .from('entities')
      .select(ENTITY_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw mapError('getEntityById', error);
    return data ? rowToEntity(data) : null;
  }

  async listEntitiesByUser(
    userId: UUID,
    opts?: { status?: EntityStatus; limit?: number },
  ): Promise<Entity[]> {
    let q = this.db
      .from('entities')
      .select(ENTITY_COLS)
      .eq('created_by', userId)
      .order('created_at', { ascending: false })
      .limit(opts?.limit ?? 50);
    if (opts?.status) q = q.eq('status', opts.status);
    const { data, error } = await q;
    if (error) throw mapError('listEntitiesByUser', error);
    return (data ?? []).map(rowToEntity);
  }

  async updateEntity(id: UUID, patch: Partial<NewEntity>): Promise<Entity> {
    const { data, error } = await this.db
      .from('entities')
      .update(pruneUndefined({
        name: patch.name,
        description: patch.description,
        metadata: patch.metadata,
        status: patch.status,
        source: patch.source,
        phone: patch.phone,
        email: patch.email,
        website: patch.website,
        address: patch.address,
        category: patch.category,
        confidence: patch.confidence,
        enrichment: patch.enrichment,
      }))
      .eq('id', id)
      .select(ENTITY_COLS)
      .single();
    if (error) throw mapError('updateEntity', error);
    return rowToEntity(data);
  }

  async setEntityStatus(id: UUID, status: EntityStatus): Promise<Entity> {
    const patch: Record<string, unknown> = { status };
    if (status === 'confirmed') patch.confirmed_at = new Date().toISOString();
    const { data, error } = await this.db
      .from('entities')
      .update(patch)
      .eq('id', id)
      .select(ENTITY_COLS)
      .single();
    if (error) throw mapError('setEntityStatus', error);
    return rowToEntity(data);
  }

  async setEntityEmbedding(id: UUID, embedding: Embedding, model: string): Promise<Entity> {
    const { data, error } = await this.db
      .from('entities')
      .update({
        description_embedding: toVectorLiteral(embedding),
        embedding_model: model,
        embedding_dim: embedding.length,
      })
      .eq('id', id)
      .select(ENTITY_COLS)
      .single();
    if (error) throw mapError('setEntityEmbedding', error);
    return rowToEntity(data);
  }

  async deleteEntity(id: UUID): Promise<void> {
    const { error } = await this.db.from('entities').delete().eq('id', id);
    if (error) throw mapError('deleteEntity', error);
  }

  async searchEntities(
    embedding: Embedding,
    opts?: VectorSearchOptions & { status?: EntityStatus },
  ): Promise<EntityMatch[]> {
    const { data, error } = await this.db.rpc('match_entities', {
      query_embedding: toVectorLiteral(embedding),
      match_count: opts?.matchCount ?? 10,
      similarity_threshold: opts?.similarityThreshold ?? 0,
      filter_user: opts?.filterUser ?? null,
      filter_status: opts?.status ?? null,
    });
    if (error) throw mapError('searchEntities', error);
    return (data ?? []) as EntityMatch[];
  }

  /* ======================= entity_media ======================= */

  async createMedia(input: NewEntityMedia): Promise<EntityMedia> {
    const { data, error } = await this.db
      .from('entity_media')
      .insert(pruneUndefined({
        entity_id: input.entityId,
        storage_url: input.storageUrl,
        media_type: input.mediaType ?? 'image',
        mime_type: input.mimeType,
        sha256: input.sha256,
        caption: input.caption,
        wa_message_id: input.waMessageId,
        width: input.width,
        height: input.height,
      }))
      .select(MEDIA_COLS)
      .single();
    if (error) throw mapError('createMedia', error);
    return rowToMedia(data);
  }

  async getMediaById(id: UUID): Promise<EntityMedia | null> {
    const { data, error } = await this.db
      .from('entity_media')
      .select(MEDIA_COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw mapError('getMediaById', error);
    return data ? rowToMedia(data) : null;
  }

  async listMediaByEntity(entityId: UUID): Promise<EntityMedia[]> {
    const { data, error } = await this.db
      .from('entity_media')
      .select(MEDIA_COLS)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: true });
    if (error) throw mapError('listMediaByEntity', error);
    return (data ?? []).map(rowToMedia);
  }

  async setMediaEmbedding(id: UUID, embedding: Embedding, model: string): Promise<EntityMedia> {
    const { data, error } = await this.db
      .from('entity_media')
      .update({ embedding: toVectorLiteral(embedding), embedding_model: model })
      .eq('id', id)
      .select(MEDIA_COLS)
      .single();
    if (error) throw mapError('setMediaEmbedding', error);
    return rowToMedia(data);
  }

  async deleteMedia(id: UUID): Promise<void> {
    const { error } = await this.db.from('entity_media').delete().eq('id', id);
    if (error) throw mapError('deleteMedia', error);
  }

  async searchMedia(embedding: Embedding, opts?: VectorSearchOptions): Promise<MediaMatch[]> {
    const { data, error } = await this.db.rpc('match_entity_media', {
      query_embedding: toVectorLiteral(embedding),
      match_count: opts?.matchCount ?? 10,
      similarity_threshold: opts?.similarityThreshold ?? 0,
      filter_user: opts?.filterUser ?? null,
    });
    if (error) throw mapError('searchMedia', error);
    return (data ?? []) as MediaMatch[];
  }

  /* ======================= conversation state ======================= */

  async getConversationState(userId: UUID): Promise<ConversationState> {
    const { data, error } = await this.db
      .from('conversation_states')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw mapError('getConversationState', error);
    // No row yet == the user has never advanced past the default 'idle' state.
    if (!data) {
      return { userId, state: 'idle', context: {}, updatedAt: new Date(0).toISOString() };
    }
    return rowToConversationState(data);
  }

  async setConversationState(
    userId: UUID,
    state: ConversationStateName,
    context: Record<string, unknown> = {},
  ): Promise<ConversationState> {
    const { data, error } = await this.db
      .from('conversation_states')
      .upsert({ user_id: userId, state, context }, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (error) throw mapError('setConversationState', error);
    return rowToConversationState(data);
  }

  /* ======================= jobs ======================= */

  async enqueueJob(input: NewJob): Promise<Job> {
    const { data, error } = await this.db
      .from('jobs')
      .insert(pruneUndefined({
        user_id: input.userId,
        job: input.job,
        payload: input.payload ?? {},
        entity_id: input.entityId,
        entity_media_id: input.entityMediaId,
        wa_message_id: input.waMessageId,
        scheduled_at: input.scheduledAt,
      }))
      .select('*')
      .single();
    if (error) throw mapError('enqueueJob', error);
    return rowToJob(data);
  }

  async getJobById(id: number): Promise<Job | null> {
    const { data, error } = await this.db.from('jobs').select('*').eq('id', id).maybeSingle();
    if (error) throw mapError('getJobById', error);
    return data ? rowToJob(data) : null;
  }

  async listPendingJobs(limit = 20): Promise<Job[]> {
    const { data, error } = await this.db
      .from('jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(limit);
    if (error) throw mapError('listPendingJobs', error);
    return (data ?? []).map(rowToJob);
  }

  async markJobRunning(id: number): Promise<Job> {
    const { data, error } = await this.db
      .from('jobs')
      .update({ status: 'running', attempts: await this.nextAttempt(id) })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw mapError('markJobRunning', error);
    return rowToJob(data);
  }

  async markJobDone(id: number, result?: Record<string, unknown>): Promise<Job> {
    const { data, error } = await this.db
      .from('jobs')
      .update({ status: 'done', result: result ?? {}, completed_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw mapError('markJobDone', error);
    return rowToJob(data);
  }

  async markJobFailed(id: number, errorMsg: string, opts?: { retry?: boolean }): Promise<Job> {
    const job = await this.getJobById(id);
    const retry = (opts?.retry ?? true) && job !== null && job.attempts < job.maxAttempts;
    const { data, error } = await this.db
      .from('jobs')
      .update(pruneUndefined({
        status: retry ? 'pending' : 'failed',
        error: errorMsg,
        // simple linear backoff when retrying
        scheduled_at: retry ? new Date(Date.now() + 30_000).toISOString() : undefined,
      }))
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw mapError('markJobFailed', error);
    return rowToJob(data);
  }

  async updateJob(
    id: number,
    patch: Partial<Pick<Job, 'status' | 'result' | 'error' | 'scheduledAt'>>,
  ): Promise<Job> {
    const { data, error } = await this.db
      .from('jobs')
      .update(pruneUndefined({
        status: patch.status,
        result: patch.result,
        error: patch.error,
        scheduled_at: patch.scheduledAt,
      }))
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw mapError('updateJob', error);
    return rowToJob(data);
  }

  private async nextAttempt(id: number): Promise<number> {
    const job = await this.getJobById(id);
    return (job?.attempts ?? 0) + 1;
  }
}

/* ======================= column lists ======================= */
// Explicit lists so we can parse the pgvector columns (returned as strings).
const ENTITY_COLS =
  'id,name,description,description_embedding,metadata,status,source,phone,email,website,address,category,confidence,enrichment,embedding_model,embedding_dim,created_by,created_at,modified_at,confirmed_at';
const MEDIA_COLS =
  'id,entity_id,embedding,storage_url,media_type,mime_type,sha256,caption,wa_message_id,width,height,embedding_model,created_at';

/* ======================= row mappers ======================= */

type Row = Record<string, any>;

function rowToUser(r: Row): User {
  return {
    id: r.id,
    name: r.name,
    contact: r.contact ?? null,
    waId: r.wa_id ?? null,
    locale: r.locale,
    lastSeenAt: r.last_seen_at ?? null,
    createdAt: r.created_at,
  };
}

function rowToEntity(r: Row): Entity {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    descriptionEmbedding: parseVector(r.description_embedding),
    metadata: r.metadata ?? {},
    status: r.status,
    source: r.source ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    website: r.website ?? null,
    address: r.address ?? null,
    category: r.category ?? null,
    confidence: r.confidence ?? null,
    enrichment: r.enrichment ?? {},
    embeddingModel: r.embedding_model ?? null,
    embeddingDim: r.embedding_dim ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    modifiedAt: r.modified_at,
    confirmedAt: r.confirmed_at ?? null,
  };
}

function rowToMedia(r: Row): EntityMedia {
  return {
    id: r.id,
    entityId: r.entity_id,
    embedding: parseVector(r.embedding),
    storageUrl: r.storage_url,
    mediaType: r.media_type,
    mimeType: r.mime_type ?? null,
    sha256: r.sha256 ?? null,
    caption: r.caption ?? null,
    waMessageId: r.wa_message_id ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    embeddingModel: r.embedding_model ?? null,
    createdAt: r.created_at,
  };
}

function rowToConversationState(r: Row): ConversationState {
  return {
    userId: r.user_id,
    state: r.state,
    context: r.context ?? {},
    updatedAt: r.updated_at,
  };
}

function rowToJob(r: Row): Job {
  return {
    id: r.id,
    userId: r.user_id,
    entityId: r.entity_id ?? null,
    entityMediaId: r.entity_media_id ?? null,
    job: r.job,
    status: r.status,
    payload: r.payload ?? {},
    result: r.result ?? null,
    error: r.error ?? null,
    attempts: r.attempts ?? 0,
    maxAttempts: r.max_attempts ?? 5,
    scheduledAt: r.scheduled_at,
    waMessageId: r.wa_message_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? null,
  };
}

/* ======================= helpers ======================= */

/** pgvector is written as the literal "[1,2,3]"; PostgREST accepts that string. */
function toVectorLiteral(v: Embedding): string {
  return `[${v.join(',')}]`;
}

/** PostgREST returns vector columns as a "[1,2,3]" string (or null). */
function parseVector(v: unknown): Embedding | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v as Embedding;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Embedding;
    } catch {
      return null;
    }
  }
  return null;
}

/** Drop undefined keys so PATCH/INSERT don't null out untouched columns. */
function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val !== undefined) (out as Record<string, unknown>)[k] = val;
  }
  return out;
}

function mapError(op: string, error: { message: string; code?: string; cause?: unknown }): Error {
  // Network failures (undici "fetch failed") hide the real reason in .cause.
  let detail = '';
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: string; message?: string };
    detail = ` (cause: ${c.code ?? ''} ${c.message ?? ''})`.trimEnd();
  }
  return new Error(`[SupabaseRepository.${op}] ${error.code ?? ''} ${error.message}${detail}`.trim());
}
