import { z } from "zod";
import { fingerprint } from "../../core/util/fingerprint.js";
import type { RawMessage, DomainEvent, INormalizer } from "../../core/schemas.js";

/**
 * @fileoverview Example normalizer plugin for sensor data ingestion.
 * 
 * Demonstrates transformation of raw sensor reports into standardized domain events
 * with comprehensive validation, type derivation, and metadata enrichment. Serves
 * as a reference implementation for building domain-specific normalizers.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SCHEMA DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Validation schema for incoming raw sensor data from external tools.
 * Ensures consistent structure and data types for sensor measurements.
 */
const RawSensorSchema = z.object({
  tool: z.literal("sensor_report"),
  schemaVersion: z.string(),
  runId: z.string(),
  data: z.object({
    sensorId: z.string(),
    value: z.number(),
    unit: z.string(),
    location: z.string()
  })
});

/**
 * Validation schema for the normalized domain event output.
 * Provides compile-time and runtime verification of the transformation result.
 */
const DomainEventSchema = z.object({
  specVersion: z.literal("1.0"),
  event: z.object({
    event_type: z.literal("SENSOR_READING"),
    fingerprint: z.string()
  }),
  meta: z.object({
    sensorId: z.string(),
    sensorType: z.string(),
    value: z.number(),
    unit: z.string(),
    location: z.string(),
    toolRunId: z.string(),
    normalizerVersion: z.string(),
    source: z.string(),
    rawTool: z.string(),
    rawRunId: z.string()
  })
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// NORMALIZER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Transforms raw sensor measurements into standardized SENSOR_READING domain events.
 * 
 * This normalizer handles sensor data from monitoring tools and enriches it with:
 * - Automatic sensor type classification based on sensor ID patterns
 * - Deterministic fingerprinting for deduplication
 * - Comprehensive metadata including version tracking and lineage
 * - Robust validation at both input and output stages
 * 
 * @param raw - Raw message containing sensor measurement data
 * @returns Array containing single SENSOR_READING domain event, or null if invalid
 */
const normalize: INormalizer = (raw: RawMessage): DomainEvent[] | null => {
  const parsed = RawSensorSchema.safeParse(raw);
  if (!parsed.success) return null;

  const { data: payload } = parsed.data;
  const sensorType = deriveSensorType(payload.sensorId);

  const fp = fingerprint({
    type: "SENSOR_READING",
    sensor: payload.sensorId,
    location: payload.location,
    value: payload.value,
    unit: payload.unit
  });

  const domain = {
    specVersion: "1.0",
    event: {
      event_type: "SENSOR_READING",
      fingerprint: fp
    },
    meta: {
      sensorId: payload.sensorId,
      sensorType,
      value: payload.value,
      unit: payload.unit,
      location: payload.location,
      toolRunId: parsed.data.runId,
      normalizerVersion: "0.0.3-typed",
      source: "central",
      rawTool: parsed.data.tool,
      rawRunId: parsed.data.runId
    }
  };

  // Validate the produced domain event structure (Optional)
  DomainEventSchema.parse(domain);

  return [domain as unknown as DomainEvent];
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Derives sensor type classification from sensor identifier using pattern matching.
 * 
 * Uses heuristic analysis of sensor ID strings to automatically classify sensors
 * into standard categories. This enables downstream systems to apply type-specific
 * processing and visualization without manual configuration.
 * 
 * @param sensorId - Unique sensor identifier string
 * @returns Sensor type classification string
 * 
 * @example
 * ```typescript
 * deriveSensorType("temp-sensor-01") // returns "temperature"
 * deriveSensorType("humidity-probe-office") // returns "humidity"
 * deriveSensorType("unknown-device-xyz") // returns "generic"
 * ```
 */
function deriveSensorType(sensorId: string): string {
  const id = sensorId.toLowerCase();
  if (id.includes("temp") || id.includes("temperature")) return "temperature";
  if (id.includes("humid") || id.includes("moisture")) return "humidity";
  if (id.includes("pressure") || id.includes("press")) return "pressure";
  if (id.includes("light") || id.includes("lux")) return "light";
  if (id.includes("motion") || id.includes("pir")) return "motion";
  if (id.includes("air") || id.includes("co2")) return "air_quality";
  return "generic";
}

export default normalize;
