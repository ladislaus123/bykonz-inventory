/**
 * Domain types mirroring the Postgres schema (001_init.sql + 002_enrich_schema.sql).
 * These are the shapes the Repository returns and accepts.
 */

export type UUID = string;

export type EntityStatus = 'pending_review' | 'confirmed' | 'rejected';
export type MediaType = 'image' | 'document' | 'audio' | 'video';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';
export type JobType =
  | 'send_message'
  | 'embed_entity'
  | 'save_to_database'
  | 'agent_internet_search'
  | 'extract_card'
  | 'enrich_entity'
  | 'enrich_text'
  | 'embed_media';

/** Where a user currently is in the WhatsApp conversation (see 003_conversation_state.sql). */
export type ConversationStateName =
  | 'idle'
  | 'menu'
  | 'card_collecting'
  | 'add_collecting'
  | 'consult_await'
  | 'awaiting_decision';

/** A pgvector embedding is transported as a plain number[] (length = EMBEDDING_DIMENSIONS). */
export type Embedding = number[];

export interface User {
  id: UUID;
  name: string;
  contact: string | null;
  waId: string | null;
  locale: string;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface Entity {
  id: UUID;
  name: string;
  description: string | null;
  descriptionEmbedding: Embedding | null;
  metadata: Record<string, unknown>;
  status: EntityStatus;
  source: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  category: string | null;
  confidence: number | null;
  enrichment: Record<string, unknown>;
  embeddingModel: string | null;
  embeddingDim: number | null;
  createdBy: UUID;
  createdAt: string;
  modifiedAt: string;
  confirmedAt: string | null;
}

export interface EntityMedia {
  id: UUID;
  entityId: UUID;
  embedding: Embedding | null;
  storageUrl: string;
  mediaType: MediaType;
  mimeType: string | null;
  sha256: string | null;
  caption: string | null;
  waMessageId: string | null;
  width: number | null;
  height: number | null;
  embeddingModel: string | null;
  createdAt: string;
}

export interface Job {
  id: number;
  userId: UUID;
  entityId: UUID | null;
  entityMediaId: UUID | null;
  job: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  scheduledAt: string;
  waMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** One user's position in the conversation state machine. */
export interface ConversationState {
  userId: UUID;
  state: ConversationStateName;
  /** Small bag of per-state data, e.g. { entityId, chatId }. */
  context: Record<string, unknown>;
  updatedAt: string;
}

/* ---- Insert / Update payloads (id + timestamps are DB-generated) ---- */

export type NewUser = {
  name: string;
  contact?: string | null;
  waId?: string | null;
  locale?: string;
};

export type NewEntity = {
  name: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  status?: EntityStatus;
  source?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  category?: string | null;
  confidence?: number | null;
  enrichment?: Record<string, unknown>;
  createdBy: UUID;
};

export type NewEntityMedia = {
  entityId: UUID;
  storageUrl: string;
  mediaType?: MediaType;
  mimeType?: string | null;
  sha256?: string | null;
  caption?: string | null;
  waMessageId?: string | null;
  width?: number | null;
  height?: number | null;
};

export type NewJob = {
  userId: UUID;
  job: JobType;
  payload?: Record<string, unknown>;
  entityId?: UUID | null;
  entityMediaId?: UUID | null;
  waMessageId?: string | null;
  scheduledAt?: string;
};

/** Result of a vector similarity search (matches the match_* RPC output). */
export interface EntityMatch {
  id: UUID;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  status: EntityStatus;
  createdBy: UUID;
  similarity: number;
}

export interface MediaMatch {
  id: UUID;
  entityId: UUID;
  storageUrl: string;
  mediaType: MediaType;
  similarity: number;
}
