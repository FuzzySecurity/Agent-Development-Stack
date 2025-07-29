import { Kafka, logLevel, Partitioners } from "kafkajs";

/**
 * @fileoverview Kafka client initialization and configuration for the ingestion service.
 * 
 * Establishes connections to Kafka brokers with SASL authentication and configures
 * both consumer and producer instances. Supports flexible partitioner configuration
 * and SSL settings for secure communication.
 */

// Suppress KafkaJS partitioner deprecation warning
process.env.KAFKAJS_NO_PARTITIONER_WARNING = "1";

/**
 * Initializes KafkaJS client, consumer, and producer using environment variables.
 * 
 * @returns Promise resolving to connected consumer and producer instances
 * @throws {Error} When required environment variables are missing
 * 
 * **Required Environment Variables:**
 * - `KAFKA_BROKERS_INTERNAL`: Comma-separated list of Kafka broker addresses
 * - `KAFKA_USERNAME`: SASL authentication username
 * - `KAFKA_PASSWORD`: SASL authentication password
 * 
 * **Optional Environment Variables:**
 * - `KAFKA_GROUP_ID`: Consumer group identifier (default: "normalizer-group")
 * - `KAFKA_SASL_MECHANISM`: SASL authentication mechanism (default: "scram-sha-256")
 * - `KAFKA_USE_LEGACY_PARTITIONER`: Use legacy partitioner for message distribution (default: "false")
 */
export async function initKafka() {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // ENVIRONMENT VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  
  if (!process.env.KAFKA_USERNAME || !process.env.KAFKA_PASSWORD) {
    throw new Error(
      "KAFKA_USERNAME and KAFKA_PASSWORD must be set - SASL authentication is required"
    );
  }

  if (!process.env.KAFKA_BROKERS_INTERNAL) {
    throw new Error("KAFKA_BROKERS_INTERNAL environment variable is required");
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // CLIENT CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  const extra: Record<string, unknown> = {
    sasl: {
      mechanism: process.env.KAFKA_SASL_MECHANISM || "scram-sha-256",
      username: process.env.KAFKA_USERNAME,
      password: process.env.KAFKA_PASSWORD
    },
    ssl: { rejectUnauthorized: false }
  };

  const kafka = new Kafka({
    clientId: "ingestion",
    brokers: process.env.KAFKA_BROKERS_INTERNAL.split(","),
    logLevel: logLevel.NOTHING,
    ...extra
  });
  
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // CONSUMER & PRODUCER SETUP
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  
  const groupId = process.env.KAFKA_GROUP_ID || "normalizer-group";
  const consumer = kafka.consumer({ groupId });
  
  const producerConfig: any = {};
  if (process.env.KAFKA_USE_LEGACY_PARTITIONER === "true") {
    producerConfig.createPartitioner = Partitioners.LegacyPartitioner;
  }
  
  const producer = kafka.producer(producerConfig);
  
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // CONNECTION ESTABLISHMENT
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  
  await consumer.connect(); 
  await producer.connect();
  
  return { consumer, producer };
}
