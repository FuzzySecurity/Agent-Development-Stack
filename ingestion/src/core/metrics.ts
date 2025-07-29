/**
 * @fileoverview Prometheus metrics collection and HTTP server for the ingestion service.
 * 
 * Provides comprehensive monitoring for message processing, including:
 * - Message consumption and production counters
 * - Processing error tracking with detailed labels
 * - Real-time gauge metrics for queue sizes and in-flight operations
 * - Latency histograms for performance monitoring
 * - HTTP server exposing metrics at /metrics endpoint
 */

import http from "node:http";
import client from "prom-client";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// COUNTER METRICS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const messagesConsumed = new client.Counter({
  name: "ingestion_messages_consumed_total",
  help: "Total messages consumed from Kafka topics",
  labelNames: ["topic"]
});

export const messagesProduced = new client.Counter({
  name: "ingestion_messages_produced_total",
  help: "Total messages produced to Kafka topics",
  labelNames: ["topic"]
});

export const upsertsSuccess = new client.Counter({
  name: "ingestion_upserts_success_total",
  help: "Total successful upsert operations to storage systems",
  labelNames: ["db"]
});

export const processingErrors = new client.Counter({
  name: "ingestion_processing_errors_total",
  help: "Total processing errors by stage and error type",
  labelNames: ["stage", "reason"]
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// GAUGE METRICS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const batchQueueSize = new client.Gauge({
  name: "ingestion_batch_queue_size",
  help: "Current number of messages buffered awaiting batch flush"
});

export const inFlightUpsertsGauge = new client.Gauge({
  name: "ingestion_upserts_in_flight",
  help: "Current number of upsert operations in progress"
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// HISTOGRAM METRICS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const msgLatency = new client.Histogram({
  name: "ingestion_message_latency_seconds",
  help: "Message processing latency by stage in seconds",
  labelNames: ["stage"],
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// METRICS SERVER
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// Enable collection of default Node.js process metrics
client.collectDefaultMetrics();

/**
 * Starts an HTTP server that exposes Prometheus metrics at the /metrics endpoint.
 * 
 * @param port - Port number for the metrics server (default: 9100)
 * @returns HTTP server instance for potential shutdown handling
 */
export function startMetricsServer(port = 9100) {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": client.register.contentType });
      res.end(await client.register.metrics());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Prometheus metrics exposed on :${port}/metrics`);
  });
  
  return server;
} 