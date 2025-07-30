# Plugin Development Guide

**Agent Development Stack - Ingestion Pipeline Extension Framework**

This guide shows, step-by-step, how to create a custom ingestion plugin for the Agent Development Stack (ADS). The running example is intentionally simple, a *Product Review Analyzer* that ingests raw e-commerce reviews, turns them into structured events, and persists the data across Neo4j, Qdrant, and MinIO.

By the end you will understand every moving part and be able to build your own plugins.

> **Tip**
> A fully-functional reference plugin (`sensor_report`) lives inside the repository at
> `ingestion/src/plugins/example`.  Read its `normalizer.ts` and `upserter.ts` for a
> concrete implementation that follows the patterns described in
> this guide.

## 1  Architecture Overview

### 1.1  Multi-Layer Persistence Strategy

```
Raw Message → Kafka (`tasks.raw-output`) → Normalizer → DomainEvent →
Kafka (`events.domain`) → Upserter → {Neo4j | Qdrant | MinIO}
```

* **Kafka** keeps the pipeline asynchronous and fault-tolerant.
* **Normalizer** validates raw tool output and produces one or more `DomainEvent` objects.
* **Upserter** persists each event across the storage layers with idempotent logic.

### 1.2  Plugin Component Architecture

Every plugin requires exactly two files:

1. **`normalizer.ts`** – data validation + transformation (pure function)
2. **`upserter.ts`** – side-effect-ful persistence (async function)

> Keep them small: business rules live here, *not* generic helpers.

## 2  Implementation Specification

### 2.1  Directory Structure

```
ingestion/src/plugins/product-review-analyzer/
├── normalizer.ts   # Data transformation logic
├── upserter.ts     # Persistence orchestration
├── types.ts        # Locally shared TypeScript interfaces (optional)
└── utils/          # Potential helpers for your plugin (optional)
```

The folder name becomes the plugin id (`product-review-analyzer`).

### 2.1.1  Zod Validation Flow

1. **Define the schema** – a Zod object captures the exact shape and constraints of your raw payload:

   ```ts
   export const ReviewSchema = z.object({
     reviewId: z.string(),
     productId: z.string(),
     rating: z.number().min(0).max(5),
     // Additional validation fields as needed
   });
   ```

2. **Validate & parse** – inside the normalizer call `safeParse()` which returns `{ success, data | error }` so you can gracefully drop invalid messages:

   ```ts
   const parsed = ReviewSchema.safeParse(msg.data);
   if (!parsed.success) return null; // Invalid messages will be sent to DLQ
   const data = parsed.data;         // Type-safe validated data
   ```

3. **Type inference** – `z.infer<typeof ReviewSchema>` gives you a compile-time TypeScript interface that always matches the runtime validator.

4. **(Optional) Re-validate output** – create a second Zod schema for the DomainEvent and call `parse()` to throw if your code constructs an invalid event. This can act as an internal invariant check during dev/test.

### 2.1.2  Exporting a Machine-Readable Schema

If you need to integrate with **environments where Zod is not available** (Python, Go, Postman collections, etc.) you can programmatically export the Zod schema as a standard JSON Schema and ship that instead:

```bash
npm i -D zod-to-json-schema
```

```ts
import { zodToJsonSchema } from "zod-to-json-schema";
import { writeFileSync } from "node:fs";

const jsonSchema = zodToJsonSchema(ReviewSchema, {
  name: "ProductReview" // Schema identifier for external consumers
});

writeFileSync("product-review.schema.json", JSON.stringify(jsonSchema, null, 2));
```

The generated `product-review.schema.json` can be published alongside your plugin or served from an endpoint so external producers/validators can ingest it.

### 2.2  Example: *Product Review Analyzer*

Imagine an agent that scrapes product reviews from an online shop. Each raw message looks like this:

