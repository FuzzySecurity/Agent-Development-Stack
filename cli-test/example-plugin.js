#!/usr/bin/env node
/**
 * AI-Agent Example Plugin CLI Utility
 * -----------------------------------
 * Comprehensive testing tool for the example sensor plugin. This utility provides
 * end-to-end testing of the sensor data ingestion pipeline by:
 *   • Sending raw sensor_report messages to Kafka for processing
 *   • Querying Neo4j to verify correct data transformation and storage
 *   • Validating relationship creation between sensors, locations, and types
 *   • Testing the complete plugin pipeline (not mock implementations)
 *
 * Quick Examples
 * --------------
 *  # Send a test sensor reading and let the real plugin process it
 *  node unittest/example-plugin.js --test
 *
 *  # Send custom sensor data with full location context
 *  node unittest/example-plugin.js --send --sensor temp-kitchen --value 23.5 --unit celsius --location kitchen
 *
 *  # Query stored data and relationships
 *  node unittest/example-plugin.js --query-sensors
 *  node unittest/example-plugin.js --query-locations
 *  node unittest/example-plugin.js --query-relationships
 *
 *  # Verify plugin configuration and clean up test data
 *  node unittest/example-plugin.js --verify-config
 *  node unittest/example-plugin.js --cleanup
 *
 * Environment
 * -----------
 * The script reads the sibling "../.env" file (if present) and populates any
 * missing environment variables. Required variables:
 *   KAFKA_BROKERS_EXTERNAL = localhost:19094 (or your external Kafka port)
 *   KAFKA_USERNAME = kafka (SASL authentication username)
 *   KAFKA_PASSWORD = changeme (SASL authentication password)
 *   KAFKA_SASL_MECHANISM = SCRAM-SHA-256 (default if not specified)
 *   NEO4J_BOLT_EXTERNAL = neo4j+ssc://localhost:7687 (Neo4j connection)
 *   NEO4J_USER = neo4j (Neo4j authentication username)
 *   NEO4J_PASSWORD = your_password (Neo4j authentication password)
 *   TOPIC_RAW = tasks.raw-output (Kafka topic for raw sensor data)
 *
 * Plugin Architecture
 * ------------------
 * This tool tests the complete sensor plugin workflow:
 *   1. Raw sensor data → Kafka (tasks.raw-output topic)
 *   2. Normalizer transforms raw data → Domain events
 *   3. Domain events → Kafka (events.domain topic)
 *   4. Upserter persists to Neo4j with relationships:
 *      - (:Sensor)-[:LOCATED_AT]->(:Location)
 *      - (:Sensor)-[:IS_TYPE]->(:SensorType)
 *      - (:Sensor)-[:CO_LOCATED]->(:Sensor)
 *      - (:SensorReading)-[:FROM_SENSOR]->(:Sensor)
 *
 * Data Flow Validation
 * -------------------
 * The tool validates that sensor data flows correctly through:
 *   • Schema validation (raw-schema.json → domain-schema.json)
 *   • Sensor type derivation from sensor IDs
 *   • Automatic relationship creation between co-located sensors
 *   • Location-based sensor clustering and statistics
 *   • Fingerprint-based deduplication and idempotency
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load environment variables from a "../.env" file if present.
 * Values already present in process.env are NOT overwritten.
 * @returns {void}
 */
function loadDotEnv() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, "../.env");

  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const [key, ...rest] = line.split("=");
    if (!key) continue;
    const value = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

// Silence KafkaJS partitioner warning for clean output
process.env.KAFKAJS_NO_PARTITIONER_WARNING = "1";

// ---------------------------------------------------------------------------
// Console formatting and output utilities
// ---------------------------------------------------------------------------
const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m"
};

const fmt = {
  ok: (msg) => `${COLOR.green}✔${COLOR.reset} ${msg}`,
  info: (msg) => `${COLOR.cyan}ℹ${COLOR.reset} ${msg}`,
  warn: (msg) => `${COLOR.yellow}⚠${COLOR.reset} ${msg}`,
  err: (msg) => `${COLOR.red}✖${COLOR.reset} ${msg}`,
  test: (msg) => `${COLOR.magenta}⚗${COLOR.reset} ${msg}`,
  data: (msg) => `${COLOR.blue}📊${COLOR.reset} ${msg}`
};

// ---------------------------------------------------------------------------
// HELP DOCUMENTATION
// ---------------------------------------------------------------------------

/**
 * Display comprehensive help information for the CLI tool.
 * @returns {void}
 */
