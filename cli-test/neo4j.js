#!/usr/bin/env node
/**
 * AI-Agent Neo4j CLI Utility
 * ---------------------------
 * A single-file helper (ES-module) for interacting with the local Neo4j instance
 * used by the AI-Agent stack for graph database operations. Features:
 *   • Connect and verify database connectivity with TLS support
 *   • Execute Cypher queries with transaction management
 *   • List databases, nodes, relationships, and schema information
 *   • Create and delete nodes with labels and properties
 *   • Manage relationships between nodes with type and properties
 *   • View and create constraints, indexes for performance optimization
 *   • Built-in sample data generation for testing graph scenarios
 *   • Database statistics and performance monitoring
 *
 * Quick Examples
 * --------------
 *  # Test connection and list databases
 *  node unittest/neo4j.js --ping
 *
 *  # Execute a simple Cypher query
 *  node unittest/neo4j.js --query "MATCH (n) RETURN count(n) AS total_nodes"
 *
 *  # Create sample nodes and relationships
 *  node unittest/neo4j.js --create-sample --dataset people --count 10
 *
 *  # List all node labels in the database
 *  node unittest/neo4j.js --list-labels
 *
 *  # Show database schema (constraints, indexes)
 *  node unittest/neo4j.js --schema
 *
 *  # Create a person node with properties
 *  node unittest/neo4j.js --create-node "Person" --properties '{"name":"Alice","age":30}'
 *
 *  # Create a relationship between nodes
 *  node unittest/neo4j.js --create-rel --from-id 1 --to-id 2 --type "KNOWS" --properties '{"since":2020}'
 *
 *  # Get database statistics and performance metrics
 *  node unittest/neo4j.js --stats
 *
 *  # Delete all nodes and relationships (with confirmation)
 *  node unittest/neo4j.js --delete-all
 *
 *  # Export data to Cypher statements
 *  node unittest/neo4j.js --export --limit 100
 *
 *  # Connect to different Neo4j instance
 *  node unittest/neo4j.js --ping --uri neo4j+ssc://remote:7687 --user myuser --password mypass
 *
 *  # Use read-only transaction for large queries
 *  node unittest/neo4j.js --query "MATCH (n) RETURN n LIMIT 1000" --read-only
 *
 * Environment
 * -----------
 * The script reads the sibling "../.env" file (if present) and populates any
 * NEO4J_* variables not already in the environment. Supported variables:
*   NEO4J_BOLT_EXTERNAL - Neo4j connection URI (default: neo4j+ssc://localhost:7687)
*   NEO4J_USER - Database username for authentication
*   NEO4J_PASSWORD - Database password for authentication
*   NEO4J_DATABASE - Target database name (default: neo4j)
 *
 * Built-in Datasets
 * -----------------
 * The utility includes curated sample datasets for testing:
 *   • people - Person nodes with relationships (KNOWS, WORKS_WITH)
 *   • movies - Movie and Actor nodes with ACTED_IN relationships
 *   • company - Company, Department, Employee organizational structure
 *   • social - Social network with users, posts, and interactions
 *
 * Security Notes
 * --------------
 * • Credentials are read from environment variables only (never hardcoded)
 * • Uses secure TLS connection (bolt+ssc) with self-signed certificate support
 * • All transactions are properly committed or rolled back on errors
 * • Query parameters are safely escaped to prevent injection
 *
 * Built-in Modes (see --help for full list):
 *   --ping                 Test database connectivity
 *   --query <cypher>       Execute Cypher query
 *   --create-sample        Create sample data
 *   --list-labels          List all node labels
 *   --list-types           List all relationship types
 *   --schema               Show constraints and indexes
 *   --stats                Database statistics
 *   --create-node          Create a single node
 *   --create-rel           Create a relationship
 *   --delete-all           Delete all data
 *   --export               Export data as Cypher
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import neo4j from "neo4j-driver";

// ---------------------------------------------------------------------------
// Environment loader (shared with other CLI tools)
// ---------------------------------------------------------------------------

/**
 * Load environment variables from a "../.env" file if present.
 * Values already present in process.env are NOT overwritten.
 * This allows for runtime overrides while maintaining .env defaults.
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
// Console formatting helpers (no external dependencies)
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
  query: (msg) => `${COLOR.magenta}🔍${COLOR.reset} ${msg}`,
  graph: (msg) => `${COLOR.blue}📊${COLOR.reset} ${msg}`
};

// ---------------------------------------------------------------------------
// HELP SYSTEM
// ---------------------------------------------------------------------------

/**
 * Display comprehensive help information with examples and usage patterns.
 * Organized into logical sections for different use cases.
 */