```json
{
  "reviewId": "r987",
  "productId": "p123",
  "title": "Great headphones!",
  "text": "The sound is crisp and the bass is punchy…",
  "rating": 4.5,
  "reviewerName": "alice",
  "language": "en",
  "images": [
    {
      "url": "s3://raw-uploads/p123/box.jpg",
      "mime": "image/jpeg",
      "size": 34512
    }
  ],
  "createdAt": "2025-03-15T12:34:56Z"
}
```

The goal is to turn this into a `product.review.created` event, enrich it (sentiment, embedding, word-count), and persist it.

#### 2.2.1  Normalizer Implementation

```typescript
/**
 * @fileoverview Product review normalizer for e-commerce data ingestion.
 * 
 * Transforms raw product review data into standardized domain events with
 * sentiment analysis, text embeddings, and comprehensive metadata enrichment.
 */

import { z } from "zod";
import type { RawMessage, DomainEvent, INormalizer } from "../../core/schemas.js";
import { fingerprint } from "../../core/util/fingerprint.js"; // ADS helper for deterministic hashes
// `embedText` is a tiny helper you would create yourself (or import from your
// embedding SDK) that turns free-text into a float[] embedding.  It is not
// part of ADS; it is shown here only to demonstrate how you might enrich the
// event with a vector for Qdrant.
import { embedText } from "../utils/embeddings.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SCHEMA DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Validation schema for incoming product review data from scraping tools.
 * Ensures consistent structure and data types for review processing.
 */
export const ReviewSchema = z.object({
  reviewId: z.string(),
  productId: z.string(),
  reviewerName: z.string(),
  title: z.string(),
  text: z.string(),
  rating: z.number().min(0).max(5),
  language: z.string().default("en"),
  images: z
    .array(
      z.object({
        url: z.string(),
        mime: z.string().default("image/jpeg"),
        size: z.number().positive()
      })
    )
    .default([]),
  createdAt: z.string().datetime()
});

const EVENT_TYPE = "product.review.created";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// NORMALIZER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Transforms raw product review data into standardized domain events.
 * 
 * Features:
 * - Automatic sentiment classification based on rating
 * - Text embedding generation for vector similarity search
 * - Word count and image metadata extraction
 * - Deterministic fingerprinting for deduplication
 */
const normalize: INormalizer = (msg: RawMessage): DomainEvent[] | null => {
  const parsed = ReviewSchema.safeParse(msg.data);
  if (!parsed.success) return null;

  const data = parsed.data;
  const fingerprintId = fingerprint({
    productId: data.productId,
    reviewId: data.reviewId
  });

  // Sentiment classification based on rating thresholds
  const sentiment = data.rating >= 4 ? "positive" : data.rating <= 2 ? "negative" : "neutral";
  const embedding = embedText(`${data.title}. ${data.text}`);

  const event = {
    specVersion: "1.0",
    event: {
      event_type: EVENT_TYPE,
      fingerprint: fingerprintId
    },
    meta: {
      productId: data.productId,
      reviewId: data.reviewId,
      rating: data.rating,
      reviewerName: data.reviewerName,
      language: data.language,
      sentiment,
      wordCount: data.text.split(/\s+/).length,
      imageCount: data.images.length,
      images: data.images,
      embedding,
      timestamp: new Date().toISOString(),
      source: msg.tool
    }
  };

  return [event as unknown as DomainEvent];
};

export default normalize;
```

**Highlights**

- **Type Safety**: Uses the `INormalizer` interface for compile-time type checking
- Full validation with **Zod**, no invalid data reaches storage.
- Deterministic `fingerprint()` helper (SHA-256) keeps the pipeline idempotent.
- Enrichment happens right here: sentiment, word-count, vector embedding.

#### 2.2.2  Upserter Implementation

