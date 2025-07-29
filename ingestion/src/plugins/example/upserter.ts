import { driver } from "../../core/neo4j.js";
import { retry } from "../../core/util/retry.js";
import type { DomainEvent, IUpserter } from "../../core/schemas.js";

/**
 * @fileoverview Example upserter plugin for sensor data domain events.
 * 
 * Demonstrates a comprehensive graph data model for IoT sensor networks,
 * including entities, relationships, co-location detection, and statistical
 * aggregations. Serves as a reference implementation for building domain-specific
 * upserters that create rich, queryable graph structures in Neo4j.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Shared Neo4j session for all upsert operations.
 * Reusing a single session improves performance by avoiding the overhead
 * of session creation/destruction for each event. The session is managed
 * globally and closed during application shutdown.
 */
const session = driver.session();

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// UPSERTER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Example upserter for SENSOR_READING domain events.
 * 
 * Creates a comprehensive graph model for sensor networks with the following structure:
 * 
 * **Entities:**
 * - `Sensor`: Individual sensor devices with properties and state
 * - `Location`: Physical locations where sensors are deployed
 * - `SensorType`: Categories/types of sensors for classification
 * - `SensorReading`: Individual measurement records with deduplication
 * 
 * **Relationships:**
 * - `(:Sensor)-[:LOCATED_AT]->(:Location)`: Sensor deployment locations
 * - `(:Sensor)-[:IS_TYPE]->(:SensorType)`: Sensor classification
 * - `(:Sensor)-[:CO_LOCATED]->(:Sensor)`: Sensors at the same location
 * - `(:SensorReading)-[:FROM_SENSOR]->(:Sensor)`: Reading source tracking
 * 
 * **Features:**
 * - Automatic co-location relationship detection
 * - Reading deduplication using fingerprints
 * - Real-time location statistics and aggregations
 * - Comprehensive metadata tracking and timestamps
 * 
 * @param ev - Validated SENSOR_READING domain event
 * @throws {Error} When Neo4j operations fail after retries
 */
const upsert: IUpserter = async (ev: DomainEvent): Promise<void> => {
  const s = session;
  
  try {
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // SENSOR ENTITY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    
    await retry(() => s.run(`
      MERGE (sensor:Sensor {id: $sensorId})
        ON CREATE SET 
          sensor.createdAt = timestamp(),
          sensor.firstSeen = timestamp()
      SET 
        sensor.lastSeen = timestamp(),
        sensor.currentValue = $value,
        sensor.unit = $unit,
        sensor.type = $sensorType
    `, {
      sensorId: ev.meta.sensorId,
      value: ev.meta.value,
      unit: ev.meta.unit,
      sensorType: ev.meta.sensorType
    }));

    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // LOCATION ENTITY AND RELATIONSHIPS
    // ═══════════════════════════════════════════════════════════════════════════════════════════

    await retry(() => s.run(`
      MERGE (location:Location {name: $location})
        ON CREATE SET 
          location.createdAt = timestamp(),
          location.sensorCount = 0
      WITH location
      MATCH (sensor:Sensor {id: $sensorId})
      MERGE (sensor)-[located:LOCATED_AT]->(location)
        ON CREATE SET 
          located.since = timestamp(),
          location.sensorCount = location.sensorCount + 1
      SET located.lastReading = timestamp()
    `, {
      location: ev.meta.location,
      sensorId: ev.meta.sensorId
    }));

    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // SENSOR TYPE CLASSIFICATION
    // ═══════════════════════════════════════════════════════════════════════════════════════════

    await retry(() => s.run(`
      MERGE (sensorType:SensorType {name: $sensorType})
        ON CREATE SET 
          sensorType.createdAt = timestamp(),
          sensorType.sensorCount = 0
      WITH sensorType
      MATCH (sensor:Sensor {id: $sensorId})
      MERGE (sensor)-[isType:IS_TYPE]->(sensorType)
        ON CREATE SET 
          isType.since = timestamp(),
          sensorType.sensorCount = sensorType.sensorCount + 1
    `, {
      sensorType: ev.meta.sensorType,
      sensorId: ev.meta.sensorId
    }));

    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // CO-LOCATION RELATIONSHIP DETECTION
    // ═══════════════════════════════════════════════════════════════════════════════════════════

    await retry(() => s.run(`
      MATCH (thisSensor:Sensor {id: $sensorId})-[:LOCATED_AT]->(location:Location)
      MATCH (otherSensor:Sensor)-[:LOCATED_AT]->(location)
      WHERE thisSensor <> otherSensor
      MERGE (thisSensor)-[colocated:CO_LOCATED]-(otherSensor)
        ON CREATE SET colocated.since = timestamp()
      SET colocated.lastUpdate = timestamp()
    `, {
      sensorId: ev.meta.sensorId
    }));

    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // SENSOR READING RECORD WITH DEDUPLICATION
    // ═══════════════════════════════════════════════════════════════════════════════════════════

    await retry(() => s.run(`
      MATCH (sensor:Sensor {id: $sensorId})
      MERGE (reading:SensorReading {fingerprint: $fingerprint})
        ON CREATE SET 
          reading.value = $value,
          reading.unit = $unit,
          reading.timestamp = timestamp(),
          reading.toolRunId = $toolRunId,
          reading.createdAt = timestamp()
        ON MATCH SET
          reading.lastSeen = timestamp(),
          reading.duplicateCount = COALESCE(reading.duplicateCount, 0) + 1
      MERGE (reading)-[:FROM_SENSOR]->(sensor)
    `, {
      sensorId: ev.meta.sensorId,
      fingerprint: ev.event.fingerprint,
      value: ev.meta.value,
      unit: ev.meta.unit,
      toolRunId: ev.meta.toolRunId
    }));

    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // LOCATION STATISTICS AND AGGREGATIONS
    // ═══════════════════════════════════════════════════════════════════════════════════════════

    await retry(() => s.run(`
      MATCH (location:Location {name: $location})<-[:LOCATED_AT]-(sensors:Sensor)
      WITH location, 
           count(sensors) as totalSensors,
           collect(DISTINCT sensors.type) as sensorTypes
      SET 
        location.totalSensors = totalSensors,
        location.sensorTypes = sensorTypes,
        location.lastUpdate = timestamp()
    `, {
      location: ev.meta.location
    }));

  } finally {
    // Session is managed globally and closed during application shutdown
  }
};

export default upsert;