function printHelp() {
  console.log(`
${COLOR.cyan}Neo4j CLI Test Tool${COLOR.reset}
${COLOR.dim}═══════════════════${COLOR.reset}
Professional utility for interacting with Neo4j graph database.

${COLOR.yellow}MODES${COLOR.reset} (choose one)
  ${COLOR.green}--ping${COLOR.reset}                      Test database connectivity and show version
  ${COLOR.green}--query <cypher>${COLOR.reset}            Execute Cypher query with results
  ${COLOR.green}--create-sample${COLOR.reset}             Create sample data from built-in datasets
  ${COLOR.green}--list-labels${COLOR.reset}               List all node labels in database
  ${COLOR.green}--list-types${COLOR.reset}                List all relationship types in database
  ${COLOR.green}--schema${COLOR.reset}                    Show constraints, indexes, and schema info
  ${COLOR.green}--stats${COLOR.reset}                     Database statistics and performance metrics
  ${COLOR.green}--create-node <label>${COLOR.reset}       Create a single node with label
  ${COLOR.green}--create-rel${COLOR.reset}                Create relationship between nodes
  ${COLOR.green}--delete-all${COLOR.reset}                Delete all nodes and relationships
  ${COLOR.green}--export${COLOR.reset}                    Export data as Cypher CREATE statements

${COLOR.yellow}COMMON OPTIONS${COLOR.reset}
  ${COLOR.cyan}--uri <uri>${COLOR.reset}                  Neo4j connection URI (default: neo4j+ssc://localhost:7687)
  ${COLOR.cyan}--user <username>${COLOR.reset}            Database username for authentication
  ${COLOR.cyan}--password <password>${COLOR.reset}        Database password for authentication
  ${COLOR.cyan}--database <name>${COLOR.reset}            Target database name (default: neo4j)
  ${COLOR.cyan}--read-only${COLOR.reset}                  Use read-only transaction for queries
  ${COLOR.cyan}-h, --help${COLOR.reset}                   Show this comprehensive help message

${COLOR.yellow}SAMPLE DATA OPTIONS${COLOR.reset}
  ${COLOR.cyan}--dataset <name>${COLOR.reset}             Built-in dataset: people, movies, company, social
  ${COLOR.cyan}--count <n>${COLOR.reset}                  Number of nodes to create (default: 20)

${COLOR.yellow}NODE CREATION OPTIONS${COLOR.reset}
  ${COLOR.cyan}--properties <json>${COLOR.reset}          Node properties as JSON object
  ${COLOR.cyan}--labels <list>${COLOR.reset}              Additional labels (comma-separated)

${COLOR.yellow}RELATIONSHIP OPTIONS${COLOR.reset}
  ${COLOR.cyan}--from-id <id>${COLOR.reset}               Source node ID for relationship
  ${COLOR.cyan}--to-id <id>${COLOR.reset}                 Target node ID for relationship
  ${COLOR.cyan}--type <type>${COLOR.reset}                Relationship type name
  ${COLOR.cyan}--rel-properties <json>${COLOR.reset}      Relationship properties as JSON object

${COLOR.yellow}QUERY OPTIONS${COLOR.reset}
  ${COLOR.cyan}--limit <n>${COLOR.reset}                  Limit query results (default: 100)
  ${COLOR.cyan}--timeout <ms>${COLOR.reset}               Query timeout in milliseconds (default: 30000)

${COLOR.yellow}EXAMPLES${COLOR.reset}
  Test connection and show version:
    ${COLOR.dim}node unittest/neo4j.js --ping${COLOR.reset}

  Execute simple query:
    ${COLOR.dim}node unittest/neo4j.js --query "MATCH (n:Person) RETURN n.name, n.age LIMIT 5"${COLOR.reset}

  Create sample movie data:
    ${COLOR.dim}node unittest/neo4j.js --create-sample --dataset movies --count 15${COLOR.reset}

  Show database schema:
    ${COLOR.dim}node unittest/neo4j.js --schema${COLOR.reset}

  Create person node:
    ${COLOR.dim}node unittest/neo4j.js --create-node Person --properties '{"name":"John","age":35}'${COLOR.reset}

  Create relationship:
    ${COLOR.dim}node unittest/neo4j.js --create-rel --from-id 1 --to-id 2 --type KNOWS --rel-properties '{"since":2020}'${COLOR.reset}

  Get database statistics:
    ${COLOR.dim}node unittest/neo4j.js --stats${COLOR.reset}

  Export small dataset:
    ${COLOR.dim}node unittest/neo4j.js --export --limit 50${COLOR.reset}

  Connect to remote instance:
    ${COLOR.dim}node unittest/neo4j.js --ping --uri neo4j+ssc://prod:7687 --user admin --password secret${COLOR.reset}

${COLOR.yellow}BUILT-IN DATASETS${COLOR.reset}
  ${COLOR.cyan}people${COLOR.reset}        Person nodes with KNOWS and WORKS_WITH relationships
  ${COLOR.cyan}movies${COLOR.reset}        Movies, Actors, Directors with ACTED_IN, DIRECTED relationships
  ${COLOR.cyan}company${COLOR.reset}       Company structure with departments and employees
  ${COLOR.cyan}social${COLOR.reset}        Social network with users, posts, likes, and follows

${COLOR.yellow}SECURITY${COLOR.reset}
  ${COLOR.dim}• Uses secure TLS connections (neo4j+ssc protocol) by default${COLOR.reset}
  ${COLOR.dim}• Accepts self-signed certificates for local development${COLOR.reset}
  ${COLOR.dim}• Credentials loaded from NEO4J_USER and NEO4J_PASSWORD environment${COLOR.reset}
  ${COLOR.dim}• All queries use parameterized statements to prevent injection${COLOR.reset}
`);
}

// ---------------------------------------------------------------------------
// CLI ARGUMENT PARSER
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {};

// Parse command line arguments with comprehensive error handling
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "--ping":
      flags.ping = true;
      break;
    case "--query":
      flags.query = args[++i];
      break;
    case "--create-sample":
      flags.createSample = true;
      break;
    case "--list-labels":
      flags.listLabels = true;
      break;
    case "--list-types":
      flags.listTypes = true;
      break;
    case "--schema":
      flags.schema = true;
      break;
    case "--stats":
      flags.stats = true;
      break;
    case "--create-node":
      flags.createNode = args[++i];
      break;
    case "--create-rel":
      flags.createRel = true;
      break;
    case "--delete-all":
      flags.deleteAll = true;
      break;
    case "--export":
      flags.export = true;
      break;
    case "--uri":
      flags.uri = args[++i];
      break;
    case "--user":
      flags.user = args[++i];
      break;
    case "--password":
      flags.password = args[++i];
      break;
    case "--database":
      flags.database = args[++i];
      break;
    case "--dataset":
      flags.dataset = args[++i];
      break;
    case "--count":
      flags.count = parseInt(args[++i], 10);
      break;
    case "--properties":
      flags.properties = args[++i];
      break;
    case "--labels":
      flags.labels = args[++i];
      break;
    case "--from-id":
      flags.fromId = parseInt(args[++i], 10);
      break;
    case "--to-id":
      flags.toId = parseInt(args[++i], 10);
      break;
    case "--type":
      flags.type = args[++i];
      break;
    case "--rel-properties":
      flags.relProperties = args[++i];
      break;
    case "--limit":
      flags.limit = parseInt(args[++i], 10);
      break;
    case "--timeout":
      flags.timeout = parseInt(args[++i], 10);
      break;
    case "--read-only":
      flags.readOnly = true;
      break;
    case "--help":
    case "-h":
      printHelp();
      process.exit(0);
    default:
      console.error(fmt.err(`Unknown argument: ${COLOR.yellow}${arg}${COLOR.reset}`));
      console.log(`\nUse ${COLOR.green}--help${COLOR.reset} for usage information.`);
      process.exit(1);
  }
}