```typescript
/**
 * @fileoverview Product review upserter for multi-storage persistence.
 * 
 * Persists review data across Neo4j (graph relationships), Qdrant (vector search),
 * and MinIO (image storage) with comprehensive deduplication and error handling.
 */

import { driver } from "../../core/neo4j.js";
import { qdrant } from "../../core/qdrant.js";
import { DomainEvent, IUpserter } from "../../core/schemas.js";
import { retry } from "../../core/util/retry.js";
import { logger } from "../../core/logger.js";
import { uploadObject, generatePresignedUrl } from "../../core/minio.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Shared Neo4j session for all upsert operations.
 * Reusing a single session improves performance under high load conditions.
 */
const session = driver.session();

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// UPSERTER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Persists product review events across all storage layers with deduplication.
 * 
 * Storage Strategy:
 * - Neo4j: Graph relationships between products, reviews, and images
 * - Qdrant: Vector embeddings for semantic similarity search
 * - MinIO: Image file storage with metadata references in Neo4j
 */
const upsert: IUpserter = async (event: DomainEvent): Promise<void> => {
  const meta = event.meta;

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // NEO4J GRAPH PERSISTENCE WITH DEDUPLICATION
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  
  await retry(() => session.executeWrite(async tx => {
    await tx.run(
      `MERGE (p:Product {id: $productId})
       MERGE (r:Review {id: $reviewId})
       ON CREATE SET 
         r.createdAt = datetime(),
         r.fingerprint = $fingerprint
       ON MATCH SET
         r.lastSeen = datetime(),
         r.duplicateCount = COALESCE(r.duplicateCount, 0) + 1
       SET  r.rating = $rating,
            r.sentiment = $sentiment,
            r.wordCount = $wordCount
       MERGE (p)<-[:REVIEWS]-(r)`,
      {
        productId: meta.productId,
        reviewId: meta.reviewId,
        fingerprint: event.event.fingerprint,
        rating: meta.rating,
        sentiment: meta.sentiment,
        wordCount: meta.wordCount
      }
    );
  }));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // QDRANT VECTOR STORAGE WITH DEDUPLICATION
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  
  await retry(() => qdrant.upsert("reviews", {
    points: [
      {
        id: event.event.fingerprint,
        vector: meta.embedding,
        payload: {
          productId: meta.productId,
          rating: meta.rating,
          sentiment: meta.sentiment
        }
      }
    ]
  }));

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // MINIO IMAGE STORAGE WITH METADATA PERSISTENCE
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  
  for (const [index, img] of meta.images.entries()) {
    const key = `${meta.reviewId}/image-${index}`;
    
    // In production, fetch image bytes from the source URL
    const imageBytes = new Uint8Array(); // Placeholder for demonstration
    await retry(() => uploadObject("product-reviews", key, imageBytes));
    
    // Store MinIO reference in Neo4j for unified access
    await retry(() => session.executeWrite(async tx => {
      await tx.run(
        `MATCH (r:Review {id: $reviewId})
         MERGE (img:ReviewImage {bucket: $bucket, key: $key})
         ON CREATE SET
           img.originalUrl = $originalUrl,
           img.mimeType = $mimeType,
           img.size = $size,
           img.createdAt = datetime()
         ON MATCH SET
           img.lastSeen = datetime()
         MERGE (r)-[:HAS_IMAGE]->(img)`,
        {
          reviewId: meta.reviewId,
          bucket: "product-reviews",
          key: key,
          originalUrl: img.url,
          mimeType: img.mime,
          size: img.size
        }
      );
    }));
  }

  logger.info("Review upserted", { reviewId: meta.reviewId, productId: meta.productId });
};

export default upsert;
```

**Highlights**
- **Type Safety**: Uses the `IUpserter` interface for compile-time type checking
- **Deduplication**: Uses `MERGE` instead of `CREATE` to handle duplicate events gracefully
- **Idempotent Operations**: `ON CREATE` and `ON MATCH` clauses track creation vs. updates
- Three concise blocks (wrapped in **retry**), one per backend.
- Cypher query uses `MERGE` pattern: `Product` ↔ `Review` with safe deduplication.
- The same `fingerprint` acts as primary key in Qdrant, tying graph and vector together.
- Review images are uploaded to MinIO; their `bucket`/`key` tuples are stored on
  `(:Review)-[:HAS_IMAGE]->(:ReviewImage)` nodes so the graph can generate
  presigned URLs on demand.

