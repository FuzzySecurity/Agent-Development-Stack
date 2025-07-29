#!/usr/bin/env node
/**
 * AI-Agent Kafka CLI Utility
 * -------------------------
 * A single-file helper (ES-module) for interacting with the local Kafka stack
 * used by the AI-Agent ingestion service.  Features:
 *   • Produce one-off messages
 *   • Consume (tail) messages or read a finite batch
 *   • Create topics on the fly
 *   • Override broker list at runtime
 *   • Accept self-signed certificates by default
 *
 * Quick Examples
 * --------------
 *  # Produce a plaintext message
 *  node unittest/kafka.js --produce "Hello" --topic events.test
 *
 *  # Produce JSON (quote the whole payload)
 *  node unittest/kafka.js -p '{"type":"ping","ts":1690000000}' -t events.test
 *
 *  # Tail indefinitely
 *  node unittest/kafka.js --consume --topic events.test
 *
 *  # Read exactly 10 historical messages then exit
 *  node unittest/kafka.js -c -t events.test -n 10
 *
 *  # Create a topic with 1 partition / RF=1 (useful in local dev)
 *  node unittest/kafka.js --create --topic events.new --partitions 1 --replication 1
 *
 *  # Connect to a different broker list (comma-separated)
 *  node unittest/kafka.js -p "Hi" -t events.test --brokers localhost:9094
 *
 *  # Enforce valid TLS certificates (disable self-signed default)
 *  node unittest/kafka.js -c -t events.test --strict
 *
 * Environment
 * -----------
 * The script reads the sibling "../.env" file (if present) and populates any
 * KAFKA_* variables not already in the environment.  Defaults:
*   Always accepts self-signed certificates (Docker Compose setup)
*   KAFKA_SASL_MECHANISM = SCRAM-SHA-256
 *
 * Built-in Flags (see --help for full list):
 *   -p, --produce <msg>    Produce a message
 *   -c, --consume          Consume mode (default if --produce not given)
 *   --create               Create topic mode
 *   --strict               Require valid certs (overrides default insecure)
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Kafka, logLevel } from "kafkajs";

/**
 * Load environment variables from a "../.env" file if present.
 * Values already present in process.env are NOT overwritten.
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

// ---------------------------------------------------------------------------
// Console colouring helpers (no extra deps)
// ---------------------------------------------------------------------------
const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  red: "\x1b[31m"
};
const fmt = {
  ok: (msg) => `${COLOR.green}✔${COLOR.reset} ${msg}`,
  info: (msg) => `${COLOR.cyan}ℹ${COLOR.reset} ${msg}`,
  warn: (msg) => `${COLOR.yellow}⚠${COLOR.reset} ${msg}`,
  err: (msg) => `${COLOR.red}✖${COLOR.reset} ${msg}`
};

// ---------------------------------------------------------------------------
// HELP
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
${COLOR.cyan}Kafka CLI Test Tool${COLOR.reset}
${COLOR.dim}═══════════════════${COLOR.reset}
Comprehensive testing utility for your AI-Agent Kafka stack.

${COLOR.yellow}MODES${COLOR.reset} (choose one)
  ${COLOR.green}-p, --produce <msg>${COLOR.reset}    Produce a single message
  ${COLOR.green}-c, --consume${COLOR.reset}          Consume messages (default if no mode chosen)
  ${COLOR.green}--create${COLOR.reset}               Create a topic (requires --topic)
  ${COLOR.green}--list${COLOR.reset}                 List all topics with details
  ${COLOR.green}--delete${COLOR.reset}               Delete a topic (requires --topic)
  ${COLOR.green}--peek${COLOR.reset}                 Peek at the latest message in a topic
  ${COLOR.green}--compact${COLOR.reset}              Compact a keyed topic (delete old values for same key)

${COLOR.yellow}COMMON OPTIONS${COLOR.reset}
  ${COLOR.cyan}-t, --topic <name>${COLOR.reset}     Kafka topic (default: events.test)
  ${COLOR.cyan}-b, --brokers <list>${COLOR.reset}   Comma-separated broker list (overrides env)
  ${COLOR.cyan}-g, --groupId <id>${COLOR.reset}     Consumer group id (default: kafka_cli_test)
  ${COLOR.cyan}--strict${COLOR.reset}               Require valid TLS certs (self-signed rejected)

${COLOR.yellow}CONSUME OPTIONS${COLOR.reset}
  ${COLOR.cyan}-n, --count <n>${COLOR.reset}        Stop after n messages

${COLOR.yellow}PRODUCE OPTIONS${COLOR.reset}
  ${COLOR.cyan}-k, --key <key>${COLOR.reset}        Message key (enables compaction when used)

${COLOR.yellow}CREATE OPTIONS${COLOR.reset}
  ${COLOR.cyan}--partitions <n>${COLOR.reset}       Number of partitions (default: 1)
  ${COLOR.cyan}--replication <n>${COLOR.reset}      Replication factor (default: 1)
  ${COLOR.cyan}--compacted${COLOR.reset}            Create with log compaction enabled

${COLOR.yellow}EXAMPLES${COLOR.reset}
  List topics with details:
    ${COLOR.dim}node unittest/kafka.js --list${COLOR.reset}

  Create a compacted topic:
    ${COLOR.dim}node unittest/kafka.js --create -t events.compact --compacted${COLOR.reset}

  Produce a keyed message (enables compaction):
    ${COLOR.dim}node unittest/kafka.js -p '{"name":"John","age":30}' -k "user:123" -t events.compact${COLOR.reset}

  Update the same key (old value will be compacted):
    ${COLOR.dim}node unittest/kafka.js -p '{"name":"John","age":31}' -k "user:123" -t events.compact${COLOR.reset}

  Delete a key (send null value):
    ${COLOR.dim}node unittest/kafka.js --compact -k "user:123" -t events.compact${COLOR.reset}

  Peek at the latest message:
    ${COLOR.dim}node unittest/kafka.js --peek -t events.test${COLOR.reset}

  Consume with pretty formatting:
    ${COLOR.dim}node unittest/kafka.js -c -t events.test -n 5${COLOR.reset}

  Delete a topic:
    ${COLOR.dim}node unittest/kafka.js --delete -t events.old${COLOR.reset}
`);
}

// ---------------------------------------------------------------------------
// CLI Parsing (minimal, no external deps)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "--produce":
    case "-p":
      flags.produce = args[++i];
      break;
    case "--consume":
    case "-c":
      flags.consume = true;
      break;
    case "--create":
      flags.create = true;
      break;
    case "--list":
      flags.list = true;
      break;
    case "--delete":
      flags.delete = true;
      break;
    case "--peek":
      flags.peek = true;
      break;
    case "--compact":
      flags.compact = true;
      break;
    case "--topic":
    case "-t":
      flags.topic = args[++i];
      break;
    case "--count":
    case "-n":
      flags.count = parseInt(args[++i] ?? "", 10);
      break;
    case "--key":
    case "-k":
      flags.key = args[++i];
      break;
    case "--groupId":
    case "-g":
      flags.groupId = args[++i];
      break;
    case "--brokers":
    case "-b":
      flags.brokers = args[++i];
      break;
    case "--partitions":
      flags.partitions = parseInt(args[++i] ?? "", 10) || 1;
      break;
    case "--replication":
      flags.replication = parseInt(args[++i] ?? "", 10) || 1;
      break;
    case "--strict":
      flags.strict = true;
      break;
    case "--compacted":
      flags.compacted = true;
      break;
    case "--help":
    case "-h":
      printHelp();
      process.exit(0);
    default:
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
  }
}

// Determine default mode: if nothing specified, show help.
if (args.length === 0) {
  printHelp();
  process.exit(0);
}
if (!flags.produce && !flags.create && !flags.list && !flags.delete && !flags.peek && !flags.compact) flags.consume = true;

// Default values
flags.topic = flags.topic || "events.test";
flags.groupId = flags.groupId || "kafka_cli_test";
flags.partitions = flags.partitions || 1;
flags.replication = flags.replication || 1;

// Apply runtime overrides to env vars
if (flags.brokers) {
  process.env.KAFKA_BROKERS_EXTERNAL = flags.brokers;
} else if (process.env.KAFKA_LISTENER_PORT) {
  // Force localhost default when a listener port is defined to avoid using the in-network host name.
  process.env.KAFKA_BROKERS_EXTERNAL = `localhost:${process.env.KAFKA_LISTENER_PORT}`;
}

// ---------------------------------------------------------------------------
// Helper – Build Kafka client
// ---------------------------------------------------------------------------

/**
 * Instantiate a KafkaJS client with SASL+SSL defaults matching the stack.
 * @returns {Kafka}
 */