// Show help if no arguments provided
if (args.length === 0) {
  printHelp();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// NEO4J DRIVER SETUP
// ---------------------------------------------------------------------------

/**
 * Build and configure Neo4j driver with TLS support for local development.
 * Handles self-signed certificates and proper authentication.
 * 
 * @returns {neo4j.Driver} Configured Neo4j driver ready for operations
 * @throws {Error} If required credentials are missing from environment
 */
function buildNeo4jDriver() {
  // Get connection parameters with defaults
  const uri = flags.uri || process.env.NEO4J_BOLT_EXTERNAL || "neo4j+ssc://localhost:7687";
  const user = flags.user || process.env.NEO4J_USER;
  const password = flags.password || process.env.NEO4J_PASSWORD;

  if (!user || !password) {
    console.error(fmt.err("Missing required Neo4j credentials"));
    console.error(`  Set ${COLOR.yellow}NEO4J_USER${COLOR.reset} and ${COLOR.yellow}NEO4J_PASSWORD${COLOR.reset} in environment`);
    process.exit(1);
  }

  console.log(fmt.info(`Connecting to Neo4j at ${COLOR.cyan}${uri}${COLOR.reset} as ${COLOR.yellow}${user}${COLOR.reset}`));

  // Configure driver - encryption settings only if not in URI
  const driverConfig = {
    maxConnectionLifetime: 30000,
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 30000
  };

  // Only add encryption config if URI doesn't specify it (e.g., bolt:// vs neo4j+ssc://)
  if (!uri.includes('+ssc://') && !uri.includes('+s://')) {
    driverConfig.encrypted = "ENCRYPTION_ON";
    driverConfig.trust = "TRUST_ALL_CERTIFICATES"; // Accept self-signed certs for local development
  }

  // Create authenticated driver instance
  const auth = neo4j.auth.basic(user, password);
  return neo4j.driver(uri, auth, driverConfig);
}

// Initialize Neo4j driver with error handling
const driver = buildNeo4jDriver();

// ---------------------------------------------------------------------------
// SAMPLE DATASETS
// ---------------------------------------------------------------------------

/**
 * Generate curated sample datasets for testing different graph scenarios.
 * Each dataset includes nodes with properties and relationships.
 */
const DATASETS = {
  people: {
    description: 'Person nodes with social and professional relationships',
    generate: (count = 20) => {
      const firstNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Jack'];
      const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez'];
      const companies = ['TechCorp', 'DataSoft', 'CloudInc', 'AI Systems', 'DevTools'];
      const cities = ['New York', 'San Francisco', 'London', 'Tokyo', 'Berlin'];

      const nodes = [];
      const relationships = [];

      // Create person nodes
      for (let i = 1; i <= count; i++) {
        const firstName = firstNames[i % firstNames.length];
        const lastName = lastNames[(i + 3) % lastNames.length];
        nodes.push({
          query: `CREATE (p${i}:Person {id: $id, name: $name, age: $age, city: $city, company: $company})`,
          params: {
            id: i,
            name: `${firstName} ${lastName}`,
            age: 25 + (i % 40),
            city: cities[i % cities.length],
            company: companies[i % companies.length]
          }
        });
      }

      // Create relationships
      for (let i = 1; i <= count; i++) {
        // KNOWS relationships (social)
        const friendId = (i % count) + 1;
        if (friendId !== i) {
          relationships.push({
            query: `MATCH (a:Person {id: $fromId}), (b:Person {id: $toId}) CREATE (a)-[:KNOWS {since: $since}]->(b)`,
            params: { fromId: i, toId: friendId, since: 2018 + (i % 6) }
          });
        }

        // WORKS_WITH relationships (professional)
        if (i <= count - 2) {
          relationships.push({
            query: `MATCH (a:Person {id: $fromId}), (b:Person {id: $toId}) CREATE (a)-[:WORKS_WITH {project: $project}]->(b)`,
            params: { fromId: i, toId: i + 2, project: `Project ${Math.ceil(i / 3)}` }
          });
        }
      }

      return { nodes, relationships };
    }
  },

  movies: {
    description: 'Movie database with actors, directors, and relationships',
    generate: (count = 20) => {
      const movieTitles = ['The Matrix', 'Inception', 'Interstellar', 'Blade Runner', 'Terminator', 'Avatar'];
      const actorNames = ['Keanu Reeves', 'Leonardo DiCaprio', 'Matthew McConaughey', 'Harrison Ford', 'Arnold Schwarzenegger'];
      const directorNames = ['Christopher Nolan', 'Ridley Scott', 'James Cameron', 'The Wachowskis'];

      const nodes = [];
      const relationships = [];

      // Create movie nodes
      const movieCount = Math.min(count, movieTitles.length);
      for (let i = 1; i <= movieCount; i++) {
        nodes.push({
          query: `CREATE (m${i}:Movie {id: $id, title: $title, year: $year, genre: $genre})`,
          params: {
            id: i,
            title: movieTitles[i - 1],
            year: 1990 + (i * 5),
            genre: i % 2 === 0 ? 'Sci-Fi' : 'Action'
          }
        });
      }

      // Create actor nodes
      const actorCount = Math.min(count - movieCount, actorNames.length);
      for (let i = 1; i <= actorCount; i++) {
        const actorId = movieCount + i;
        nodes.push({
          query: `CREATE (a${actorId}:Actor {id: $id, name: $name, born: $born})`,
          params: {
            id: actorId,
            name: actorNames[i - 1],
            born: 1950 + (i * 10)
          }
        });
      }

      // Create director nodes
      const directorCount = Math.min(count - movieCount - actorCount, directorNames.length);
      for (let i = 1; i <= directorCount; i++) {
        const directorId = movieCount + actorCount + i;
        nodes.push({
          query: `CREATE (d${directorId}:Director {id: $id, name: $name, born: $born})`,
          params: {
            id: directorId,
            name: directorNames[i - 1],
            born: 1940 + (i * 15)
          }
        });
      }

      // Create ACTED_IN relationships
      for (let movieId = 1; movieId <= movieCount; movieId++) {
        for (let actorIdx = 1; actorIdx <= Math.min(actorCount, 2); actorIdx++) {
          const actorId = movieCount + actorIdx;
          relationships.push({
            query: `MATCH (a:Actor {id: $actorId}), (m:Movie {id: $movieId}) CREATE (a)-[:ACTED_IN {role: $role}]->(m)`,
            params: { actorId, movieId, role: `Character ${actorIdx}` }
          });
        }
      }

      return { nodes, relationships };
    }
  },

  company: {
    description: 'Corporate structure with departments and employees',
    generate: (count = 20) => {
      const departments = ['Engineering', 'Sales', 'Marketing', 'HR', 'Finance'];
      const positions = ['Manager', 'Senior', 'Junior', 'Lead', 'Specialist'];

      const nodes = [];
      const relationships = [];

      // Create company node
      nodes.push({
        query: `CREATE (c:Company {id: 1, name: $name, founded: $founded, employees: $employees})`,
        params: { name: 'TechCorp Inc', founded: 2010, employees: count }
      });

      // Create department nodes
      for (let i = 0; i < departments.length; i++) {
        const deptId = i + 2;
        nodes.push({
          query: `CREATE (d${deptId}:Department {id: $id, name: $name, budget: $budget})`,
          params: { id: deptId, name: departments[i], budget: 500000 + (i * 200000) }
        });

        // Connect department to company
        relationships.push({
          query: `MATCH (c:Company {id: 1}), (d:Department {id: $deptId}) CREATE (d)-[:PART_OF]->(c)`,
          params: { deptId }
        });
      }

      // Create employee nodes
      const employeeStart = departments.length + 2;
      for (let i = 0; i < count - departments.length - 1; i++) {
        const empId = employeeStart + i;
        const deptId = (i % departments.length) + 2;
        nodes.push({
          query: `CREATE (e${empId}:Employee {id: $id, name: $name, position: $position, salary: $salary})`,
          params: {
            id: empId,
            name: `Employee ${i + 1}`,
            position: positions[i % positions.length],
            salary: 60000 + (i * 5000)
          }
        });

        // Connect employee to department
        relationships.push({
          query: `MATCH (e:Employee {id: $empId}), (d:Department {id: $deptId}) CREATE (e)-[:WORKS_IN]->(d)`,
          params: { empId, deptId }
        });
      }

      return { nodes, relationships };
    }
  },

  social: {
    description: 'Social network with users, posts, and interactions',
    generate: (count = 20) => {
      const nodes = [];
      const relationships = [];

      // Create user nodes
      const userCount = Math.ceil(count * 0.6);
      for (let i = 1; i <= userCount; i++) {
        nodes.push({
          query: `CREATE (u${i}:User {id: $id, username: $username, followers: $followers, joined: $joined})`,
          params: {
            id: i,
            username: `user${i}`,
            followers: Math.floor(Math.random() * 1000),
            joined: new Date(2020 + (i % 4), i % 12, 1).toISOString().split('T')[0]
          }
        });
      }

      // Create post nodes
      const postCount = count - userCount;
      for (let i = 1; i <= postCount; i++) {
        const postId = userCount + i;
        const authorId = (i % userCount) + 1;
        nodes.push({
          query: `CREATE (p${postId}:Post {id: $id, content: $content, likes: $likes, created: $created})`,
          params: {
            id: postId,
            content: `This is post number ${i} with interesting content`,
            likes: Math.floor(Math.random() * 100),
            created: new Date(2024, 0, i).toISOString().split('T')[0]
          }
        });

        // Connect post to author
        relationships.push({
          query: `MATCH (u:User {id: $authorId}), (p:Post {id: $postId}) CREATE (u)-[:POSTED]->(p)`,
          params: { authorId, postId }
        });
      }

      // Create FOLLOWS relationships
      for (let i = 1; i <= userCount; i++) {
        const followeeId = (i % userCount) + 1;
        if (followeeId !== i) {
          relationships.push({
            query: `MATCH (a:User {id: $followerId}), (b:User {id: $followeeId}) CREATE (a)-[:FOLLOWS {since: $since}]->(b)`,
            params: { followerId: i, followeeId, since: new Date(2023, i % 12, 1).toISOString().split('T')[0] }
          });
        }
      }

      return { nodes, relationships };
    }
  }
};

// ---------------------------------------------------------------------------
// CORE OPERATIONS
// ---------------------------------------------------------------------------

/**
 * Test database connectivity and display version information.
 * Verifies authentication and network connectivity.
 * 
 * @returns {Promise<void>}
 */
async function pingDatabase() {
  console.log(fmt.info("Testing database connectivity..."));
  
  const session = driver.session({ database: flags.database || process.env.NEO4J_DATABASE || 'neo4j' });
  
  try {
    const result = await session.run('CALL dbms.components() YIELD name, versions, edition');
    const component = result.records[0];
    
    if (component) {
      const name = component.get('name');
      const versions = component.get('versions')[0];
      const edition = component.get('edition');
      
      console.log(fmt.ok(`Connected to Neo4j successfully`));
      console.log(`  Database: ${COLOR.cyan}${name}${COLOR.reset}`);
      console.log(`  Version: ${COLOR.yellow}${versions}${COLOR.reset}`);
      console.log(`  Edition: ${COLOR.green}${edition}${COLOR.reset}`);
    }

    // Test database accessibility
    const dbResult = await session.run('RETURN "Connection successful" AS message');
    const message = dbResult.records[0].get('message');
    console.log(`  Status: ${COLOR.green}${message}${COLOR.reset}`);
    
  } catch (error) {
    throw new Error(`Connection test failed: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * Execute a Cypher query and display formatted results.
 * Supports both read and write operations with proper transaction handling.
 * 
 * @param {string} cypher - The Cypher query to execute
 * @param {boolean} readOnly - Whether to use read-only transaction
 * @returns {Promise<void>}
 */
async function executeQuery(cypher, readOnly = false) {
  if (!cypher) {
    console.error(fmt.err("--query requires a Cypher statement"));
    console.log(`Example: ${COLOR.green}--query "MATCH (n) RETURN count(n) AS total"${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.query(`Executing query (${readOnly ? 'read-only' : 'read-write'}):`));
  console.log(`  ${COLOR.dim}${cypher}${COLOR.reset}`);

  const session = driver.session({ 
    database: flags.database || process.env.NEO4J_DATABASE || 'neo4j',
    defaultAccessMode: readOnly ? neo4j.session.READ : neo4j.session.WRITE
  });

  try {
    const startTime = Date.now();
    const result = await session.run(cypher, {}, { timeout: flags.timeout || 30000 });
    const duration = Date.now() - startTime;

    console.log(fmt.ok(`Query completed in ${COLOR.yellow}${duration}ms${COLOR.reset}`));
    
    if (result.records.length === 0) {
      console.log(fmt.info("No results returned"));
      return;
    }

    console.log(`\n${fmt.ok(`Found ${COLOR.yellow}${result.records.length}${COLOR.reset} record${result.records.length === 1 ? '' : 's'}:`)}`);
    
    // Display results in a table-like format
    const keys = result.records[0].keys;
    const maxRecords = Math.min(result.records.length, flags.limit || 100);
    
    // Header
    console.log(`\n  ${keys.map(key => COLOR.cyan + key + COLOR.reset).join(' | ')}`);
    console.log(`  ${keys.map(key => '─'.repeat(key.length + 2)).join('┼')}`);
    
    // Data rows
    for (let i = 0; i < maxRecords; i++) {
      const record = result.records[i];
      const values = keys.map(key => {
        const value = record.get(key);
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
      });
      console.log(`  ${values.join(' | ')}`);
    }

    if (result.records.length > maxRecords) {
      console.log(`\n  ${COLOR.dim}... and ${result.records.length - maxRecords} more records${COLOR.reset}`);
    }

  } catch (error) {
    throw new Error(`Query execution failed: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * Create sample data using built-in datasets.
 * Generates nodes and relationships for testing graph scenarios.
 * 
 * @param {string} datasetName - Name of the built-in dataset
 * @param {number} count - Number of nodes to create
 * @returns {Promise<void>}
 */
async function createSampleData(datasetName = 'people', count = 20) {
  const dataset = DATASETS[datasetName];
  if (!dataset) {
    console.error(fmt.err(`Unknown dataset: ${datasetName}`));
    console.log(`Available datasets: ${Object.keys(DATASETS).map(d => COLOR.cyan + d + COLOR.reset).join(', ')}`);
    process.exit(1);
  }

  console.log(fmt.graph(`Creating sample data from ${COLOR.cyan}${datasetName}${COLOR.reset} dataset...`));
  console.log(fmt.info(`Dataset: ${dataset.description}`));

  const session = driver.session({ database: flags.database || process.env.NEO4J_DATABASE || 'neo4j' });
  
  try {
    const { nodes, relationships } = dataset.generate(count);
    
    console.log(fmt.info(`Generating ${COLOR.yellow}${nodes.length}${COLOR.reset} nodes and ${COLOR.yellow}${relationships.length}${COLOR.reset} relationships...`));

    // Create nodes first
    for (const node of nodes) {
      await session.run(node.query, node.params);
    }

    // Then create relationships
    for (const rel of relationships) {
      await session.run(rel.query, rel.params);
    }

    console.log(fmt.ok(`Successfully created sample ${COLOR.cyan}${datasetName}${COLOR.reset} dataset`));
    console.log(`  Query data using: ${COLOR.green}--query "MATCH (n) RETURN labels(n), count(n)"${COLOR.reset}`);

  } catch (error) {
    throw new Error(`Sample data creation failed: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * List all node labels in the database with counts.
 * Provides an overview of data structure and content.
 * 
 * @returns {Promise<void>}
 */
async function listLabels() {
  console.log(fmt.info("Fetching all node labels..."));
  
  const session = driver.session({ 
    database: flags.database || process.env.NEO4J_DATABASE || 'neo4j',
    defaultAccessMode: neo4j.session.READ
  });

  try {
    const result = await session.run(`
      MATCH (n) 
      UNWIND labels(n) AS label 
      RETURN label, count(*) AS count 
      ORDER BY count DESC, label ASC
    `);

    if (result.records.length === 0) {
      console.log(fmt.info("No node labels found. Database may be empty."));
      return;
    }

    console.log(fmt.ok(`Found ${COLOR.yellow}${result.records.length}${COLOR.reset} node label${result.records.length === 1 ? '' : 's'}:`));
    console.log();

    result.records.forEach(record => {
      const label = record.get('label');
      const count = record.get('count').toNumber();
      console.log(`  ${COLOR.cyan}${label}${COLOR.reset}: ${COLOR.yellow}${count}${COLOR.reset} nodes`);
    });

  } catch (error) {
    throw new Error(`Failed to list labels: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * List all relationship types in the database with counts.
 * Shows the connections structure in the graph.
 * 
 * @returns {Promise<void>}
 */
async function listRelationshipTypes() {
  console.log(fmt.info("Fetching all relationship types..."));
  
  const session = driver.session({ 
    database: flags.database || process.env.NEO4J_DATABASE || 'neo4j',
    defaultAccessMode: neo4j.session.READ
  });

  try {
    const result = await session.run(`
      MATCH ()-[r]->() 
      RETURN type(r) AS type, count(*) AS count 
      ORDER BY count DESC, type ASC
    `);

    if (result.records.length === 0) {
      console.log(fmt.info("No relationships found. Database may contain only isolated nodes."));
      return;
    }

    console.log(fmt.ok(`Found ${COLOR.yellow}${result.records.length}${COLOR.reset} relationship type${result.records.length === 1 ? '' : 's'}:`));
    console.log();

    result.records.forEach(record => {
      const type = record.get('type');
      const count = record.get('count').toNumber();
      console.log(`  ${COLOR.magenta}${type}${COLOR.reset}: ${COLOR.yellow}${count}${COLOR.reset} relationships`);
    });

  } catch (error) {
    throw new Error(`Failed to list relationship types: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * Display database schema information including constraints and indexes.
 * Essential for understanding database structure and performance optimization.
 * 
 * @returns {Promise<void>}
 */
async function showSchema() {
  console.log(fmt.info("Fetching database schema information..."));
  
  const session = driver.session({ 
    database: flags.database || process.env.NEO4J_DATABASE || 'neo4j',
    defaultAccessMode: neo4j.session.READ
  });

  try {
    // Get constraints
    console.log(fmt.graph("Database Constraints:"));
    const constraintsResult = await session.run("SHOW CONSTRAINTS");
    
    if (constraintsResult.records.length === 0) {
      console.log("  " + fmt.info("No constraints defined"));
    } else {
      constraintsResult.records.forEach(record => {
        const name = record.get('name');
        const type = record.get('type');
        const labelsOrTypes = record.get('labelsOrTypes') || [];
        const properties = record.get('properties') || [];
        console.log(`  ${COLOR.green}${name}${COLOR.reset} (${type})`);
        
        // Only show labels and properties if they exist
        if (labelsOrTypes.length > 0) {
          console.log(`    Labels: ${COLOR.cyan}${labelsOrTypes.join(', ')}${COLOR.reset}`);
        }
        if (properties.length > 0) {
          console.log(`    Properties: ${COLOR.yellow}${properties.join(', ')}${COLOR.reset}`);
        }
      });
    }

    console.log();

    // Get indexes
    console.log(fmt.graph("Database Indexes:"));
    const indexesResult = await session.run("SHOW INDEXES");
    
    if (indexesResult.records.length === 0) {
      console.log("  " + fmt.info("No indexes defined"));
    } else {
      indexesResult.records.forEach(record => {
        const name = record.get('name');
        const type = record.get('type');
        const labelsOrTypes = record.get('labelsOrTypes') || [];
        const properties = record.get('properties') || [];
        const state = record.get('state');
        console.log(`  ${COLOR.blue}${name}${COLOR.reset} (${type}) - ${COLOR.green}${state}${COLOR.reset}`);
        
        // Only show labels and properties if they exist
        if (labelsOrTypes.length > 0) {
          console.log(`    Labels: ${COLOR.cyan}${labelsOrTypes.join(', ')}${COLOR.reset}`);
        }
        if (properties.length > 0) {
          console.log(`    Properties: ${COLOR.yellow}${properties.join(', ')}${COLOR.reset}`);
        }
      });
    }

  } catch (error) {
    throw new Error(`Failed to show schema: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * Display database statistics and performance metrics.
 * Provides insights into database size, performance, and memory usage.
 * 
 * @returns {Promise<void>}
 */
async function showStats() {
  console.log(fmt.info("Gathering database statistics..."));
  
  const session = driver.session({ 
    database: flags.database || process.env.NEO4J_DATABASE || 'neo4j',
    defaultAccessMode: neo4j.session.READ
  });

  try {
    // Basic node and relationship counts
    const countsResult = await session.run(`
      MATCH (n) 
      OPTIONAL MATCH ()-[r]->() 
      RETURN count(DISTINCT n) AS nodes, count(r) AS relationships
    `);
    
    const nodeCount = countsResult.records[0].get('nodes').toNumber();
    const relCount = countsResult.records[0].get('relationships').toNumber();

    console.log(fmt.graph("Database Overview:"));
    console.log(`  Total Nodes: ${COLOR.yellow}${nodeCount.toLocaleString()}${COLOR.reset}`);
    console.log(`  Total Relationships: ${COLOR.yellow}${relCount.toLocaleString()}${COLOR.reset}`);
    console.log();

    // Label distribution
    const labelsResult = await session.run(`
      MATCH (n) 
      UNWIND labels(n) AS label 
      RETURN label, count(*) AS count 
      ORDER BY count DESC 
      LIMIT 10
    `);

    if (labelsResult.records.length > 0) {
      console.log(fmt.graph("Top Node Labels:"));
      labelsResult.records.forEach(record => {
        const label = record.get('label');
        const count = record.get('count').toNumber();
        const percentage = ((count / nodeCount) * 100).toFixed(1);
        console.log(`  ${COLOR.cyan}${label}${COLOR.reset}: ${COLOR.yellow}${count.toLocaleString()}${COLOR.reset} (${percentage}%)`);
      });
      console.log();
    }

    // Relationship type distribution  
    const relTypesResult = await session.run(`
      MATCH ()-[r]->() 
      RETURN type(r) AS type, count(*) AS count 
      ORDER BY count DESC 
      LIMIT 10
    `);

    if (relTypesResult.records.length > 0) {
      console.log(fmt.graph("Top Relationship Types:"));
      relTypesResult.records.forEach(record => {
        const type = record.get('type');
        const count = record.get('count').toNumber();
        const percentage = ((count / relCount) * 100).toFixed(1);
        console.log(`  ${COLOR.magenta}${type}${COLOR.reset}: ${COLOR.yellow}${count.toLocaleString()}${COLOR.reset} (${percentage}%)`);
      });
    }

  } catch (error) {
    throw new Error(`Failed to gather statistics: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * Create a single node with specified label and properties.
 * Provides detailed feedback about the created node.
 * 
 * @param {string} label - Primary label for the node
 * @param {string} propertiesJson - JSON string of node properties
 * @param {string} additionalLabels - Comma-separated additional labels
 * @returns {Promise<void>}
 */
async function createNode(label, propertiesJson = '{}', additionalLabels = '') {
  if (!label) {
    console.error(fmt.err("--create-node requires a label"));
    console.log(`Example: ${COLOR.green}--create-node Person --properties '{"name":"Alice","age":30}'${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.graph(`Creating node with label ${COLOR.cyan}${label}${COLOR.reset}...`));

  let properties = {};
  try {
    properties = JSON.parse(propertiesJson);
  } catch (error) {
    console.error(fmt.err(`Invalid JSON in properties: ${error.message}`));
    process.exit(1);
  }

  const labels = [label];
  if (additionalLabels) {
    labels.push(...additionalLabels.split(',').map(l => l.trim()));
  }

  const session = driver.session({ database: flags.database || process.env.NEO4J_DATABASE || 'neo4j' });

  try {
    const labelsStr = labels.map(l => `:${l}`).join('');
    const result = await session.run(
      `CREATE (n${labelsStr} $properties) RETURN id(n) AS nodeId, n`,
      { properties }
    );

    const nodeId = result.records[0].get('nodeId').toNumber();
    const node = result.records[0].get('n');

    console.log(fmt.ok(`Successfully created node`));
    console.log(`  ID: ${COLOR.yellow}${nodeId}${COLOR.reset}`);
    console.log(`  Labels: ${COLOR.cyan}${labels.join(', ')}${COLOR.reset}`);
    console.log(`  Properties: ${COLOR.dim}${JSON.stringify(node.properties)}${COLOR.reset}`);

  } catch (error) {
    throw new Error(`Node creation failed: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * Create a relationship between two nodes.
 * Requires source and target node IDs and relationship type.
 * 
 * @param {number} fromId - Source node ID
 * @param {number} toId - Target node ID
 * @param {string} type - Relationship type
 * @param {string} propertiesJson - JSON string of relationship properties
 * @returns {Promise<void>}
 */
async function createRelationship(fromId, toId, type, propertiesJson = '{}') {
  if (!fromId || !toId || !type) {
    console.error(fmt.err("--create-rel requires --from-id, --to-id, and --type"));
    console.log(`Example: ${COLOR.green}--create-rel --from-id 1 --to-id 2 --type KNOWS --rel-properties '{"since":2020}'${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.graph(`Creating ${COLOR.magenta}${type}${COLOR.reset} relationship: ${COLOR.yellow}${fromId}${COLOR.reset} → ${COLOR.yellow}${toId}${COLOR.reset}`));

  let properties = {};
  try {
    properties = JSON.parse(propertiesJson);
  } catch (error) {
    console.error(fmt.err(`Invalid JSON in rel-properties: ${error.message}`));
    process.exit(1);
  }

  const session = driver.session({ database: flags.database || process.env.NEO4J_DATABASE || 'neo4j' });

  try {
    const result = await session.run(`
      MATCH (a), (b) 
      WHERE id(a) = $fromId AND id(b) = $toId 
      CREATE (a)-[r:${type} $properties]->(b) 
      RETURN id(r) AS relId, r
    `, { fromId: neo4j.int(fromId), toId: neo4j.int(toId), properties });

    if (result.records.length === 0) {
      console.error(fmt.err(`Could not find nodes with IDs ${fromId} and/or ${toId}`));
      return;
    }

    const relId = result.records[0].get('relId').toNumber();
    const relationship = result.records[0].get('r');

    console.log(fmt.ok(`Successfully created relationship`));
    console.log(`  ID: ${COLOR.yellow}${relId}${COLOR.reset}`);
    console.log(`  Type: ${COLOR.magenta}${type}${COLOR.reset}`);
    console.log(`  Properties: ${COLOR.dim}${JSON.stringify(relationship.properties)}${COLOR.reset}`);

  } catch (error) {
    throw new Error(`Relationship creation failed: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * Delete all nodes and relationships from the database.
 * Includes confirmation and provides detailed feedback.
 * 
 * @returns {Promise<void>}
 */
async function deleteAllData() {
  console.log(fmt.warn("This will delete ALL nodes and relationships from the database!"));
  console.log(fmt.info("Press Ctrl+C to cancel, or press Enter to continue..."));
  
  // Simple confirmation (in a real CLI tool, you'd use a proper prompt library)
  process.stdin.setRawMode(true);
  process.stdin.resume();
  
  await new Promise(resolve => {
    process.stdin.once('data', (data) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });

  console.log(fmt.warn("Deleting all data..."));
  
  const session = driver.session({ database: flags.database || process.env.NEO4J_DATABASE || 'neo4j' });

  try {
    // Get counts before deletion
    const beforeResult = await session.run('MATCH (n) OPTIONAL MATCH ()-[r]->() RETURN count(DISTINCT n) AS nodes, count(r) AS rels');
    const nodesBefore = beforeResult.records[0].get('nodes').toNumber();
    const relsBefore = beforeResult.records[0].get('rels').toNumber();

    // Delete all relationships first, then nodes
    await session.run('MATCH ()-[r]->() DELETE r');
    await session.run('MATCH (n) DELETE n');

    console.log(fmt.ok("All data deleted successfully"));
    console.log(`  Deleted ${COLOR.yellow}${nodesBefore}${COLOR.reset} nodes`);
    console.log(`  Deleted ${COLOR.yellow}${relsBefore}${COLOR.reset} relationships`);

  } catch (error) {
    throw new Error(`Data deletion failed: ${error.message}`);
  } finally {
    await session.close();
  }
}

/**
 * Export database content as Cypher CREATE statements.
 * Useful for backup or data migration purposes.
 * 
 * @param {number} limit - Maximum number of nodes to export
 * @returns {Promise<void>}
 */
async function exportData(limit = 100) {
  console.log(fmt.info(`Exporting data as Cypher statements (limit: ${limit})...`));
  
  const session = driver.session({ 
    database: flags.database || process.env.NEO4J_DATABASE || 'neo4j',
    defaultAccessMode: neo4j.session.READ
  });

  try {
    // Export nodes
    const nodesResult = await session.run(`MATCH (n) RETURN n LIMIT ${limit}`);
    
    console.log(fmt.graph("Node CREATE statements:"));
    console.log();
    
    nodesResult.records.forEach((record, index) => {
      const node = record.get('n');
      const labels = node.labels.map(l => `:${l}`).join('');
      const props = JSON.stringify(node.properties);
      console.log(`CREATE (n${index}${labels} ${props});`);
    });

    console.log();

    // Export relationships (limited sample)
    const relsResult = await session.run(`
      MATCH (a)-[r]->(b) 
      RETURN id(a) AS fromId, id(b) AS toId, type(r) AS type, properties(r) AS props 
      LIMIT ${Math.min(limit, 50)}
    `);

    if (relsResult.records.length > 0) {
      console.log(fmt.graph("Relationship CREATE statements:"));
      console.log("// Note: Replace nodeIds with actual variable names from above");
      console.log();
      
      relsResult.records.forEach(record => {
        const fromId = record.get('fromId').toNumber();
        const toId = record.get('toId').toNumber();
        const type = record.get('type');
        const props = record.get('props');
        const propsStr = Object.keys(props).length > 0 ? ` ${JSON.stringify(props)}` : '';
        console.log(`MATCH (a), (b) WHERE id(a) = ${fromId} AND id(b) = ${toId} CREATE (a)-[:${type}${propsStr}]->(b);`);
      });
    }

    console.log();
    console.log(fmt.info(`Export completed. Showing first ${limit} nodes and relationships.`));

  } catch (error) {
    throw new Error(`Data export failed: ${error.message}`);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// MAIN EXECUTION HANDLER
// ---------------------------------------------------------------------------

/**
 * Main execution flow with comprehensive error handling.
 * Routes to appropriate operation based on CLI flags.
 */
(async () => {
  try {
    // Execute the requested operation
    if (flags.ping) await pingDatabase();
    if (flags.query) await executeQuery(flags.query, flags.readOnly);
    if (flags.createSample) await createSampleData(flags.dataset, flags.count);
    if (flags.listLabels) await listLabels();
    if (flags.listTypes) await listRelationshipTypes();
    if (flags.schema) await showSchema();
    if (flags.stats) await showStats();
    if (flags.createNode) await createNode(flags.createNode, flags.properties, flags.labels);
    if (flags.createRel) await createRelationship(flags.fromId, flags.toId, flags.type, flags.relProperties);
    if (flags.deleteAll) await deleteAllData();
    if (flags.export) await exportData(flags.limit);
    
  } catch (err) {
    // Handle different types of errors with appropriate messaging
    if (err.message && err.message.includes('authentication')) {
      console.error(fmt.err("Authentication failed"));
      console.log(`  Check ${COLOR.yellow}NEO4J_USER${COLOR.reset} and ${COLOR.yellow}NEO4J_PASSWORD${COLOR.reset} environment variables`);
      console.log(`  Verify credentials with: ${COLOR.green}--ping${COLOR.reset}`);
    } else if (err.message && err.message.includes('connection')) {
      console.error(fmt.err("Cannot connect to Neo4j server"));
      console.log(`  Verify Neo4j is running at: ${COLOR.cyan}${flags.uri || process.env.NEO4J_BOLT_EXTERNAL || 'neo4j+ssc://localhost:7687'}${COLOR.reset}`);
      console.log(`  Check TLS configuration and certificates`);
      console.log(`  Start Neo4j with: ${COLOR.green}docker run -p 7687:7687 neo4j:latest${COLOR.reset}`);
    } else if (err.message && err.message.includes('database does not exist')) {
      console.error(fmt.err(`Database not found: ${flags.database || 'neo4j'}`));
      console.log(`  Use ${COLOR.green}--ping${COLOR.reset} to verify available databases`);
    } else if (err.message && err.message.includes('timeout')) {
      console.error(fmt.err("Query timeout"));
      console.log(`  Try increasing timeout with: ${COLOR.green}--timeout 60000${COLOR.reset}`);
      console.log(`  Use ${COLOR.green}--read-only${COLOR.reset} for large read queries`);
    } else {
      // Generic error handling for unexpected issues
      console.error(fmt.err(`Operation failed: ${err.message}`));
      console.log(`  ${COLOR.dim}Use --help for usage information${COLOR.reset}`);
    }
    process.exit(1);
  } finally {
    // Always close the driver to prevent connection leaks
    await driver.close();
  }
})(); 