---

## 2.3  Plugin Interface Requirements

### 2.3.1  Type Safety with Interfaces

All plugins must implement specific TypeScript interfaces for type safety and runtime validation. This ensures plugins work correctly with the ingestion pipeline and prevents common runtime errors.

#### Required Imports

```typescript
import type { RawMessage, DomainEvent, INormalizer, IUpserter } from "../../core/schemas.js";
```

#### Normalizer Interface

```typescript
export interface INormalizer {
  /**
   * Transforms raw message data into standardized domain events.
   * 
   * @param raw - Raw message from Kafka raw topic
   * @returns Array of domain events, or null if the message cannot be processed
   */
  (raw: RawMessage): DomainEvent[] | null;
}
```

**Implementation Pattern:**
```typescript
/**
 * Domain-specific normalizer implementation.
 * Validates input data and transforms it into standardized domain events.
 */
const normalize: INormalizer = (raw: RawMessage): DomainEvent[] | null => {
  // Validation and transformation logic here
  return [domainEvent];
};

export default normalize;
```

#### Upserter Interface

```typescript
export interface IUpserter {
  /**
   * Persists domain event to configured storage systems.
   * 
   * @param event - Validated domain event to be persisted
   * @returns Promise that resolves when upsert operation completes
   * @throws {Error} When persistence operations fail after retries
   */
  (event: DomainEvent): Promise<void>;
}
```

**Implementation Pattern:**
```typescript
/**
 * Domain-specific upserter implementation.
 * Persists events across multiple storage layers with deduplication.
 */
const upsert: IUpserter = async (event: DomainEvent): Promise<void> => {
  // Multi-storage persistence logic here
};

export default upsert;
```

### 2.3.2  Deduplication Best Practices

**Always use `MERGE` instead of `CREATE`** in Neo4j operations to handle duplicate events gracefully:

```typescript
// ✅ RECOMMENDED: Idempotent operations with deduplication tracking
await tx.run(`
  MERGE (entity:Entity {fingerprint: $fingerprint})
  ON CREATE SET 
    entity.createdAt = datetime(),
    entity.value = $value
  ON MATCH SET
    entity.lastSeen = datetime(),
    entity.duplicateCount = COALESCE(entity.duplicateCount, 0) + 1
`, { fingerprint: event.event.fingerprint, value: event.meta.value });

// ❌ AVOID: Creates duplicates on event replay
await tx.run(`
  CREATE (entity:Entity {
    fingerprint: $fingerprint,
    value: $value,
    createdAt: datetime()
  })
`, { fingerprint: event.event.fingerprint, value: event.meta.value });
```

**Benefits of MERGE pattern:**
- **Idempotent**: Safe to replay events without creating duplicates
- **Tracking**: Count how many times an event was seen (`duplicateCount`)
- **Temporal**: Track both creation time and last seen time
- **Reliable**: Handles network retries and system restarts gracefully

---

## 3  Integration Patterns

### 3.1  Cross-Reference Search (Neo4j ↔ Qdrant)

