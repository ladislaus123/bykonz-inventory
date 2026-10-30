/**
 * Repository — the persistence port used throughout the project.
 *
 * Exposes CRUD for every table plus the vector-search and job-queue operations
 * the flow needs. v1 is implemented by SupabaseRepository; tests can provide an
 * in-memory fake against the same interface.
 */

import type {
  ConversationState,
  ConversationStateName,
  Embedding,
  Entity,
  EntityContact,
  EntityMatch,
  EntityMedia,
  EntityStatus,
  NewEntityContact,
  Job,
  JobStatus,
  MediaMatch,
  NewEntity,
  NewEntityMedia,
  NewJob,
  NewUser,
  User,
  UUID,
} from '../types/domain.js';

export interface VectorSearchOptions {
  matchCount?: number;
  similarityThreshold?: number;
  filterUser?: UUID;
}

export interface Repository {
  /* ---------------- users ---------------- */
  createUser(input: NewUser): Promise<User>;
  getUserById(id: UUID): Promise<User | null>;
  getUserByWaId(waId: string): Promise<User | null>;
  /** Create-or-return the user for a WhatsApp id (first-contact convenience). */
  upsertUserByWaId(waId: string, defaults: NewUser): Promise<User>;
  updateUser(id: UUID, patch: Partial<NewUser> & { lastSeenAt?: string }): Promise<User>;

  /* ---------------- entities ---------------- */
  createEntity(input: NewEntity): Promise<Entity>;
  getEntityById(id: UUID): Promise<Entity | null>;
  listEntitiesByUser(userId: UUID, opts?: { status?: EntityStatus; limit?: number }): Promise<Entity[]>;
  updateEntity(id: UUID, patch: Partial<NewEntity>): Promise<Entity>;
  setEntityStatus(id: UUID, status: EntityStatus): Promise<Entity>;
  /** Attach/replace the description embedding (and record which model produced it). */
  setEntityEmbedding(id: UUID, embedding: Embedding, model: string): Promise<Entity>;
  deleteEntity(id: UUID): Promise<void>;
  /** Cosine similarity search over description_embedding via the match_entities RPC. */
  searchEntities(embedding: Embedding, opts?: VectorSearchOptions & { status?: EntityStatus }): Promise<EntityMatch[]>;

  /* ---------------- entity_media ---------------- */
  createMedia(input: NewEntityMedia): Promise<EntityMedia>;
  getMediaById(id: UUID): Promise<EntityMedia | null>;
  listMediaByEntity(entityId: UUID): Promise<EntityMedia[]>;
  setMediaEmbedding(id: UUID, embedding: Embedding, model: string): Promise<EntityMedia>;
  deleteMedia(id: UUID): Promise<void>;
  /** Cosine similarity search over media embeddings via the match_entity_media RPC. */
  searchMedia(embedding: Embedding, opts?: VectorSearchOptions): Promise<MediaMatch[]>;

  /* ---------------- entity_contacts (extra contacts per business) ---------------- */
  createContact(input: NewEntityContact): Promise<EntityContact>;
  listContactsByEntity(entityId: UUID): Promise<EntityContact[]>;

  /* ---------------- conversation state machine ---------------- */
  /** Current state for a user; returns a transient 'idle' default if no row exists yet. */
  getConversationState(userId: UUID): Promise<ConversationState>;
  /** Upsert the user's state (and optionally replace its context bag). */
  setConversationState(
    userId: UUID,
    state: ConversationStateName,
    context?: Record<string, unknown>,
  ): Promise<ConversationState>;

  /* ---------------- jobs (worker queue) ---------------- */
  enqueueJob(input: NewJob): Promise<Job>;
  getJobById(id: number): Promise<Job | null>;
  listPendingJobs(limit?: number): Promise<Job[]>;
  markJobRunning(id: number): Promise<Job>;
  markJobDone(id: number, result?: Record<string, unknown>): Promise<Job>;
  markJobFailed(id: number, error: string, opts?: { retry?: boolean }): Promise<Job>;
  updateJob(id: number, patch: Partial<Pick<Job, 'status' | 'result' | 'error' | 'scheduledAt'>>): Promise<Job>;
}

export type { JobStatus };
