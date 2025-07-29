import { loadPluginConfig, getEnvConfig } from "./core/config.js";
import { logger } from "./core/logger.js";
import { initKafka } from "./core/kafka.js";
import { driver } from "./core/neo4j.js";
import {
  messagesConsumed,
  messagesProduced,
  processingErrors,
  batchQueueSize,
  msgLatency,
  inFlightUpsertsGauge,
  upsertsSuccess,
  startMetricsServer
} from "./core/metrics.js";
import type { EachMessagePayload } from "kafkajs";
import { retry } from "./core/util/retry.js";
import { RawMessageSchema, DomainEventSchema, type INormalizer, type IUpserter, type INormalizerModule, type IUpserterModule } from "./core/schemas.js";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ingestion service entry-point.
 *
 * This service handles the complete ingestion pipeline:
 * 1. Loads configuration & plugins
 * 2. Subscribes to Kafka raw and domain topics
 * 3. Normalizes raw tool output into domain events and batches to Kafka
 * 4. Upserts domain events into Neo4j
 * 5. Exposes Prometheus metrics on /metrics endpoint
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const envConfig = getEnvConfig();
startMetricsServer(envConfig.metrics.port);
const pluginConfig = await loadPluginConfig();
const { consumer, producer } = await initKafka();

const rawTopic = envConfig.kafka.rawTopic;
const domainTopic = envConfig.kafka.domainTopic;
const dlqTopic = envConfig.kafka.dlqTopic;

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PLUGIN SECURITY & VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Validates and resolves plugin paths to prevent directory traversal attacks.
 * 
 * @param pluginPath - The plugin path from configuration
 * @param baseDir - Base directory to restrict access to (default: "plugins")
 * @returns Resolved safe path or throws error if invalid
 * @throws {Error} When plugin path resolves outside allowed directory
 */
function validatePluginPath(pluginPath: string, baseDir = "plugins"): string {
  const cleanPath = pluginPath.replace(/[^a-zA-Z0-9/_-]/g, '');
  const fullPath = resolve(__dirname, cleanPath);
  const basePath = resolve(__dirname, baseDir);
  
  if (!fullPath.startsWith(basePath)) {
    throw new Error(`Invalid plugin path: ${pluginPath} resolves outside allowed directory`);
  }
  
  return cleanPath;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const inFlightUpserts = new Set<Promise<unknown>>();
const normalizers: Record<string, INormalizer> = {};
const upserters: Record<string, IUpserter> = {};
const batch: { topic: string; messages: { key: string | undefined; value: string }[] }[] = [];

/**
 * Updates Prometheus metrics gauges for batch queue size and in-flight upserts.
 */
function updateBatchGauge() {
  batchQueueSize.set(batch.length);
  inFlightUpsertsGauge.set(inFlightUpserts.size);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PLUGIN LOADING
// ═══════════════════════════════════════════════════════════════════════════════════════════════

for (const [tool, mod] of Object.entries(pluginConfig.pluginMap.normalizers as Record<string,string>)) {
  const modPath = mod as string;
  try {
    const safePath = validatePluginPath(modPath);
    const module = (await import(`./${safePath}.js`)) as INormalizerModule;
    normalizers[tool] = module.default;
    logger.info({tool},"loaded normalizer");
  } catch (err) { 
    logger.warn({tool, error: err instanceof Error ? err.message : String(err)},"normalizer loading failed; skipped"); 
  }
}

for (const [evt, mod] of Object.entries(pluginConfig.pluginMap.upserters as Record<string,string>)) {
  const modPath = mod as string;
  try {
    const safePath = validatePluginPath(modPath);
    const module = (await import(`./${safePath}.js`)) as IUpserterModule;
    upserters[evt] = module.default;
    logger.info({evt},"loaded upserter");
  } catch (err) { 
    logger.warn({evt, error: err instanceof Error ? err.message : String(err)},"upserter loading failed; skipped"); 
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BATCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Flushes accumulated domain events to Kafka with retry logic and metrics tracking.
 * Empties the current batch and sends all messages in a single batch operation.
 */
async function flushBatch() {
  if (!batch.length) return;
  const sending = batch.splice(0, batch.length);
  await retry(() => producer.sendBatch({ topicMessages: sending }));
  const producedCount = sending.reduce((acc, tm) => acc + tm.messages.length, 0);
  messagesProduced.inc(producedCount);
}

const flushTimer = setInterval(() => {
  flushBatch().catch((err) => logger.error({ err }, "flushBatch failed"));
  updateBatchGauge();
}, envConfig.batch.flushMs);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// KAFKA SUBSCRIPTION & MESSAGE PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════════════════════

await consumer.subscribe({ topic: rawTopic, fromBeginning: false });
await consumer.subscribe({ topic: domainTopic, fromBeginning: false });

logger.info("ingestion service ready");

await consumer.run({
  eachMessage: async ({ topic, message }: EachMessagePayload) => {
    if (!message.value) return;
    const rawBytes = message.value.toString("utf8");

    const handle = async () => {
      messagesConsumed.labels(topic).inc();
      const obj = JSON.parse(rawBytes);
      const start = performance.now();

      if (topic === rawTopic) {
        const { success } = RawMessageSchema.safeParse(obj);
        if (!success) throw new Error("RAW message schema violation");

        const norm = normalizers[obj.tool];
        if (norm) {
          const events = norm(obj) || [];
          for (const ev of events) {
            const { success: ok } = DomainEventSchema.safeParse(ev);
            if (!ok) throw new Error("Domain event schema violation");
            batch.push({
              topic: domainTopic,
              messages: [{ key: ev.event?.fingerprint, value: JSON.stringify(ev) }]
            });
          }
        }
        msgLatency.labels("raw").observe((performance.now() - start) / 1000);
      } else if (topic === domainTopic) {
        const { success } = DomainEventSchema.safeParse(obj);
        if (!success) throw new Error("Domain event schema violation");

        const up = upserters[obj.event?.event_type];
        if (up) {
          const p = up(obj).catch(e=>{throw e;});
          inFlightUpserts.add(p);
          await p;
          inFlightUpserts.delete(p);
          upsertsSuccess.labels("neo4j").inc();
          msgLatency.labels("upsert").observe((performance.now() - start) / 1000);
        }
      }
    };

    retry(handle, { retries: 2 }).catch(async (err) => {
      processingErrors.labels(topic, err?.name ?? "unknown").inc();
      logger.error({ err }, "failed permanently, sending to DLQ");
      try {
        await producer.send({ topic: dlqTopic, messages: [{ value: rawBytes }] });
      } catch (dlqErr) {
        logger.error({ dlqErr }, "DLQ publish failed");
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════════════════════

process.on("SIGINT", async () => {
  try {
    clearInterval(flushTimer);
    await flushBatch();
    if (inFlightUpserts.size) {
      logger.info(`Waiting for ${inFlightUpserts.size} in-flight upserts...`);
      await Promise.allSettled(inFlightUpserts);
    }
    await consumer.stop();
    await consumer.disconnect();
    await producer.disconnect();
    await driver.close();
  } finally {
    process.exit(0);
  }
});
