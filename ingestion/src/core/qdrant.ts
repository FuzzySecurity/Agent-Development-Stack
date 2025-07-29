import { QdrantClient } from "@qdrant/qdrant-js";

/**
 * @fileoverview Qdrant vector database client configuration and utility functions.
 * 
 * Provides a configured Qdrant client instance and convenience functions for
 * vector operations including point upserts and similarity searches.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CLIENT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const url = process.env.QDRANT_URL;
if (!url) {
  throw new Error("QDRANT_URL environment variable is required");
}

const apiKey = process.env.QDRANT_API_KEY;

/**
 * Configured Qdrant client instance for vector database operations.
 * 
 * Requires the following environment variables:
 * - QDRANT_URL: Qdrant server URL
 * - QDRANT_API_KEY: Authentication API key (optional for development)
 */
export const qdrant = new QdrantClient({ url, apiKey });

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Upserts points into a Qdrant collection.
 * 
 * @param collection - Name of the target collection
 * @param points - Array of points to upsert
 * @throws {Error} When upsert operation fails
 */
export async function upsertPoints(collection: string, points: any[]): Promise<void> {
  await qdrant.upsert(collection, { points });
}

/**
 * Performs vector similarity search in a Qdrant collection.
 * 
 * @param collection - Name of the target collection
 * @param vector - Query vector for similarity search
 * @param topK - Number of most similar results to return (default: 10)
 * @returns Promise resolving to search results
 * @throws {Error} When search operation fails
 */
export async function search(collection: string, vector: number[], topK = 10) {
  return qdrant.search(collection, { vector, limit: topK });
}