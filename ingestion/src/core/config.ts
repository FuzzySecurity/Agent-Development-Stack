import { load } from "js-yaml";
import { readFile } from "node:fs/promises";

/**
 * @fileoverview Configuration management for the ingestion service.
 * 
 * Handles loading and validation of configuration from multiple sources:
 * - Plugin configuration from YAML files
 * - Environment variables for service connections and settings
 * - Default values and validation for all required parameters
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Plugin configuration structure loaded from plugins.yaml.
 * Maps tool names to normalizer modules and event types to upserter modules.
 */
export interface PluginConfig {
  pluginMap: {
    normalizers: Record<string, string>;
    upserters: Record<string, string>;
  };
}

/**
 * Complete environment configuration with typed sections for each service.
 */
export interface EnvConfig {
  kafka: {
    brokers: string[];
    groupId: string;
    rawTopic: string;
    domainTopic: string;
    dlqTopic: string;
    username: string;
    password: string;
    saslMechanism: string;
  };
  neo4j: {
    uri: string;
    user: string;
    password: string;
  };
  metrics: {
    port: number;
  };
  minio: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  qdrant: {
    url: string;
    apiKey: string;
  };
  batch: {
    flushMs: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PLUGIN CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Loads and parses the plugin configuration from plugins.yaml.
 * 
 * @returns Promise resolving to validated plugin configuration
 * @throws {Error} When plugins.yaml is missing, unreadable, or contains invalid YAML
 */
export async function loadPluginConfig(): Promise<PluginConfig> {
  const plugRaw = await readFile(new URL("../config/plugins.yaml", import.meta.url), "utf8");
  const pluginMap = load(plugRaw) as any;
  return { pluginMap } as PluginConfig;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ENVIRONMENT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Loads and validates environment configuration with appropriate defaults.
 * 
 * @returns Complete environment configuration object
 * @throws {Error} When required environment variables are missing
 * 
 * **Required Environment Variables:**
 * - `KAFKA_BROKERS_INTERNAL`: Comma-separated Kafka broker addresses
 * - `KAFKA_USERNAME`, `KAFKA_PASSWORD`: Kafka SASL authentication
 * - `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`: Neo4j connection settings
 * - `MINIO_URL`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`: MinIO object storage
 * - `QDRANT_URL`, `QDRANT_API_KEY`: Qdrant vector database connection
 * 
 * **Optional Environment Variables:**
 * - `KAFKA_GROUP_ID`: Consumer group (default: "normalizer-group")
 * - `RAW_TOPIC`: Raw messages topic (default: "tasks.raw-output")
 * - `DOMAIN_TOPIC`: Domain events topic (default: "events.domain")
 * - `DLQ_TOPIC`: Dead letter queue topic (default: "events.dlq")
 * - `KAFKA_SASL_MECHANISM`: SASL mechanism (default: "scram-sha-256")
 * - `METRICS_PORT`: Prometheus metrics port (default: 9100)
 * - `BATCH_FLUSH_MS`: Batch flush interval in milliseconds (default: 2000)
 */
export function getEnvConfig(): EnvConfig {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // KAFKA CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  
  const kafkaBrokers = process.env.KAFKA_BROKERS_INTERNAL;
  if (!kafkaBrokers) {
    throw new Error("KAFKA_BROKERS_INTERNAL environment variable is required");
  }

  const kafkaUsername = process.env.KAFKA_USERNAME;
  const kafkaPassword = process.env.KAFKA_PASSWORD;
  if (!kafkaUsername || !kafkaPassword) {
    throw new Error("KAFKA_USERNAME and KAFKA_PASSWORD environment variables are required");
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // NEO4J CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  const neo4jUri = process.env.NEO4J_URI;
  if (!neo4jUri) {
    throw new Error("NEO4J_URI environment variable is required");
  }

  const neo4jUser = process.env.NEO4J_USER;
  const neo4jPassword = process.env.NEO4J_PASSWORD;
  if (!neo4jUser || !neo4jPassword) {
    throw new Error("NEO4J_USER and NEO4J_PASSWORD environment variables are required");
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // MINIO CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  const minioUrl = process.env.MINIO_URL;
  const minioUser = process.env.MINIO_ROOT_USER;
  const minioPass = process.env.MINIO_ROOT_PASSWORD;
  if (!minioUrl || !minioUser || !minioPass) {
    throw new Error("MINIO_URL, MINIO_ROOT_USER and MINIO_ROOT_PASSWORD environment variables are required");
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // QDRANT CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  const qdrantUrl = process.env.QDRANT_URL;
  if (!qdrantUrl) {
    throw new Error("QDRANT_URL environment variable is required");
  }
  
  const qdrantKey = process.env.QDRANT_API_KEY;
  if (!qdrantKey) {
    throw new Error("QDRANT_API_KEY environment variable is required");
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // RETURN CONFIGURATION OBJECT
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  return {
    kafka: {
      brokers: kafkaBrokers.split(","),
      groupId: process.env.KAFKA_GROUP_ID || "normalizer-group",
      rawTopic: process.env.RAW_TOPIC || "tasks.raw-output",
      domainTopic: process.env.DOMAIN_TOPIC || "events.domain",
      dlqTopic: process.env.DLQ_TOPIC || "events.dlq",
      username: kafkaUsername,
      password: kafkaPassword,
      saslMechanism: process.env.KAFKA_SASL_MECHANISM || "scram-sha-256"
    },
    neo4j: {
      uri: neo4jUri,
      user: neo4jUser,
      password: neo4jPassword
    },
    metrics: {
      port: Number(process.env.METRICS_PORT) || 9100
    },
    minio: {
      endpoint: minioUrl,
      accessKeyId: minioUser,
      secretAccessKey: minioPass
    },
    qdrant: {
      url: qdrantUrl,
      apiKey: qdrantKey
    },
    batch: {
      flushMs: Number(process.env.BATCH_FLUSH_MS) || 2000
    }
  };
}
