import { z } from "zod";

/**
 * @fileoverview Core schema definitions and type interfaces for the ingestion service.
 * 
 * This module defines the contract between different components of the ingestion pipeline:
 * - Raw message validation from external tools
 * - Domain event structure for internal processing
 * - Plugin interfaces for normalizers and upserters
 */

/**
 * Schema for messages arriving on the RAW topic from external tools.
 * Only validates the basic envelope structure; the `data` field content
 * is tool-specific and handled by normalizer plugins.
 */
export const RawMessageSchema = z.object({
  tool: z.string().min(1),
  runId: z.string().min(1),
  data: z.unknown()
});
export type RawMessage = z.infer<typeof RawMessageSchema>;

/**
 * Schema for domain events processed within the ingestion pipeline.
 * Defines the minimal contract required for routing events to appropriate
 * upserter plugins. Individual upserters may apply stricter validation.
 */
export const DomainEventSchema = z.object({
  specVersion: z.string(),
  event: z.object({
    event_type: z.string().min(1),
    fingerprint: z.string().min(1)
  }),
  meta: z.record(z.unknown())
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

/**
 * Interface for normalizer plugins that transform raw tool output into domain events.
 * Normalizers are tool-specific and handle the conversion from external formats
 * to the standardized domain event format.
 */
export interface INormalizer {
  /**
   * Transforms raw message data into standardized domain events.
   * 
   * @param raw - Raw message from Kafka raw topic
   * @returns Array of domain events, or null if the message cannot be processed
   */
  (raw: RawMessage): DomainEvent[] | null;
}

/**
 * Interface for upserter plugins that persist domain events into storage systems.
 * Upserters are event-type specific and handle persistence logic for different
 * types of domain events.
 */
export interface IUpserter {
  /**
   * Persists a domain event to the configured storage system.
   * 
   * @param event - Validated domain event to be persisted
   * @returns Promise that resolves when the upsert operation completes
   * @throws {Error} When persistence operation fails
   */
  (event: DomainEvent): Promise<void>;
}

/**
 * Expected structure of dynamically imported normalizer plugin modules.
 * Each normalizer plugin must export a default function conforming to INormalizer.
 */
export interface INormalizerModule {
  default: INormalizer;
}

/**
 * Expected structure of dynamically imported upserter plugin modules.
 * Each upserter plugin must export a default function conforming to IUpserter.
 */
export interface IUpserterModule {
  default: IUpserter;
} 