function printHelp() {
  console.log(`
${COLOR.cyan}Example Plugin Test Tool${COLOR.reset}
${COLOR.dim}══════════════════════════${COLOR.reset}
Comprehensive testing utility for the AI-Agent sensor plugin pipeline.

${COLOR.yellow}COMMANDS${COLOR.reset} (choose one or more)
  ${COLOR.green}--test${COLOR.reset}                    Send a randomized sample sensor reading
  ${COLOR.green}--send${COLOR.reset}                    Send custom sensor data (requires --sensor, --value, --unit, --location)
  ${COLOR.green}--query-sensors${COLOR.reset}           List all sensor entities with current values and metadata
  ${COLOR.green}--query-locations${COLOR.reset}         Show locations with sensor counts and type distribution
  ${COLOR.green}--query-readings${COLOR.reset}          Display recent sensor readings with timestamps
  ${COLOR.green}--query-relationships${COLOR.reset}     Analyze co-location and type-based sensor relationships
  ${COLOR.green}--verify-config${COLOR.reset}           Validate plugin configuration and file structure
  ${COLOR.green}--cleanup${COLOR.reset}                 Remove all test data from Neo4j (sensors, locations, readings)

${COLOR.yellow}OPTIONS${COLOR.reset}
  ${COLOR.cyan}--sensor <id>${COLOR.reset}             Sensor identifier for custom data (e.g., temp-kitchen-01)
  ${COLOR.cyan}--value <number>${COLOR.reset}          Numeric sensor reading value
  ${COLOR.cyan}--unit <string>${COLOR.reset}           Measurement unit (e.g., celsius, fahrenheit, percent, lux)
  ${COLOR.cyan}--location <name>${COLOR.reset}         Physical location name (e.g., kitchen, bedroom, office)
  ${COLOR.cyan}--verbose${COLOR.reset}                 Show detailed output including raw message payloads

${COLOR.yellow}EXAMPLES${COLOR.reset}
  Test with randomized sample data:
    ${COLOR.dim}node unittest/example-plugin.js --test${COLOR.reset}

  Send specific sensor reading:
    ${COLOR.dim}node unittest/example-plugin.js --send --sensor temp-kitchen-01 --value 22.1 --unit celsius --location kitchen${COLOR.reset}

  Create co-located sensors for relationship testing:
    ${COLOR.dim}node unittest/example-plugin.js --send --sensor humidity-office-01 --value 45.2 --unit percent --location office${COLOR.reset}
    ${COLOR.dim}node unittest/example-plugin.js --send --sensor light-office-01 --value 750 --unit lux --location office${COLOR.reset}

  Comprehensive data analysis:
    ${COLOR.dim}node unittest/example-plugin.js --query-sensors --query-locations --query-relationships${COLOR.reset}

  Pipeline validation workflow:
    ${COLOR.dim}node unittest/example-plugin.js --verify-config --cleanup --test --query-sensors${COLOR.reset}

${COLOR.yellow}DATA FLOW VALIDATION${COLOR.reset}
  ${COLOR.dim}1. Raw sensor_report message → Kafka (tasks.raw-output)${COLOR.reset}
  ${COLOR.dim}2. Normalizer validates schema and derives sensor type${COLOR.reset}
  ${COLOR.dim}3. Domain SENSOR_READING event → Kafka (events.domain)${COLOR.reset}
  ${COLOR.dim}4. Upserter creates Neo4j entities and relationships${COLOR.reset}
  ${COLOR.dim}5. Query commands validate complete data transformation${COLOR.reset}

${COLOR.yellow}RELATIONSHIP TESTING${COLOR.reset}
  The plugin automatically creates these relationships in Neo4j:
  ${COLOR.dim}• Sensors ↔ Locations (geographic clustering)${COLOR.reset}
  ${COLOR.dim}• Sensors ↔ Types (functional classification)${COLOR.reset}
  ${COLOR.dim}• Co-located sensors (proximity-based connections)${COLOR.reset}
  ${COLOR.dim}• Readings ↔ Sensors (temporal data association)${COLOR.reset}
`);
}

// ---------------------------------------------------------------------------
// CLI ARGUMENT PARSING
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flags = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "--test":
      flags.test = true;
      break;
    case "--send":
      flags.send = true;
      break;
    case "--query-sensors":
      flags.querySensors = true;
      break;
    case "--query-locations":
      flags.queryLocations = true;
      break;
    case "--query-readings":
      flags.queryReadings = true;
      break;
    case "--query-relationships":
      flags.queryRelationships = true;
      break;
    case "--verify-config":
      flags.verifyConfig = true;
      break;
    case "--cleanup":
      flags.cleanup = true;
      break;
    case "--sensor":
      flags.sensor = args[++i];
      break;
    case "--value":
      flags.value = parseFloat(args[++i]);
      break;
    case "--unit":
      flags.unit = args[++i];
      break;
    case "--location":
      flags.location = args[++i];
      break;
    case "--verbose":
      flags.verbose = true;
      break;
    case "--help":
    case "-h":
      printHelp();
      process.exit(0);
    default:
      console.error(fmt.err(`Unknown argument: ${COLOR.yellow}${arg}${COLOR.reset}`));
      console.log(`Use ${COLOR.green}--help${COLOR.reset} for usage information.`);
      process.exit(1);
  }
}