```typescript
/**
 * Finds reviews with similar semantic content but contrasting sentiment scores.
 * Demonstrates cross-platform data correlation using vector similarity and graph queries.
 * 
 * @param vector - Query embedding vector for similarity search
 * @param productId - Product identifier to scope the search
 * @returns Array of controversial review objects with metadata
 */
export const findControversialReviews = async (vector: number[], productId: string) => {
  // Vector similarity search in Qdrant with product filtering
  const neighbors = await qdrant.search("reviews", { 
    vector, 
    limit: 10,
    filter: { must: [{ key: "productId", match: { value: productId } }] }
  });

  // Extract fingerprints for Neo4j correlation
  const fingerprints = neighbors.map(n => n.id);
  const session = driver.session();
  
  try {
    const res = await session.run(
      `MATCH (r:Review)
       WHERE r.id IN $ids AND r.sentiment <> 'positive'
       RETURN r.id   AS reviewId,
              r.text AS text,
              r.rating AS rating`,
      { ids: fingerprints }
    );
    return res.records.map(rec => rec.toObject());
  } finally {
    await session.close();
  }
};
```

### 3.2 Cross-Reference (Neo4j ↔ MinIO)

```typescript
/**
 * Retrieves presigned URLs for all images associated with a product's reviews.
 * Demonstrates graph traversal with object storage integration.
 * 
 * @param productId - Product identifier for image lookup
 * @returns Promise resolving to array of presigned image URLs
 */
const listReviewImages = async (productId: string) => {
  const session = driver.session();
  
  try {
    const result = await session.run(
      `MATCH (p:Product {id:$pid})<-[:REVIEWS]-(r:Review)-[:HAS_IMAGE]->(img:ReviewImage)
       RETURN img.bucket AS bucket, img.key AS key`,
      { pid: productId }
    );
    
    return result.records.map(rec => 
      generatePresignedUrl(rec.get("bucket"), rec.get("key"))
    );
  } finally {
    await session.close();
  }
};
```

### 3.3 Error Handling & Resilience

A minimal exponential-backoff wrapper:

```typescript
import { retry } from "../../core/util/retry.js";

/**
 * Retry operations with exponential backoff and jitter.
 * Automatically forwards failed events to dead letter queue after exhaustion.
 */
await retry(() => upsert(event), { retries: 3, baseMs: 500 });
```

The core `retry` helper logs attempts and forwards the event to the dead-letter queue after exhaustion.

---

## 4  Plugin Registration & Configuration

Add the plugin paths to `ingestion/src/config/plugins.yaml`:

```yaml
# Plugin configuration mapping tools and events to their respective handlers
normalizers:
  product-review-analyzer: "plugins/product-review-analyzer/normalizer"

upserters:
  product.review.created: "plugins/product-review-analyzer/upserter"
```

Nothing else is required — ADS discovers the files at runtime.

---

## 5  Development & Deployment Checklist

1. **Build & Test**
   - [ ] Implement normalizer and upserter using the required `INormalizer` and `IUpserter` interfaces.
   - [ ] Use `MERGE` instead of `CREATE` in all Neo4j operations for proper deduplication.
   - [ ] Validate all input and output data using Zod schemas.
   - [ ] Ensure your plugin produces correct DomainEvent objects and handles edge cases.
   - [ ] Test idempotency: verify your plugin handles duplicate events gracefully.
   - [ ] Write or update documentation describing your plugin's purpose, data flow, and configuration.
2. **Type Safety**
   - [ ] Import required interfaces: `INormalizer`, `IUpserter`, `RawMessage`, `DomainEvent`.
   - [ ] Use proper TypeScript typing throughout your implementation.
   - [ ] Export functions using the interface pattern (const + export default).
3. **Register**
   - [ ] Add your plugin to the `plugins.yaml` registry under the correct normalizer and upserter sections.
   - [ ] Set any required environment variables for external services.
4. **Deploy**
   - [ ] Deploy the updated ingestion service with your plugin included.
5. **Monitor**
   - [ ] Run an end-to-end test: send sample data through the pipeline and confirm it is processed as expected.
   - [ ] Verify deduplication: send the same event multiple times and confirm no duplicates are created.
   - [ ] Check that your plugin's output appears in the correct storage layers (graph, vector, object store).
   - [ ] Watch logs (`ingestion` container) for errors.
   - [ ] Inspect Prometheus metrics at `http://localhost:9100/metrics`.
