import pinoImport from "pino";

/**
 * @fileoverview Structured logging configuration using Pino.
 * 
 * Provides a configured Pino logger instance for structured JSON logging.
 * Log output is optimized for consumption by log aggregation systems like
 * Loki or Elasticsearch.
 */

/**
 * Global Pino logger instance with configurable log level.
 * 
 * **Environment Variables:**
 * - `LOG_LEVEL`: Controls logging verbosity (default: "info")
 *   Valid levels: trace, debug, info, warn, error, fatal
 * 
 * **Features:**
 * - Structured JSON output for machine-readable logs
 * - Performance-optimized for high-throughput applications
 * - Compatible with log aggregation and monitoring systems
 */
const pino = pinoImport as unknown as (options?: any) => any;

export const logger = pino({ level: process.env.LOG_LEVEL || "info" });