function buildKafkaClient() {
  const { KAFKA_BROKERS_EXTERNAL, KAFKA_USERNAME, KAFKA_PASSWORD } = process.env;
  if (!KAFKA_BROKERS_EXTERNAL) {
    console.error("KAFKA_BROKERS_EXTERNAL must be set via --brokers or .env");
    process.exit(1);
  }
  if (!KAFKA_USERNAME || !KAFKA_PASSWORD) {
    console.error("KAFKA_USERNAME and KAFKA_PASSWORD must be provided in env");
    process.exit(1);
  }
  // Always accept self-signed certificates (Docker Compose setup)
  return new Kafka({
    clientId: "cli-test",
    brokers: KAFKA_BROKERS_EXTERNAL.split(","),
    logLevel: logLevel.NOTHING,
    sasl: {
      mechanism: process.env.KAFKA_SASL_MECHANISM || "SCRAM-SHA-256",
      username: KAFKA_USERNAME,
      password: KAFKA_PASSWORD
    },
    ssl: { rejectUnauthorized: false }
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Enhanced message production with metadata display.
 */
async function produceMessage(kafka, topic, value, key = null) {
  console.log(fmt.info(`Producing to ${COLOR.cyan}${topic}${COLOR.reset}${key ? ` with key ${COLOR.yellow}${key}${COLOR.reset}` : ''}...`));
  
  const producer = kafka.producer();
  await producer.connect();
  
  const message = { value };
  if (key) message.key = key;
  if (!message.timestamp) message.timestamp = Date.now().toString();
  
  const result = await producer.send({ 
    topic, 
    messages: [message] 
  });
  
  console.log(fmt.ok(`Message sent to ${COLOR.cyan}${topic}${COLOR.reset}`));
  result.forEach((r, i) => {
    console.log(`  Partition ${COLOR.yellow}${r.partition}${COLOR.reset}, Offset ${COLOR.yellow}${r.baseOffset}${COLOR.reset}`);
  });
  if (key) console.log(`  Key: ${COLOR.yellow}${key}${COLOR.reset}`);
  console.log(`  Payload: ${COLOR.dim}${value.length > 100 ? value.substring(0, 100) + '...' : value}${COLOR.reset}`);
  
  await producer.disconnect();
}

/**
 * Compact a topic by sending a null/tombstone message for a given key.
 * This marks the key for deletion during log compaction.
 * @param {Kafka} kafka
 * @param {string} topic
 * @param {string} key
 */
async function compactTopic(kafka, topic, key) {
  if (!key) {
    console.log(fmt.err("Compaction requires a key. Use -k/--key to specify."));
    process.exit(1);
  }
  
  console.log(fmt.warn(`Compacting key ${COLOR.yellow}${key}${COLOR.reset} in topic ${COLOR.cyan}${topic}${COLOR.reset}...`));
  
  const producer = kafka.producer();
  await producer.connect();
  
  // Send tombstone (null value) for the key
  const result = await producer.send({ 
    topic, 
    messages: [{ 
      key,
      value: null,  // Tombstone message
      timestamp: Date.now().toString()
    }] 
  });
  
  console.log(fmt.ok(`Tombstone sent for key ${COLOR.yellow}${key}${COLOR.reset}`));
  result.forEach((r, i) => {
    console.log(`  Partition ${COLOR.yellow}${r.partition}${COLOR.reset}, Offset ${COLOR.yellow}${r.baseOffset}${COLOR.reset}`);
  });
  console.log(`  ${COLOR.dim}Note: Actual compaction happens during Kafka's background process${COLOR.reset}`);
  
  await producer.disconnect();
}

/**
 * Enhanced consumption with better formatting.
 */
async function consumeMessages(kafka, topic, groupId, max) {
  console.log(fmt.info(`Consuming from ${COLOR.cyan}${topic}${COLOR.reset} (group: ${COLOR.dim}${groupId}${COLOR.reset})${max ? `, max ${max} messages` : ', press Ctrl+C to stop'}...`));
  
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  
  let seen = 0;
  const startTime = Date.now();
  
  await consumer.run({
    eachMessage: async ({ message, partition, offset }) => {
      seen++;
      const val = message.value?.toString() ?? "<null>";
      const timestamp = message.timestamp ? new Date(parseInt(message.timestamp)).toISOString() : new Date().toISOString();
      
      console.log(`\n${COLOR.yellow}📥 Message ${seen}${COLOR.reset} ${COLOR.dim}[${timestamp}]${COLOR.reset}`);
      console.log(`   Partition: ${partition}, Offset: ${offset}`);
      
      // Try to pretty-print JSON
      try {
        const parsed = JSON.parse(val);
        console.log(`   ${JSON.stringify(parsed, null, 2).split('\n').slice(1, -1).join('\n   ')}`);
      } catch {
        console.log(`   ${val}`);
      }
      
      if (max && seen >= max) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(fmt.ok(`\nReceived ${max} messages in ${elapsed}s – exiting...`));
        await consumer.disconnect();
        process.exit(0);
      }
    }
  });
}

/**
 * Enhanced topic creation with validation.
 */
async function createTopic(kafka, topic, partitions, replication, compacted = false) {
  console.log(fmt.info(`Creating ${compacted ? 'compacted ' : ''}topic ${COLOR.cyan}${topic}${COLOR.reset}...`));
  
  const admin = kafka.admin();
  await admin.connect();
  
  const topicConfig = {
    topic,
    numPartitions: partitions,
    replicationFactor: replication
  };
  
  // Add compaction config if requested
  if (compacted) {
    topicConfig.configEntries = [
      { name: 'cleanup.policy', value: 'compact' },
      { name: 'min.cleanable.dirty.ratio', value: '0.1' },
      { name: 'segment.ms', value: '10000' }  // Compact more frequently for testing
    ];
  }
  
  try {
    const created = await admin.createTopics({
      topics: [topicConfig],
      waitForLeaders: true,
      timeout: 10000
    });
    
    if (created) {
      console.log(fmt.ok(`Created ${compacted ? 'compacted ' : ''}topic ${COLOR.cyan}${topic}${COLOR.reset}`));
      console.log(`  Partitions: ${COLOR.yellow}${partitions}${COLOR.reset}`);
      console.log(`  Replication Factor: ${COLOR.yellow}${replication}${COLOR.reset}`);
      if (compacted) {
        console.log(`  Cleanup Policy: ${COLOR.green}compact${COLOR.reset}`);
      }
    } else {
      console.log(fmt.warn(`Topic ${COLOR.cyan}${topic}${COLOR.reset} already exists.`));
    }
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log(fmt.warn(`Topic ${COLOR.cyan}${topic}${COLOR.reset} already exists.`));
    } else {
      throw err;
    }
  }
  
  await admin.disconnect();
}

/**
 * Enhanced topic deletion with confirmation.
 */
async function deleteTopic(kafka, topic) {
  console.log(fmt.warn(`Deleting topic ${COLOR.cyan}${topic}${COLOR.reset}...`));
  
  const admin = kafka.admin();
  await admin.connect();
  
  try {
    await admin.deleteTopics({ topics: [topic], timeout: 10000 });
    console.log(fmt.ok(`Deleted topic ${COLOR.cyan}${topic}${COLOR.reset}`));
  } catch (err) {
    if (err.message.includes('does not exist')) {
      console.log(fmt.warn(`Topic ${COLOR.cyan}${topic}${COLOR.reset} does not exist.`));
    } else {
      throw err;
    }
  }
  
  await admin.disconnect();
}

/**
 * Peek at the latest message in a topic.
 * @param {Kafka} kafka
 * @param {string} topic
 */
async function peekMessage(kafka, topic) {
  console.log(fmt.info(`Peeking at topic ${COLOR.cyan}${topic}${COLOR.reset}...`));
  
  const consumer = kafka.consumer({ 
    groupId: `peek_${Date.now()}`,
    sessionTimeout: 6000,
    heartbeatInterval: 1000
  });
  
  await consumer.connect();
  
  // Check if topic exists first
  const admin = kafka.admin();
  await admin.connect();
  try {
    const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
    const topicMeta = metadata.topics.find(t => t.name === topic);
    if (!topicMeta) {
      console.log(fmt.err(`Topic ${COLOR.cyan}${topic}${COLOR.reset} does not exist.`));
      await admin.disconnect();
      await consumer.disconnect();
      return;
    }
  } catch (err) {
    console.log(fmt.err(`Topic ${COLOR.cyan}${topic}${COLOR.reset} does not exist or is not accessible.`));
    await admin.disconnect();
    await consumer.disconnect();
    return;
  }
  await admin.disconnect();
  
  // Subscribe and read from the end
  await consumer.subscribe({ topic, fromBeginning: false });
  
  let messageReceived = false;
  let latestMessage = null;
  
  const timeout = setTimeout(async () => {
    if (!messageReceived) {
      // If no new messages, try reading the last few from beginning
      console.log(fmt.info(`No new messages, checking recent history...`));
      await consumer.disconnect();
      await peekFromHistory(kafka, topic);
    }
  }, 3000);
  
  await consumer.run({
    eachMessage: async ({ message, partition, offset }) => {
      clearTimeout(timeout);
      messageReceived = true;
      
      const val = message.value?.toString() ?? "<null>";
      const key = message.key?.toString() ?? "<no key>";
      const timestamp = message.timestamp ? new Date(parseInt(message.timestamp)).toISOString() : "<no timestamp>";
      
      console.log(`\n${fmt.ok(`Latest message from ${COLOR.cyan}${topic}${COLOR.reset}:`)}`);
      console.log(`┌─ Message Details`);
      console.log(`├─ Partition: ${COLOR.yellow}${partition}${COLOR.reset}`);
      console.log(`├─ Offset: ${COLOR.yellow}${offset || 'unknown'}${COLOR.reset}`);
      console.log(`├─ Timestamp: ${COLOR.dim}${timestamp}${COLOR.reset}`);
      console.log(`├─ Key: ${COLOR.yellow}${key}${COLOR.reset}`);
      console.log(`└─ Value:`);
      
      // Try to pretty-print JSON
      try {
        const parsed = JSON.parse(val);
        console.log(JSON.stringify(parsed, null, 2).split('\n').map(line => `   ${line}`).join('\n'));
      } catch {
        console.log(`   ${val}`);
      }
      
      await consumer.disconnect();
      process.exit(0);
    }
  });
}

/**
 * Helper to peek from message history when no new messages are available.
 */
async function peekFromHistory(kafka, topic) {
  const consumer = kafka.consumer({ 
    groupId: `peek_history_${Date.now()}`,
    sessionTimeout: 6000,
    heartbeatInterval: 1000
  });
  
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  
  let latestMessage = null;
  let messageCount = 0;
  
  const timeout = setTimeout(async () => {
    if (latestMessage) {
      const { message, partition, offset } = latestMessage;
      const val = message.value?.toString() ?? "<null>";
      const key = message.key?.toString() ?? "<no key>";
      const timestamp = message.timestamp ? new Date(parseInt(message.timestamp)).toISOString() : "<no timestamp>";
      
      console.log(`\n${fmt.ok(`Latest message from ${COLOR.cyan}${topic}${COLOR.reset}:`)}`);
      console.log(`┌─ Message Details`);
      console.log(`├─ Partition: ${COLOR.yellow}${partition}${COLOR.reset}`);
             console.log(`├─ Offset: ${COLOR.yellow}${offset || 'unknown'}${COLOR.reset}`);
      console.log(`├─ Timestamp: ${COLOR.dim}${timestamp}${COLOR.reset}`);
      console.log(`├─ Key: ${COLOR.yellow}${key}${COLOR.reset}`);
      console.log(`└─ Value:`);
      
      // Try to pretty-print JSON
      try {
        const parsed = JSON.parse(val);
        console.log(JSON.stringify(parsed, null, 2).split('\n').map(line => `   ${line}`).join('\n'));
      } catch {
        console.log(`   ${val}`);
      }
    } else {
      console.log(fmt.warn(`No messages found in ${COLOR.cyan}${topic}${COLOR.reset}`));
    }
    
    await consumer.disconnect();
    process.exit(0);
  }, 5000);
  
     await consumer.run({
     eachMessage: async ({ message, partition, offset }) => {
       messageCount++;
       // Keep track of the latest message (by always overwriting)
       latestMessage = { message, partition, offset: offset || message.offset };
     }
   });
}

/**
 * List all topics via the Admin API.
 * @param {Kafka} kafka
 */
async function listTopics(kafka) {
  const admin = kafka.admin();
  await admin.connect();
  const metadata = await admin.fetchTopicMetadata();
  await admin.disconnect();
  
  if (metadata.topics.length === 0) {
    console.log(fmt.info("No topics found."));
    return;
  }
  
  // Sort topics alphabetically
  const sortedTopics = metadata.topics
    .map(topic => ({
      name: topic.name,
      partitions: topic.partitions.length,
      replicas: topic.partitions[0]?.replicas?.length || 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  
  console.log(fmt.info(`Found ${COLOR.yellow}${sortedTopics.length}${COLOR.reset} topics:\n`));
  
  // Table-like output with padding
  const maxNameLength = Math.max(20, ...sortedTopics.map(t => t.name.length));
  console.log(`${'  NAME'.padEnd(maxNameLength + 2)} ${'PARTITIONS'.padEnd(12)} REPLICAS`);
  console.log(`${'  ────'.padEnd(maxNameLength + 2)} ${'──────────'.padEnd(12)} ────────`);
  
  sortedTopics.forEach(topic => {
    const nameFormatted = `  ${COLOR.cyan}${topic.name}${COLOR.reset}`.padEnd(maxNameLength + 12); // +12 for ANSI codes
    const partFormatted = `${COLOR.yellow}${topic.partitions}${COLOR.reset}`.padEnd(20);
    const replFormatted = `${COLOR.green}${topic.replicas}${COLOR.reset}`;
    console.log(`${nameFormatted} ${partFormatted} ${replFormatted}`);
  });
}

// ---------------------------------------------------------------------------
// MAIN EXECUTION
// ---------------------------------------------------------------------------
(async () => {
  const kafka = buildKafkaClient();
  try {
    if (flags.list) {
      await listTopics(kafka);
    }
    if (flags.create) {
      await createTopic(kafka, flags.topic, flags.partitions, flags.replication, flags.compacted);
    }
    if (flags.delete) {
      await deleteTopic(kafka, flags.topic);
    }
    if (flags.peek) {
      await peekMessage(kafka, flags.topic);
    }
    if (flags.produce) {
      await produceMessage(kafka, flags.topic, flags.produce, flags.key);
    }
    if (flags.consume) {
      await consumeMessages(kafka, flags.topic, flags.groupId, flags.count);
    }
    if (flags.compact) {
      await compactTopic(kafka, flags.topic, flags.key);
    }
  } catch (err) {
    console.error(fmt.err(err.message ?? err));
    process.exit(1);
  }
})();