if (args.length === 0) {
  printHelp();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// DATA GENERATION FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Generate randomized sample sensor data matching the raw-schema.json specification.
 * Creates realistic sensor readings with proper location and type correlation.
 * @returns {Object} Raw sensor message object for Kafka production
 */
function generateSampleRawData() {
  const locations = ["kitchen", "living_room", "bedroom", "office", "garage"];
  const sensorTypes = ["temp", "humidity", "pressure", "light", "motion"];
  
  const randomLocation = locations[Math.floor(Math.random() * locations.length)];
  const randomType = sensorTypes[Math.floor(Math.random() * sensorTypes.length)];
  
  // Generate realistic values based on sensor type
  let value, unit;
  switch (randomType) {
    case "temp":
      value = 18 + (Math.random() * 12); // 18-30°C
      unit = "celsius";
      break;
    case "humidity":
      value = 30 + (Math.random() * 40); // 30-70%
      unit = "percent";
      break;
    case "pressure":
      value = 1010 + (Math.random() * 30); // 1010-1040 hPa
      unit = "hPa";
      break;
    case "light":
      value = Math.random() * 1000; // 0-1000 lux
      unit = "lux";
      break;
    case "motion":
      value = Math.random() > 0.7 ? 1 : 0; // Binary motion detection
      unit = "boolean";
      break;
    default:
      value = 20 + (Math.random() * 15);
      unit = "units";
  }
  
  return {
    tool: "sensor_report",
    schemaVersion: "1.0",
    runId: `test-${Date.now()}`,
    data: {
      sensorId: `${randomType}-${randomLocation}-01`,
      value: Math.round(value * 100) / 100, // Round to 2 decimal places
      unit,
      location: randomLocation
    }
  };
}

/**
 * Create custom raw sensor data with user-specified parameters.
 * Validates input parameters and ensures schema compliance.
 * @param {string} sensorId - Unique sensor identifier
 * @param {number} value - Numeric sensor reading
 * @param {string} unit - Measurement unit
 * @param {string} location - Physical location name
 * @returns {Object} Raw sensor message object for Kafka production
 */
function createCustomRawData(sensorId, value, unit, location) {
  if (!sensorId || typeof value !== 'number' || !unit || !location) {
    throw new Error("All parameters (sensorId, value, unit, location) are required");
  }
  
  return {
    tool: "sensor_report", 
    schemaVersion: "1.0",
    runId: `custom-${Date.now()}`,
    data: {
      sensorId,
      value,
      unit,
      location
    }
  };
}

// ---------------------------------------------------------------------------
// KAFKA INTEGRATION FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Send raw sensor message to Kafka for ingestion service processing.
 * Handles connection, authentication, message production, and cleanup.
 * @param {Object} rawData - Raw sensor message object
 * @returns {Promise<void>}
 */
async function sendToKafka(rawData) {
  console.log(fmt.test(`Producing sensor data to Kafka pipeline...`));
  
  if (flags.verbose) {
    console.log(fmt.info("Raw message payload:"));
    console.log(JSON.stringify(rawData, null, 2).split('\n').map(line => `  ${COLOR.dim}${line}${COLOR.reset}`).join('\n'));
    console.log();
  }

  try {
    const { Kafka } = await import("kafkajs");
    
    const kafka = new Kafka({
      clientId: "example-plugin-test",
      brokers: (process.env.KAFKA_BROKERS_EXTERNAL || "localhost:19094").split(","),
      sasl: {
        mechanism: process.env.KAFKA_SASL_MECHANISM || "SCRAM-SHA-256",
        username: process.env.KAFKA_USERNAME || "kafka",
        password: process.env.KAFKA_PASSWORD || "changeme"
      },
      ssl: { rejectUnauthorized: false }
    });
    
    const producer = kafka.producer();
    await producer.connect();
    
    const topic = process.env.TOPIC_RAW || "tasks.raw-output";
    const result = await producer.send({
      topic,
      messages: [{ 
        value: JSON.stringify(rawData),
        timestamp: Date.now().toString()
      }]
    });
    
    await producer.disconnect();
    
    // Enhanced success reporting with metadata
    console.log(fmt.ok(`Message successfully sent to Kafka`));
    console.log(`┌─ Kafka Metadata`);
    console.log(`├─ Topic: ${COLOR.cyan}${topic}${COLOR.reset}`);
    result.forEach((r, i) => {
      console.log(`├─ Partition: ${COLOR.yellow}${r.partition}${COLOR.reset}, Offset: ${COLOR.yellow}${r.baseOffset}${COLOR.reset}`);
    });
    console.log(`└─ Message Details`);
    console.log(`   ├─ Sensor ID: ${COLOR.yellow}${rawData.data.sensorId}${COLOR.reset}`);
    console.log(`   ├─ Value: ${COLOR.green}${rawData.data.value} ${rawData.data.unit}${COLOR.reset}`);
    console.log(`   ├─ Location: ${COLOR.magenta}${rawData.data.location}${COLOR.reset}`);
    console.log(`   └─ Run ID: ${COLOR.dim}${rawData.runId}${COLOR.reset}`);
    console.log();
    
    console.log(fmt.info("Expected ingestion pipeline flow:"));
    console.log(`  ${COLOR.dim}1.${COLOR.reset} Message picked up from ${COLOR.cyan}${topic}${COLOR.reset}`);
    console.log(`  ${COLOR.dim}2.${COLOR.reset} Processed by ${COLOR.cyan}sensor_report${COLOR.reset} normalizer`);
    console.log(`  ${COLOR.dim}3.${COLOR.reset} Domain ${COLOR.cyan}SENSOR_READING${COLOR.reset} event published`);
    console.log(`  ${COLOR.dim}4.${COLOR.reset} Upserter creates Neo4j entities and relationships`);
    console.log();
    console.log(`${fmt.info("Verify results with:")} ${COLOR.green}--query-sensors${COLOR.reset} ${COLOR.dim}or${COLOR.reset} ${COLOR.green}--query-locations${COLOR.reset}`);
    
  } catch (err) {
    console.error(fmt.err(`Kafka operation failed: ${err.message}`));
    console.log(`${COLOR.dim}Common issues:${COLOR.reset}`);
    console.log(`  • Verify Kafka container is running: ${COLOR.cyan}docker ps | grep kafka${COLOR.reset}`);
    console.log(`  • Check environment variables: KAFKA_BROKERS_EXTERNAL, KAFKA_USERNAME, KAFKA_PASSWORD`);
    console.log(`  • Validate network connectivity to Kafka broker`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// NEO4J QUERY FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Query and display all sensor entities from Neo4j with comprehensive metadata.
 * Shows sensor types, locations, current values, and temporal information.
 * @returns {Promise<void>}
 */
async function runQuerySensors() {
  console.log(fmt.data("Analyzing sensor entities in Neo4j database..."));
  
  if (!process.env.NEO4J_BOLT_EXTERNAL || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    console.error(fmt.err("Neo4j connection credentials required"));
    console.error(`${COLOR.dim}Set these environment variables:${COLOR.reset}`);
    console.error(`  • NEO4J_BOLT_EXTERNAL (e.g., neo4j+ssc://localhost:7687)`);
    console.error(`  • NEO4J_USER (e.g., neo4j)`);
    console.error(`  • NEO4J_PASSWORD (your database password)`);
    process.exit(1);
  }
  
  try {
    const neo4j = await import("neo4j-driver");
    const driver = neo4j.default.driver(
      process.env.NEO4J_BOLT_EXTERNAL,
      neo4j.default.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
      { disableLosslessIntegers: true }
    );
   
   const session = driver.session();
   const result = await session.run(`
     MATCH (sensor:Sensor)-[:LOCATED_AT]->(location:Location)
     MATCH (sensor)-[:IS_TYPE]->(sensorType:SensorType)
     RETURN sensor.id as sensorId, 
            sensor.currentValue as value, 
            sensor.unit as unit,
            sensor.type as type,
            location.name as location,
            sensorType.name as sensorType,
            sensor.createdAt as created, 
            sensor.lastSeen as lastSeen
     ORDER BY sensor.lastSeen DESC
   `);
   
   await session.close();
   await driver.close();
   
   if (result.records.length === 0) {
     console.log(fmt.info("No sensor entities found in database"));
     console.log(`${COLOR.dim}To create test data:${COLOR.reset}`);
     console.log(`  • Send sample data: ${COLOR.green}--test${COLOR.reset}`);
     console.log(`  • Send custom data: ${COLOR.green}--send --sensor <id> --value <num> --unit <unit> --location <loc>${COLOR.reset}`);
     return;
   }
   
   // Enhanced table output with statistics
   console.log(fmt.ok(`Database contains ${COLOR.yellow}${result.records.length}${COLOR.reset} sensor entities:`));
   console.log();
   
   // Group by location for better organization
   const sensorsByLocation = {};
   for (const record of result.records) {
     const location = record.get('location');
     if (!sensorsByLocation[location]) sensorsByLocation[location] = [];
     sensorsByLocation[location].push(record);
   }
   
   Object.keys(sensorsByLocation).sort().forEach(location => {
     console.log(`📍 ${COLOR.magenta}${location.toUpperCase()}${COLOR.reset}`);
     console.log(`${'─'.repeat(location.length + 4)}`);
     
     sensorsByLocation[location].forEach(record => {
       const sensorId = record.get('sensorId');
       const value = record.get('value');
       const unit = record.get('unit');
       const type = record.get('type');
       const sensorType = record.get('sensorType');
       const created = new Date(record.get('created'));
       const lastSeen = new Date(record.get('lastSeen'));
       
       console.log(`┌─ ${COLOR.cyan}${sensorId}${COLOR.reset} ${COLOR.dim}(${sensorType})${COLOR.reset}`);
       console.log(`├─ Current Value: ${COLOR.green}${value} ${unit}${COLOR.reset}`);
       console.log(`├─ First Seen: ${COLOR.dim}${created.toISOString()}${COLOR.reset}`);
       console.log(`└─ Last Update: ${COLOR.dim}${lastSeen.toISOString()}${COLOR.reset}`);
       console.log();
     });
   });
   
 } catch (err) {
   console.error(fmt.err(`Neo4j query failed: ${err.message}`));
   console.log(`${COLOR.dim}Common issues:${COLOR.reset}`);
   console.log(`  • Verify Neo4j container is running: ${COLOR.cyan}docker ps | grep neo4j${COLOR.reset}`);
   console.log(`  • Check database credentials and connection string`);
   console.log(`  • Ensure database schema constraints are initialized`);
   process.exit(1);
 }
}

/**
 * Query and display location entities with sensor statistics and type distribution.
 * Provides insights into sensor deployment across physical locations.
 * @returns {Promise<void>}
 */
async function runQueryLocations() {
  console.log(fmt.data("Analyzing location-based sensor distribution..."));
  
  if (!process.env.NEO4J_BOLT_EXTERNAL || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    console.error(fmt.err("Neo4j connection credentials required"));
    process.exit(1);
  }
  
  try {
    const neo4j = await import("neo4j-driver");
    const driver = neo4j.default.driver(
      process.env.NEO4J_BOLT_EXTERNAL,
      neo4j.default.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
      { disableLosslessIntegers: true }
    );
   
   const session = driver.session();
   const result = await session.run(`
     MATCH (location:Location)<-[:LOCATED_AT]-(sensor:Sensor)
     WITH location, 
          collect(sensor.id) as sensors,
          collect(DISTINCT sensor.type) as sensorTypes,
          count(sensor) as sensorCount
     RETURN location.name as locationName,
            location.totalSensors as totalSensors,
            location.sensorTypes as configuredTypes,
            sensors,
            sensorTypes,
            sensorCount,
            location.createdAt as created,
            location.lastUpdate as lastUpdate
     ORDER BY sensorCount DESC, location.name ASC
   `);
   
   await session.close();
   await driver.close();
   
   if (result.records.length === 0) {
     console.log(fmt.info("No locations found in database"));
     console.log(`${COLOR.dim}Locations are created automatically when sensors are deployed${COLOR.reset}`);
     console.log(`${COLOR.dim}Send sensor data to populate the location hierarchy${COLOR.reset}`);
     return;
   }
   
   console.log(fmt.ok(`Database contains ${COLOR.yellow}${result.records.length}${COLOR.reset} monitored locations:`));
   console.log();
   
   // Calculate overall statistics
   let totalSensors = 0;
   const allTypes = new Set();
   
   for (const record of result.records) {
     const sensorCount = record.get('sensorCount');
     const sensorTypes = record.get('sensorTypes');
     totalSensors += sensorCount;
     sensorTypes.forEach(type => allTypes.add(type));
   }
   
   console.log(`📊 ${COLOR.blue}Deployment Overview${COLOR.reset}`);
   console.log(`├─ Total Sensors: ${COLOR.yellow}${totalSensors}${COLOR.reset}`);
   console.log(`├─ Active Locations: ${COLOR.yellow}${result.records.length}${COLOR.reset}`);
   console.log(`└─ Sensor Types: ${COLOR.yellow}${Array.from(allTypes).join(', ')}${COLOR.reset}`);
   console.log();
   
   for (const record of result.records) {
     const locationName = record.get('locationName');
     const sensors = record.get('sensors');
     const sensorTypes = record.get('sensorTypes');
     const sensorCount = record.get('sensorCount');
     const created = new Date(record.get('created'));
     const lastUpdate = record.get('lastUpdate') ? new Date(record.get('lastUpdate')) : null;
     
     console.log(`🏠 ${COLOR.magenta}${locationName.toUpperCase()}${COLOR.reset}`);
     console.log(`┌─ Sensor Deployment`);
     console.log(`├─ Count: ${COLOR.green}${sensorCount}${COLOR.reset} sensors`);
     console.log(`├─ Types: ${COLOR.yellow}${sensorTypes.join(', ')}${COLOR.reset}`);
     console.log(`├─ Sensors: ${COLOR.cyan}${sensors.join(', ')}${COLOR.reset}`);
     console.log(`├─ Established: ${COLOR.dim}${created.toISOString()}${COLOR.reset}`);
     if (lastUpdate) {
       console.log(`└─ Last Activity: ${COLOR.dim}${lastUpdate.toISOString()}${COLOR.reset}`);
     } else {
       console.log(`└─ Last Activity: ${COLOR.dim}No recent updates${COLOR.reset}`);
     }
     console.log();
   }
   
 } catch (err) {
   console.error(fmt.err(`Location query failed: ${err.message}`));
   process.exit(1);
 }
}

/**
 * Query and display recent sensor readings with temporal analysis.
 * Shows the most recent data points captured by the ingestion pipeline.
 * @returns {Promise<void>}
 */
async function runQueryReadings() {
  console.log(fmt.data("Retrieving recent sensor readings from temporal store..."));
  
  if (!process.env.NEO4J_BOLT_EXTERNAL || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    console.error(fmt.err("Neo4j connection credentials required"));
    process.exit(1);
  }
  
  try {
    const neo4j = await import("neo4j-driver");
    const driver = neo4j.default.driver(
      process.env.NEO4J_BOLT_EXTERNAL,
      neo4j.default.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
      { disableLosslessIntegers: true }
    );
   
   const session = driver.session();
   const result = await session.run(`
     MATCH (reading:SensorReading)-[:FROM_SENSOR]->(sensor:Sensor)-[:LOCATED_AT]->(location:Location)
     RETURN reading.fingerprint as fingerprint,
            reading.value as value,
            reading.unit as unit,
            reading.toolRunId as toolRunId,
            sensor.id as sensorId,
            location.name as location,
            reading.timestamp as timestamp
     ORDER BY reading.timestamp DESC
     LIMIT 25
   `);
   
   await session.close();
   await driver.close();
   
   if (result.records.length === 0) {
     console.log(fmt.info("No sensor readings found in temporal store"));
     console.log(`${COLOR.dim}Readings are created when raw sensor data is processed${COLOR.reset}`);
     console.log(`${COLOR.dim}Send sensor data to populate the reading history${COLOR.reset}`);
     return;
   }
   
   console.log(fmt.ok(`Found ${COLOR.yellow}${result.records.length}${COLOR.reset} recent sensor readings (last 25):`));
   console.log();
   
   // Group readings by time periods for better analysis
   const now = Date.now();
   const readings = result.records.map(record => ({
     fingerprint: record.get('fingerprint'),
     value: record.get('value'),
     unit: record.get('unit'),
     sensorId: record.get('sensorId'),
     location: record.get('location'),
     toolRunId: record.get('toolRunId'),
     timestamp: new Date(record.get('timestamp')),
     ageMs: now - record.get('timestamp')
   }));
   
   readings.forEach((reading, index) => {
     const ageMinutes = Math.floor(reading.ageMs / (1000 * 60));
     const ageText = ageMinutes < 1 ? 'just now' : 
                    ageMinutes < 60 ? `${ageMinutes}m ago` : 
                    `${Math.floor(ageMinutes / 60)}h ${ageMinutes % 60}m ago`;
     
     console.log(`📈 ${COLOR.cyan}${reading.sensorId}${COLOR.reset} ${COLOR.dim}(${reading.location})${COLOR.reset}`);
     console.log(`┌─ Value: ${COLOR.green}${reading.value} ${reading.unit}${COLOR.reset}`);
     console.log(`├─ Recorded: ${COLOR.dim}${reading.timestamp.toISOString()}${COLOR.reset} (${ageText})`);
     console.log(`├─ Run ID: ${COLOR.dim}${reading.toolRunId}${COLOR.reset}`);
     console.log(`└─ Fingerprint: ${COLOR.dim}${reading.fingerprint.substring(0, 16)}...${COLOR.reset}`);
     
     if (index < readings.length - 1) console.log();
   });
   
 } catch (err) {
   console.error(fmt.err(`Readings query failed: ${err.message}`));
   process.exit(1);
 }
}

/**
 * Query and analyze sensor relationships including co-location and type-based connections.
 * Demonstrates the relationship graph created by the plugin architecture.
 * @returns {Promise<void>}
 */
async function runQueryRelationships() {
  console.log(fmt.data("Analyzing sensor relationship networks..."));
  
  if (!process.env.NEO4J_BOLT_EXTERNAL || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    console.error(fmt.err("Neo4j connection credentials required"));
    process.exit(1);
  }
  
  try {
    const neo4j = await import("neo4j-driver");
    const driver = neo4j.default.driver(
      process.env.NEO4J_BOLT_EXTERNAL,
      neo4j.default.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
      { disableLosslessIntegers: true }
    );
   
   const session = driver.session();
   
   // Query co-located sensors (proximity-based relationships)
   const colocatedResult = await session.run(`
     MATCH (s1:Sensor)-[r:CO_LOCATED]-(s2:Sensor)
     MATCH (s1)-[:LOCATED_AT]->(location:Location)
     WHERE s1.id < s2.id
     RETURN s1.id as sensor1, s2.id as sensor2, location.name as location,
            r.since as since, r.lastUpdate as lastUpdate
     ORDER BY location.name, s1.id
   `);
   
   // Query sensor type distribution
   const typeResult = await session.run(`
     MATCH (sensorType:SensorType)<-[:IS_TYPE]-(sensor:Sensor)
     WITH sensorType, collect(sensor.id) as sensors, count(sensor) as count
     RETURN sensorType.name as sensorType, sensors, count
     ORDER BY count DESC, sensorType.name
   `);
   
   // Query location connectivity matrix
   const connectivityResult = await session.run(`
     MATCH (location:Location)<-[:LOCATED_AT]-(sensor:Sensor)
     WITH location.name as locationName, count(sensor) as sensorCount
     RETURN locationName, sensorCount
     ORDER BY sensorCount DESC
   `);
   
   await session.close();
   await driver.close();
   
   console.log(fmt.ok("Sensor Relationship Analysis:"));
   console.log();
   
   // Display co-location networks
   if (colocatedResult.records.length > 0) {
     console.log(`🔗 ${COLOR.yellow}Co-location Networks${COLOR.reset}`);
     console.log(`${COLOR.dim}Sensors automatically discover proximity relationships${COLOR.reset}`);
     console.log();
     
     let currentLocation = null;
     let pairCount = 0;
     
     for (const record of colocatedResult.records) {
       const location = record.get('location');
       const sensor1 = record.get('sensor1');
       const sensor2 = record.get('sensor2');
       const since = new Date(record.get('since'));
       const lastUpdate = record.get('lastUpdate') ? new Date(record.get('lastUpdate')) : null;
       
       if (location !== currentLocation) {
         if (currentLocation !== null) console.log();
         currentLocation = location;
         console.log(`📍 ${COLOR.magenta}${location.toUpperCase()}${COLOR.reset}`);
         console.log(`${'─'.repeat(location.length + 4)}`);
       }
       
       pairCount++;
       const ageText = lastUpdate ? 
         `updated ${Math.floor((Date.now() - lastUpdate.getTime()) / (1000 * 60))}m ago` :
         `established ${Math.floor((Date.now() - since.getTime()) / (1000 * 60))}m ago`;
       
       console.log(`├─ ${COLOR.cyan}${sensor1}${COLOR.reset} ↔ ${COLOR.cyan}${sensor2}${COLOR.reset}`);
       console.log(`│  ${COLOR.dim}${ageText}${COLOR.reset}`);
     }
     
     console.log();
     console.log(`${COLOR.dim}Total co-location pairs: ${pairCount}${COLOR.reset}`);
     console.log();
   }
   
   // Display type-based classification
   if (typeResult.records.length > 0) {
     console.log(`🏷️  ${COLOR.yellow}Sensor Type Classification${COLOR.reset}`);
     console.log(`${COLOR.dim}Automatic categorization based on sensor identifiers${COLOR.reset}`);
     console.log();
     
     let totalSensors = 0;
     for (const record of typeResult.records) {
       const sensorType = record.get('sensorType');
       const sensors = record.get('sensors');
       const count = record.get('count');
       totalSensors += count;
       
       console.log(`┌─ ${COLOR.green}${sensorType.toUpperCase()}${COLOR.reset} ${COLOR.dim}(${count} sensors)${COLOR.reset}`);
       
       // Show sensors in rows of 3 for better readability
       const chunks = [];
       for (let i = 0; i < sensors.length; i += 3) {
         chunks.push(sensors.slice(i, i + 3));
       }
       
       chunks.forEach((chunk, index) => {
         const isLast = index === chunks.length - 1;
         const prefix = isLast ? '└─' : '├─';
         console.log(`${prefix} ${COLOR.cyan}${chunk.join(', ')}${COLOR.reset}`);
       });
       
       console.log();
     }
     
     console.log(`${COLOR.dim}Total classified sensors: ${totalSensors}${COLOR.reset}`);
   }
   
   // Display connectivity summary
   if (connectivityResult.records.length > 0) {
     console.log(`🌐 ${COLOR.yellow}Location Connectivity Matrix${COLOR.reset}`);
     console.log();
     
     connectivityResult.records.forEach(record => {
       const locationName = record.get('locationName');
       const sensorCount = record.get('sensorCount');
       const connectionPotential = sensorCount * (sensorCount - 1) / 2; // Max possible pairs
       
       console.log(`├─ ${COLOR.magenta}${locationName}${COLOR.reset}: ${COLOR.yellow}${sensorCount}${COLOR.reset} sensors`);
       console.log(`│  ${COLOR.dim}Potential connections: ${connectionPotential}${COLOR.reset}`);
     });
   }
   
   if (colocatedResult.records.length === 0 && typeResult.records.length === 0) {
     console.log(fmt.info("No sensor relationships found"));
     console.log(`${COLOR.dim}Relationships are created automatically when:${COLOR.reset}`);
     console.log(`  • Multiple sensors are deployed to the same location`);
     console.log(`  • Sensors are classified by type based on their identifiers`);
     console.log();
     console.log(`${COLOR.dim}Send multiple sensors to create a relationship network:${COLOR.reset}`);
     console.log(`  ${COLOR.green}--send --sensor temp-office-01 --value 22 --unit celsius --location office${COLOR.reset}`);
     console.log(`  ${COLOR.green}--send --sensor humidity-office-01 --value 45 --unit percent --location office${COLOR.reset}`);
   }
   
 } catch (err) {
   console.error(fmt.err(`Relationship analysis failed: ${err.message}`));
   process.exit(1);
 }
}

// ---------------------------------------------------------------------------
// CONFIGURATION AND MANAGEMENT FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Verify plugin configuration files and validate the complete plugin architecture.
 * Checks normalizer/upserter registration and file structure integrity.
 * @returns {Promise<void>}
 */
async function runVerifyConfig() {
  console.log(fmt.test("Validating plugin configuration and architecture..."));
  
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const configPath = path.resolve(__dirname, "../ingestion/src/config/plugins.yaml");
    
    // Check plugins.yaml exists and is readable
    if (!existsSync(configPath)) {
      console.error(fmt.err(`Plugin configuration not found`));
      console.error(`${COLOR.dim}Expected location: ${configPath}${COLOR.reset}`);
      console.error(`${COLOR.dim}Ensure the ingestion service is properly configured${COLOR.reset}`);
      return;
    }
   
   const configContent = readFileSync(configPath, "utf8");
   console.log(fmt.ok("Plugin configuration file found and readable"));
   
   // Validate plugin registration
   const hasNormalizer = configContent.includes("sensor_report");
   const hasUpserter = configContent.includes("SENSOR_READING");
   
   if (!hasNormalizer || !hasUpserter) {
     console.error(fmt.err("Example plugin not properly registered"));
     console.error(`${COLOR.dim}Required registrations:${COLOR.reset}`);
     console.error(`  • Normalizer: ${COLOR.cyan}sensor_report${COLOR.reset} → plugins/example/normalizer`);
     console.error(`  • Upserter: ${COLOR.cyan}SENSOR_READING${COLOR.reset} → plugins/example/upserter`);
     console.error(`${COLOR.dim}Check plugins.yaml configuration syntax${COLOR.reset}`);
     return;
   }
   
   console.log(fmt.ok("Plugin registration validated"));
   console.log(`┌─ Configuration Details`);
   console.log(`├─ Normalizer: ${COLOR.cyan}sensor_report${COLOR.reset} → plugins/example/normalizer`);
   console.log(`└─ Upserter: ${COLOR.cyan}SENSOR_READING${COLOR.reset} → plugins/example/upserter`);
   console.log();
   
   // Check implementation files exist
   const normalizerPath = path.resolve(__dirname, "../ingestion/src/plugins/example/normalizer.ts");
   const upserterPath = path.resolve(__dirname, "../ingestion/src/plugins/example/upserter.ts");
   const rawSchemaPath = path.resolve(__dirname, "../ingestion/src/plugins/example/raw-schema.json");
   const domainSchemaPath = path.resolve(__dirname, "../ingestion/src/plugins/example/domain-schema.json");
   
   const files = [
     { name: "Normalizer", path: normalizerPath, required: true },
     { name: "Upserter", path: upserterPath, required: true },
     { name: "Raw Schema", path: rawSchemaPath, required: true },
     { name: "Domain Schema", path: domainSchemaPath, required: true }
   ];
   
   let allFilesExist = true;
   console.log(`📁 ${COLOR.blue}Plugin File Structure${COLOR.reset}`);
   
   files.forEach(file => {
     const exists = existsSync(file.path);
     const status = exists ? fmt.ok("Found") : fmt.err("Missing");
     console.log(`├─ ${file.name}: ${status}`);
     
     if (!exists && file.required) {
       allFilesExist = false;
     }
   });
   
   console.log();
   
   if (allFilesExist) {
     console.log(fmt.ok("All plugin implementation files verified"));
     console.log(`${COLOR.dim}Plugin architecture is ready for testing${COLOR.reset}`);
   } else {
     console.log(fmt.warn("Some plugin files are missing"));
     console.log(`${COLOR.dim}Ensure all required files are present before testing${COLOR.reset}`);
   }
   
 } catch (err) {
   console.error(fmt.err(`Configuration verification failed: ${err.message}`));
   console.log(`${COLOR.dim}Check file permissions and plugin directory structure${COLOR.reset}`);
 }
}

/**
 * Clean up all test data from Neo4j database with comprehensive reporting.
 * Removes sensors, locations, readings, and relationships in proper dependency order.
 * @returns {Promise<void>}
 */
async function runCleanup() {
  console.log(fmt.warn("Cleaning up test data from Neo4j database..."));
  
  if (!process.env.NEO4J_BOLT_EXTERNAL || !process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    console.error(fmt.err("Neo4j connection credentials required"));
    process.exit(1);
  }
  
  try {
    const neo4j = await import("neo4j-driver");
    const driver = neo4j.default.driver(
      process.env.NEO4J_BOLT_EXTERNAL,
      neo4j.default.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
      { disableLosslessIntegers: true }
    );
   
   const session = driver.session();
   
   console.log(`${COLOR.dim}Removing entities in dependency order...${COLOR.reset}`);
   
   // Delete relationships first (Neo4j constraint requirement)
   console.log("🔗 Removing relationships...");
   const relationshipsResult = await session.run(`
     MATCH ()-[r]->()
     WHERE type(r) IN ['FROM_SENSOR', 'LOCATED_AT', 'IS_TYPE', 'CO_LOCATED']
     DELETE r 
     RETURN count(r) as deleted
   `);
   
   // Delete nodes in dependency order
   console.log("📈 Removing sensor readings...");
   const readingsResult = await session.run(`
     MATCH (r:SensorReading) 
     DELETE r 
     RETURN count(r) as deleted
   `);
   
   console.log("📡 Removing sensors...");
   const sensorsResult = await session.run(`
     MATCH (s:Sensor) 
     DELETE s 
     RETURN count(s) as deleted
   `);
   
   console.log("📍 Removing locations...");
   const locationsResult = await session.run(`
     MATCH (l:Location) 
     DELETE l 
     RETURN count(l) as deleted
   `);
   
   console.log("🏷️  Removing sensor types...");
   const typesResult = await session.run(`
     MATCH (st:SensorType) 
     DELETE st 
     RETURN count(st) as deleted
   `);
   
   await session.close();
   await driver.close();
   
   // Comprehensive cleanup reporting
   const relationshipsDeleted = relationshipsResult.records[0]?.get('deleted') || 0;
   const readingsDeleted = readingsResult.records[0]?.get('deleted') || 0;
   const sensorsDeleted = sensorsResult.records[0]?.get('deleted') || 0;
   const locationsDeleted = locationsResult.records[0]?.get('deleted') || 0;
   const typesDeleted = typesResult.records[0]?.get('deleted') || 0;
   
   const totalDeleted = relationshipsDeleted + readingsDeleted + sensorsDeleted + locationsDeleted + typesDeleted;
   
   console.log();
   console.log(fmt.ok("Database cleanup completed successfully"));
   console.log(`┌─ Cleanup Summary`);
   console.log(`├─ Relationships: ${COLOR.yellow}${relationshipsDeleted}${COLOR.reset} removed`);
   console.log(`├─ Sensor Readings: ${COLOR.yellow}${readingsDeleted}${COLOR.reset} removed`);
   console.log(`├─ Sensors: ${COLOR.yellow}${sensorsDeleted}${COLOR.reset} removed`);
   console.log(`├─ Locations: ${COLOR.yellow}${locationsDeleted}${COLOR.reset} removed`);
   console.log(`├─ Sensor Types: ${COLOR.yellow}${typesDeleted}${COLOR.reset} removed`);
   console.log(`└─ Total Objects: ${COLOR.green}${totalDeleted}${COLOR.reset} removed`);
   
   if (totalDeleted > 0) {
     console.log();
     console.log(`${COLOR.dim}Database is now clean and ready for fresh testing${COLOR.reset}`);
   } else {
     console.log();
     console.log(`${COLOR.dim}Database was already clean${COLOR.reset}`);
   }
   
 } catch (err) {
   console.error(fmt.err(`Cleanup operation failed: ${err.message}`));
   console.log(`${COLOR.dim}Common issues:${COLOR.reset}`);
   console.log(`  • Check Neo4j container status and connectivity`);
   console.log(`  • Verify database credentials and permissions`);
   console.log(`  • Ensure no active transactions are blocking deletion`);
   process.exit(1);
 }
}

// ---------------------------------------------------------------------------
// MAIN EXECUTION COORDINATOR
// ---------------------------------------------------------------------------

/**
 * Main execution coordinator that orchestrates all plugin testing operations.
 * Handles command validation, operation sequencing, and error recovery.
 * @returns {Promise<void>}
 */
(async () => {
  const startTime = Date.now();
  
  try {
    // Pre-flight validation
    if (flags.send && (!flags.sensor || typeof flags.value !== 'number' || !flags.unit || !flags.location)) {
      console.error(fmt.err("Invalid send command parameters"));
      console.error(`${COLOR.dim}Required parameters:${COLOR.reset}`);
      console.error(`  • --sensor <id>     (e.g., temp-kitchen-01)`);
      console.error(`  • --value <number>  (e.g., 22.5)`);
      console.error(`  • --unit <string>   (e.g., celsius)`);
      console.error(`  • --location <name> (e.g., kitchen)`);
      console.log();
      console.log(`${COLOR.dim}Example:${COLOR.reset} ${COLOR.green}--send --sensor temp-01 --value 23.5 --unit celsius --location kitchen${COLOR.reset}`);
      process.exit(1);
    }
    
    // Execute operations in logical sequence
    let operationsCount = 0;
    
    // Data generation and transmission
    if (flags.test) {
      const rawData = generateSampleRawData();
      await sendToKafka(rawData);
      operationsCount++;
    }
    
    if (flags.send) {
      try {
        const rawData = createCustomRawData(flags.sensor, flags.value, flags.unit, flags.location);
        await sendToKafka(rawData);
        operationsCount++;
      } catch (error) {
        console.error(fmt.err(`Failed to create sensor data: ${error.message}`));
        process.exit(1);
      }
    }
    
    // Add processing delay if data was sent
    if (operationsCount > 0) {
      console.log(`${COLOR.dim}Allowing time for pipeline processing...${COLOR.reset}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Data analysis and verification
    if (flags.querySensors) {
      await runQuerySensors();
      operationsCount++;
    }
    
    if (flags.queryLocations) {
      if (operationsCount > 0) console.log(); // Spacing between operations
      await runQueryLocations();
      operationsCount++;
    }
    
    if (flags.queryReadings) {
      if (operationsCount > 0) console.log();
      await runQueryReadings();
      operationsCount++;
    }
    
    if (flags.queryRelationships) {
      if (operationsCount > 0) console.log();
      await runQueryRelationships();
      operationsCount++;
    }
    
    // Configuration and maintenance
    if (flags.verifyConfig) {
      if (operationsCount > 0) console.log();
      await runVerifyConfig();
      operationsCount++;
    }
    
    if (flags.cleanup) {
      if (operationsCount > 0) console.log();
      await runCleanup();
      operationsCount++;
    }
    
    // Operation summary
    if (operationsCount > 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log();
      console.log(fmt.ok(`Plugin testing completed successfully`));
      console.log(`${COLOR.dim}Executed ${operationsCount} operations in ${elapsed}s${COLOR.reset}`);
      
      // Helpful next steps
      if (flags.test || flags.send) {
        console.log();
        console.log(`${COLOR.dim}Next steps:${COLOR.reset}`);
        console.log(`  • Query results: ${COLOR.green}--query-sensors --query-locations${COLOR.reset}`);
        console.log(`  • Analyze relationships: ${COLOR.green}--query-relationships${COLOR.reset}`);
        console.log(`  • Clean up: ${COLOR.green}--cleanup${COLOR.reset}`);
      }
    }
    
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error();
    console.error(fmt.err(`Plugin testing failed after ${elapsed}s`));
    console.error(`${COLOR.dim}Error details: ${err.message}${COLOR.reset}`);
    
    if (flags.verbose && err.stack) {
      console.error(`${COLOR.dim}Stack trace:${COLOR.reset}`);
      console.error(err.stack.split('\n').map(line => `  ${COLOR.dim}${line}${COLOR.reset}`).join('\n'));
    }
    
    console.error();
    console.error(`${COLOR.dim}Common troubleshooting steps:${COLOR.reset}`);
    console.error(`  • Verify all containers are running: ${COLOR.cyan}docker ps${COLOR.reset}`);
    console.error(`  • Check environment variables in .env file`);
    console.error(`  • Validate plugin configuration: ${COLOR.green}--verify-config${COLOR.reset}`);
    console.error(`  • Review ingestion service logs for processing errors`);
    
    process.exit(1);
  }
})(); 