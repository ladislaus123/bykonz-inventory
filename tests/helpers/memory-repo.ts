/**
 * In-memory Repository used by the functional tests.
 * Queue and search semantics follow SupabaseRepository / the SQL RPCs:
 * pending jobs are claimable only once scheduled_at has passed, failures retry
 * with a 30s backoff until max_attempts, and search is cosine similarity.
 */

import { randomUUID } from 'node:crypto';

import type { Repository, VectorSearchOptions } from '../../src/repository/Repository.js';
import type {
  Collection,
  ConversationState,
  ConversationStateName,
  Embedding,
  Entity,
  EntityContact,
  EntityMatch,
  EntityMedia,
  EntityStatus,
  Job,
  MediaMatch,
  NewCollection,
  NewEntity,
  NewEntityContact,
  NewEntityMedia,
  NewJob,
  NewUser,
  User,
  UUID,
} from '../../src/types/domain.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cosine(a: Embedding, b: Embedding): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class MemoryRepository implements Repository {
  private readonly users = new Map<UUID, User>();
  private readonly entities = new Map<UUID, Entity>();
  private readonly media = new Map<UUID, EntityMedia>();
  private readonly contacts = new Map<UUID, EntityContact>();
  private readonly collections = new Map<UUID, Collection>();
  private readonly states = new Map<UUID, ConversationState>();
  private readonly jobs = new Map<number, Job>();
  private jobSeq = 0;
  /** Monotonic timestamps so list order does not depend on the clock resolution. */
  private seq = 0;

  private stamp(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.seq)).toISOString();
  }

  async createUser(input: NewUser): Promise<User> {
    const user: User = {
      id: randomUUID(),
      name: input.name,
      contact: input.contact ?? null,
      waId: input.waId ?? null,
      locale: input.locale ?? 'pt-BR',
      lastSeenAt: null,
      activeCollectionId: null,
      createdAt: this.stamp(),
    };
    this.users.set(user.id, user);
    return clone(user);
  }

  async getUserById(id: UUID): Promise<User | null> {
    const user = this.users.get(id);
    return user ? clone(user) : null;
  }

  async getUserByWaId(waId: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.waId === waId) return clone(user);
    }
    return null;
  }

  async upsertUserByWaId(waId: string, defaults: NewUser): Promise<User> {
    const existing = await this.getUserByWaId(waId);
    if (existing) return existing;
    return this.createUser({ ...defaults, waId });
  }

  async updateUser(
    id: UUID,
    patch: Partial<NewUser> & { lastSeenAt?: string; activeCollectionId?: UUID | null },
  ): Promise<User> {
    const user = this.mustUser(id);
    if (patch.name !== undefined) user.name = patch.name;
    if (patch.contact !== undefined) user.contact = patch.contact ?? null;
    if (patch.waId !== undefined) user.waId = patch.waId ?? null;
    if (patch.locale !== undefined) user.locale = patch.locale;
    if (patch.lastSeenAt !== undefined) user.lastSeenAt = patch.lastSeenAt;
    if (patch.activeCollectionId !== undefined) user.activeCollectionId = patch.activeCollectionId;
    return clone(user);
  }

  async createEntity(input: NewEntity): Promise<Entity> {
    this.mustUser(input.createdBy);
    const now = this.stamp();
    const entity: Entity = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      descriptionEmbedding: null,
      metadata: input.metadata ?? {},
      status: input.status ?? 'pending_review',
      source: input.source ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      website: input.website ?? null,
      address: input.address ?? null,
      category: input.category ?? null,
      confidence: input.confidence ?? null,
      enrichment: input.enrichment ?? {},
      embeddingModel: null,
      embeddingDim: null,
      collectionId: input.collectionId ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      modifiedAt: now,
      confirmedAt: null,
    };
    this.entities.set(entity.id, entity);
    return clone(entity);
  }

  async getEntityById(id: UUID): Promise<Entity | null> {
    const entity = this.entities.get(id);
    return entity ? clone(entity) : null;
  }

  async listEntitiesByUser(
    userId: UUID,
    opts?: { status?: EntityStatus; limit?: number },
  ): Promise<Entity[]> {
    return [...this.entities.values()]
      .filter((e) => e.createdBy === userId && (!opts?.status || e.status === opts.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts?.limit ?? 50)
      .map(clone);
  }

  async listEntitiesByCollection(
    collectionId: UUID,
    opts?: { status?: EntityStatus; limit?: number },
  ): Promise<Entity[]> {
    return [...this.entities.values()]
      .filter((e) => e.collectionId === collectionId && (!opts?.status || e.status === opts.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts?.limit ?? 50)
      .map(clone);
  }

  async updateEntity(id: UUID, patch: Partial<NewEntity>): Promise<Entity> {
    const entity = this.mustEntity(id);
    if (patch.name !== undefined) entity.name = patch.name;
    if (patch.description !== undefined) entity.description = patch.description ?? null;
    if (patch.metadata !== undefined) entity.metadata = patch.metadata;
    if (patch.status !== undefined) entity.status = patch.status;
    if (patch.source !== undefined) entity.source = patch.source ?? null;
    if (patch.phone !== undefined) entity.phone = patch.phone ?? null;
    if (patch.email !== undefined) entity.email = patch.email ?? null;
    if (patch.website !== undefined) entity.website = patch.website ?? null;
    if (patch.address !== undefined) entity.address = patch.address ?? null;
    if (patch.category !== undefined) entity.category = patch.category ?? null;
    if (patch.confidence !== undefined) entity.confidence = patch.confidence ?? null;
    if (patch.enrichment !== undefined) entity.enrichment = patch.enrichment;
    if (patch.collectionId !== undefined) entity.collectionId = patch.collectionId ?? null;
    entity.modifiedAt = this.stamp();
    return clone(entity);
  }

  async setEntityStatus(id: UUID, status: EntityStatus): Promise<Entity> {
    const entity = this.mustEntity(id);
    entity.status = status;
    if (status === 'confirmed') entity.confirmedAt = this.stamp();
    entity.modifiedAt = this.stamp();
    return clone(entity);
  }

  async setEntityEmbedding(id: UUID, embedding: Embedding, model: string): Promise<Entity> {
    const entity = this.mustEntity(id);
    entity.descriptionEmbedding = [...embedding];
    entity.embeddingModel = model;
    entity.embeddingDim = embedding.length;
    entity.modifiedAt = this.stamp();
    return clone(entity);
  }

  async deleteEntity(id: UUID): Promise<void> {
    this.entities.delete(id);
    for (const [mediaId, item] of this.media) {
      if (item.entityId === id) this.media.delete(mediaId);
    }
    for (const [contactId, item] of this.contacts) {
      if (item.entityId === id) this.contacts.delete(contactId);
    }
    for (const job of this.jobs.values()) {
      if (job.entityId === id) job.entityId = null;
    }
  }

  async searchEntities(
    embedding: Embedding,
    opts?: VectorSearchOptions & { status?: EntityStatus },
  ): Promise<EntityMatch[]> {
    const threshold = opts?.similarityThreshold ?? 0;
    return [...this.entities.values()]
      .filter((e) => e.descriptionEmbedding)
      .filter((e) => !opts?.filterUser || e.createdBy === opts.filterUser)
      .filter((e) => !opts?.status || e.status === opts.status)
      .map((e) => ({ entity: e, similarity: cosine(embedding, e.descriptionEmbedding!) }))
      .filter((hit) => hit.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, opts?.matchCount ?? 10)
      .map(({ entity, similarity }) => ({
        id: entity.id,
        name: entity.name,
        description: entity.description,
        metadata: entity.metadata,
        status: entity.status,
        createdBy: entity.createdBy,
        similarity,
      }));
  }

  async findEntitiesByContactName(
    name: string,
    opts?: { status?: EntityStatus; limit?: number },
  ): Promise<EntityMatch[]> {
    const q = name.trim().toLowerCase();
    if (q.length < 2) return [];
    const byId = new Map<UUID, EntityMatch>();
    for (const c of this.contacts.values()) {
      const cname = c.name?.trim().toLowerCase();
      if (!cname || !cname.includes(q)) continue;
      const entity = this.entities.get(c.entityId);
      if (!entity) continue;
      if (opts?.status && entity.status !== opts.status) continue;
      const similarity = cname === q ? 1 : 0.9;
      const existing = byId.get(entity.id);
      if (existing && existing.similarity >= similarity) continue;
      byId.set(entity.id, {
        id: entity.id,
        name: entity.name,
        description: entity.description,
        metadata: entity.metadata,
        status: entity.status,
        createdBy: entity.createdBy,
        similarity,
      });
    }
    return [...byId.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, opts?.limit ?? 20);
  }

  async createMedia(input: NewEntityMedia): Promise<EntityMedia> {
    this.mustEntity(input.entityId);
    const media: EntityMedia = {
      id: randomUUID(),
      entityId: input.entityId,
      embedding: null,
      storageUrl: input.storageUrl,
      mediaType: input.mediaType ?? 'image',
      mimeType: input.mimeType ?? null,
      sha256: input.sha256 ?? null,
      caption: input.caption ?? null,
      waMessageId: input.waMessageId ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      embeddingModel: null,
      createdAt: this.stamp(),
    };
    this.media.set(media.id, media);
    return clone(media);
  }

  async getMediaById(id: UUID): Promise<EntityMedia | null> {
    const media = this.media.get(id);
    return media ? clone(media) : null;
  }

  async listMediaByEntity(entityId: UUID): Promise<EntityMedia[]> {
    return [...this.media.values()]
      .filter((m) => m.entityId === entityId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async setMediaEmbedding(id: UUID, embedding: Embedding, model: string): Promise<EntityMedia> {
    const media = this.mustMedia(id);
    media.embedding = [...embedding];
    media.embeddingModel = model;
    return clone(media);
  }

  async deleteMedia(id: UUID): Promise<void> {
    this.media.delete(id);
    for (const job of this.jobs.values()) {
      if (job.entityMediaId === id) job.entityMediaId = null;
    }
  }

  async searchMedia(embedding: Embedding, opts?: VectorSearchOptions): Promise<MediaMatch[]> {
    const threshold = opts?.similarityThreshold ?? 0;
    const hits: MediaMatch[] = [];
    for (const item of this.media.values()) {
      if (!item.embedding) continue;
      const entity = this.entities.get(item.entityId);
      if (opts?.filterUser && entity?.createdBy !== opts.filterUser) continue;
      const similarity = cosine(embedding, item.embedding);
      if (similarity < threshold) continue;
      hits.push({
        id: item.id,
        entityId: item.entityId,
        storageUrl: item.storageUrl,
        mediaType: item.mediaType,
        similarity,
      });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, opts?.matchCount ?? 10);
  }

  async createContact(input: NewEntityContact): Promise<EntityContact> {
    this.mustEntity(input.entityId);
    const contact: EntityContact = {
      id: randomUUID(),
      entityId: input.entityId,
      name: input.name ?? null,
      role: input.role ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      label: input.label ?? null,
      source: input.source ?? null,
      metadata: input.metadata ?? {},
      createdAt: this.stamp(),
    };
    this.contacts.set(contact.id, contact);
    return clone(contact);
  }

  async listContactsByEntity(entityId: UUID): Promise<EntityContact[]> {
    return [...this.contacts.values()]
      .filter((c) => c.entityId === entityId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async createCollection(input: NewCollection): Promise<Collection> {
    this.mustUser(input.createdBy);
    const collection: Collection = {
      id: randomUUID(),
      name: input.name,
      notes: input.notes ?? null,
      collectedOn: input.collectedOn ?? null,
      location: input.location ?? null,
      createdBy: input.createdBy,
      createdAt: this.stamp(),
    };
    this.collections.set(collection.id, collection);
    return clone(collection);
  }

  async getCollectionById(id: UUID): Promise<Collection | null> {
    const collection = this.collections.get(id);
    return collection ? clone(collection) : null;
  }

  async findCollectionByName(userId: UUID, name: string): Promise<Collection | null> {
    const wanted = name.trim().toLowerCase();
    for (const collection of this.collections.values()) {
      if (collection.createdBy === userId && collection.name.toLowerCase() === wanted) {
        return clone(collection);
      }
    }
    return null;
  }

  async listCollectionsByUser(userId: UUID): Promise<Collection[]> {
    return [...this.collections.values()]
      .filter((c) => c.createdBy === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async upsertCollectionByName(userId: UUID, name: string): Promise<Collection> {
    const existing = await this.findCollectionByName(userId, name);
    if (existing) return existing;
    return this.createCollection({ name: name.trim(), createdBy: userId });
  }

  async getConversationState(userId: UUID): Promise<ConversationState> {
    const state = this.states.get(userId);
    if (!state) {
      return { userId, state: 'idle', context: {}, updatedAt: new Date(0).toISOString() };
    }
    return clone(state);
  }

  async setConversationState(
    userId: UUID,
    state: ConversationStateName,
    context: Record<string, unknown> = {},
  ): Promise<ConversationState> {
    this.mustUser(userId);
    const row: ConversationState = {
      userId,
      state,
      context: clone(context),
      updatedAt: this.stamp(),
    };
    this.states.set(userId, row);
    return clone(row);
  }

  /** Test aid. Not part of the Repository port. Oldest job first. */
  async listJobsByUser(userId: UUID): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((job) => job.userId === userId)
      .sort((a, b) => a.id - b.id)
      .map(clone);
  }

  async enqueueJob(input: NewJob): Promise<Job> {
    this.mustUser(input.userId);
    const now = this.stamp();
    const job: Job = {
      id: ++this.jobSeq,
      userId: input.userId,
      entityId: input.entityId ?? null,
      entityMediaId: input.entityMediaId ?? null,
      job: input.job,
      status: 'pending',
      payload: input.payload ?? {},
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: 5,
      scheduledAt: input.scheduledAt ?? now,
      waMessageId: input.waMessageId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.jobs.set(job.id, job);
    return clone(job);
  }

  async getJobById(id: number): Promise<Job | null> {
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  async listPendingJobs(limit = 20): Promise<Job[]> {
    const now = this.stamp();
    return [...this.jobs.values()]
      .filter((job) => job.status === 'pending' && job.scheduledAt <= now)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id - b.id)
      .slice(0, limit)
      .map(clone);
  }

  async markJobRunning(id: number): Promise<Job> {
    const job = this.mustJob(id);
    job.status = 'running';
    job.attempts += 1;
    job.updatedAt = this.stamp();
    return clone(job);
  }

  async markJobDone(id: number, result?: Record<string, unknown>): Promise<Job> {
    const job = this.mustJob(id);
    job.status = 'done';
    job.result = result ?? {};
    job.completedAt = this.stamp();
    job.updatedAt = job.completedAt;
    return clone(job);
  }

  async markJobFailed(id: number, error: string, opts?: { retry?: boolean }): Promise<Job> {
    const job = this.mustJob(id);
    const retry = (opts?.retry ?? true) && job.attempts < job.maxAttempts;
    job.status = retry ? 'pending' : 'failed';
    job.error = error;
    if (retry) job.scheduledAt = new Date(Date.now() + 30_000).toISOString();
    job.updatedAt = this.stamp();
    return clone(job);
  }

  async updateJob(
    id: number,
    patch: Partial<Pick<Job, 'status' | 'result' | 'error' | 'scheduledAt'>>,
  ): Promise<Job> {
    const job = this.mustJob(id);
    if (patch.status !== undefined) job.status = patch.status;
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.error !== undefined) job.error = patch.error;
    if (patch.scheduledAt !== undefined) job.scheduledAt = patch.scheduledAt;
    job.updatedAt = this.stamp();
    return clone(job);
  }

  private mustUser(id: UUID): User {
    const user = this.users.get(id);
    if (!user) throw new Error(`[MemoryRepository] user ${id} not found`);
    return user;
  }

  private mustEntity(id: UUID): Entity {
    const entity = this.entities.get(id);
    if (!entity) throw new Error(`[MemoryRepository] entity ${id} not found`);
    return entity;
  }

  private mustMedia(id: UUID): EntityMedia {
    const media = this.media.get(id);
    if (!media) throw new Error(`[MemoryRepository] media ${id} not found`);
    return media;
  }

  private mustJob(id: number): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`[MemoryRepository] job ${id} not found`);
    return job;
  }
}
