#!/usr/bin/env node
/**
 * AI-Agent Qdrant CLI Utility
 * ---------------------------
 * A single-file helper (ES-module) for interacting with the local Qdrant instance
 * used by the AI-Agent stack for vector database operations. Features:
 *   • List collections with detailed metadata and configuration
 *   • Create collections with custom vector dimensions and distance metrics
 *   • Insert points with vectors and payload data using curated datasets
 *   • Search for similar vectors with filtering and scoring options
 *   • Retrieve points by ID with vector and payload information
 *   • Delete points and collections with confirmation feedback
 *   • Built-in sample datasets for testing different vector scenarios
 *
 * Quick Examples
 * --------------
 *  # List all collections
 *  node unittest/qdrant.js --list
 *
 *  # Create a new collection for document embeddings
 *  node unittest/qdrant.js --create documents --size 384 --distance cosine
 *
 *  # Create collection with curated sample data
 *  node unittest/qdrant.js --create-sample products --dataset ecommerce
 *
 *  # Insert points from built-in dataset
 *  node unittest/qdrant.js --insert --collection documents --dataset texts
 *
 *  # Search for similar vectors
 *  node unittest/qdrant.js --search "technology innovation" --collection documents --limit 5
 *
 *  # Search with filtering
 *  node unittest/qdrant.js --search-id 1 --collection products --filter "category:electronics"
 *
 *  # Get point by ID with full details
 *  node unittest/qdrant.js --get 42 --collection documents
 *
 *  # Delete a point
 *  node unittest/qdrant.js --delete 42 --collection documents
 *
 *  # Delete entire collection
 *  node unittest/qdrant.js --delete-collection old-vectors
 *
 *  # Connect to remote Qdrant instance with strict TLS
 *  node unittest/qdrant.js --list --endpoint https://qdrant.example.com:6333 --strict
 *
 *  # Use API key authentication with self-signed certs
 *  node unittest/qdrant.js --list --api-key your-api-key-here
 *
 * Environment
 * -----------
 * The script reads the sibling "../.env" file (if present) and populates any
 * QDRANT_* variables not already in the environment. Supported variables:
*   QDRANT_URL_EXTERNAL - Qdrant server endpoint (default: https://localhost:6333)
*   QDRANT_API_KEY - Optional API key for authentication
*   QDRANT_TIMEOUT - Request timeout in milliseconds (default: 30000)
 *
 * Built-in Datasets
 * -----------------
 * The utility includes curated sample datasets for testing:
 *   • texts - Sample text embeddings for document similarity
 *   • ecommerce - Product vectors with category and price metadata
 *   • colors - RGB color vectors with semantic labels
 *   • geospatial - Location vectors with coordinate metadata
 *
 * Security Notes
 * --------------
 * • API keys are read from environment variables only (never hardcoded)
 * • Uses HTTPS by default with self-signed certificate support for local development
 * • Use --strict flag to enforce valid TLS certificates in production
 * • All vector data is locally generated for testing purposes only
 *
 * Built-in Modes (see --help for full list):
 *   --list                     List all collections
 *   --create <name>            Create a new collection
 *   --create-sample <name>     Create collection with sample data
 *   --insert                   Insert points into collection
 *   --search <query>           Search for similar vectors
 *   --search-id <id>           Search using existing point as query
 *   --get <id>                 Get point by ID
 *   --delete <id>              Delete point by ID
 *   --delete-collection <name> Delete entire collection
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { QdrantClient } from "@qdrant/qdrant-js";

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
  search: (msg) => `${COLOR.magenta}🔍${COLOR.reset} ${msg}`,
  vector: (msg) => `${COLOR.blue}📊${COLOR.reset} ${msg}`
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
${COLOR.cyan}Qdrant CLI Test Tool${COLOR.reset}
${COLOR.dim}════════════════════${COLOR.reset}
Professional utility for interacting with Qdrant vector database.

${COLOR.yellow}MODES${COLOR.reset} (choose one)
  ${COLOR.green}--list${COLOR.reset}                         List all collections with details
  ${COLOR.green}--create <name>${COLOR.reset}                Create a new collection
  ${COLOR.green}--create-sample <name>${COLOR.reset}         Create collection with sample data
  ${COLOR.green}--insert${COLOR.reset}                       Insert points into collection (requires --collection)
  ${COLOR.green}--search <query>${COLOR.reset}               Search for similar vectors by text
  ${COLOR.green}--search-id <id>${COLOR.reset}               Search using existing point as query
  ${COLOR.green}--get <id>${COLOR.reset}                     Get point by ID (requires --collection)
  ${COLOR.green}--delete <id>${COLOR.reset}                  Delete point by ID (requires --collection)
  ${COLOR.green}--delete-collection <name>${COLOR.reset}     Delete entire collection permanently

${COLOR.yellow}COMMON OPTIONS${COLOR.reset}
  ${COLOR.cyan}--collection <name>${COLOR.reset}           Target collection for point operations
  ${COLOR.cyan}--endpoint <url>${COLOR.reset}              Override Qdrant endpoint (default: https://localhost:6333)
  ${COLOR.cyan}--api-key <key>${COLOR.reset}               Authentication API key
  ${COLOR.cyan}--timeout <ms>${COLOR.reset}                Request timeout in milliseconds (default: 30000)
  ${COLOR.cyan}--strict${COLOR.reset}                      Require valid TLS certificates (reject self-signed)
  ${COLOR.cyan}-h, --help${COLOR.reset}                    Show this comprehensive help message

${COLOR.yellow}CREATE OPTIONS${COLOR.reset}
  ${COLOR.cyan}--size <n>${COLOR.reset}                    Vector dimension size (default: 384)
  ${COLOR.cyan}--distance <metric>${COLOR.reset}           Distance metric: cosine, euclid, dot (default: cosine)

${COLOR.yellow}INSERT OPTIONS${COLOR.reset}
  ${COLOR.cyan}--dataset <name>${COLOR.reset}              Use built-in dataset: texts, ecommerce, colors, geospatial
  ${COLOR.cyan}--count <n>${COLOR.reset}                   Number of points to insert (default: 50)

${COLOR.yellow}SEARCH OPTIONS${COLOR.reset}
  ${COLOR.cyan}--limit <n>${COLOR.reset}                   Number of results to return (default: 10)
  ${COLOR.cyan}--filter <expr>${COLOR.reset}               Filter expression (e.g., "category:electronics")
  ${COLOR.cyan}--threshold <score>${COLOR.reset}           Minimum similarity score threshold

${COLOR.yellow}EXAMPLES${COLOR.reset}
  List all collections:
    ${COLOR.dim}node unittest/qdrant.js --list${COLOR.reset}

  Create collection for 384-dim vectors:
    ${COLOR.dim}node unittest/qdrant.js --create documents --size 384 --distance cosine${COLOR.reset}

  Create collection with sample data:
    ${COLOR.dim}node unittest/qdrant.js --create-sample products --dataset ecommerce${COLOR.reset}

  Insert text vectors:
    ${COLOR.dim}node unittest/qdrant.js --insert --collection documents --dataset texts --count 100${COLOR.reset}

  Search by text query:
    ${COLOR.dim}node unittest/qdrant.js --search "machine learning" --collection documents --limit 5${COLOR.reset}

  Search with filtering:
    ${COLOR.dim}node unittest/qdrant.js --search-id 1 --collection products --filter "price:<100"${COLOR.reset}

  Get point details:
    ${COLOR.dim}node unittest/qdrant.js --get 42 --collection documents${COLOR.reset}

  Delete a point:
    ${COLOR.dim}node unittest/qdrant.js --delete 42 --collection documents${COLOR.reset}

  Connect to remote instance with strict TLS:
    ${COLOR.dim}node unittest/qdrant.js --list --endpoint https://qdrant.example.com:6333 --api-key your-key --strict${COLOR.reset}

${COLOR.yellow}BUILT-IN DATASETS${COLOR.reset}
  ${COLOR.cyan}texts${COLOR.reset}        Sample text embeddings for document similarity testing
  ${COLOR.cyan}ecommerce${COLOR.reset}    Product vectors with category, price, and description metadata
  ${COLOR.cyan}colors${COLOR.reset}       RGB color vectors with semantic color names and hex codes
  ${COLOR.cyan}geospatial${COLOR.reset}   Location vectors with coordinate and place name metadata

${COLOR.yellow}SECURITY${COLOR.reset}
  ${COLOR.dim}• API keys loaded from QDRANT_API_KEY environment variable${COLOR.reset}
  ${COLOR.dim}• All sample data is locally generated for testing purposes${COLOR.reset}
  ${COLOR.dim}• Requests include proper timeout and error handling${COLOR.reset}
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
    case "--list":
      flags.list = true;
      break;
    case "--create":
      flags.create = args[++i];
      break;
    case "--create-sample":
      flags.createSample = args[++i];
      break;
    case "--insert":
      flags.insert = true;
      break;
    case "--search":
      flags.search = args[++i];
      break;
    case "--search-id":
      flags.searchId = parseInt(args[++i], 10);
      break;
    case "--get":
      flags.get = parseInt(args[++i], 10);
      break;
    case "--delete":
      flags.delete = parseInt(args[++i], 10);
      break;
    case "--delete-collection":
      flags.deleteCollection = args[++i];
      break;
    case "--collection":
      flags.collection = args[++i];
      break;
    case "--endpoint":
      flags.endpoint = args[++i];
      break;
    case "--api-key":
      flags.apiKey = args[++i];
      break;
    case "--timeout":
      flags.timeout = parseInt(args[++i], 10);
      break;
    case "--size":
      flags.size = parseInt(args[++i], 10);
      break;
    case "--distance":
      flags.distance = args[++i];
      break;
    case "--dataset":
      flags.dataset = args[++i];
      break;
    case "--count":
      flags.count = parseInt(args[++i], 10);
      break;
    case "--limit":
      flags.limit = parseInt(args[++i], 10);
      break;
    case "--filter":
      flags.filter = args[++i];
      break;
    case "--threshold":
      flags.threshold = parseFloat(args[++i]);
      break;
    case "--strict":
      flags.strict = true;
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
// QDRANT CLIENT BUILDER
// ---------------------------------------------------------------------------

/**
 * Build and configure Qdrant client with proper authentication and timeout.
 * Supports both local and remote Qdrant instances with API key authentication.
 * Handles TLS/SSL connections with self-signed certificate support.
 * 
 * @returns {QdrantClient} Configured Qdrant client ready for operations
 */
function buildQdrantClient() {
  const endpoint = flags.endpoint || process.env.QDRANT_URL_EXTERNAL || "https://localhost:6333";
  const apiKey = flags.apiKey || process.env.QDRANT_API_KEY;
  const timeout = flags.timeout || parseInt(process.env.QDRANT_TIMEOUT || "30000", 10);
  const acceptSelfSigned = !flags.strict; // Default to accepting self-signed certs for development

  console.log(fmt.info(`Connecting to Qdrant at ${COLOR.cyan}${endpoint}${COLOR.reset}${apiKey ? ' (with API key)' : ''}${acceptSelfSigned ? ' (accepting self-signed certs)' : ' (strict TLS)'}`));

  const clientConfig = {
    url: endpoint,
    timeout,
    checkCompatibility: false
  };

  if (apiKey) {
    clientConfig.apiKey = apiKey;
  }

  // Handle self-signed certificates for local development
  if (acceptSelfSigned && endpoint.startsWith('https://')) {
    // Set environment variable but suppress the warning
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = (warning, ...args) => {
      if (typeof warning === 'string' && warning.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
        return; // Suppress TLS warning for development
      }
      return originalEmitWarning.call(process, warning, ...args);
    };
    
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    
    // Also configure fetch agent as backup
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if (!init.agent && (typeof input === 'string' ? input.startsWith('https://') : input.url?.startsWith('https://'))) {
        init.agent = new https.Agent({
          rejectUnauthorized: false
        });
      }
      return originalFetch(input, init);
    };
  }

  return new QdrantClient(clientConfig);
}

// Initialize Qdrant client with error handling
const client = buildQdrantClient();

// ---------------------------------------------------------------------------
// SAMPLE DATASETS
// ---------------------------------------------------------------------------

/**
 * Generate curated sample datasets for testing different vector scenarios.
 * Each dataset includes vectors, payloads, and metadata appropriate for its domain.
 */
const DATASETS = {
  texts: {
    size: 384,
    distance: 'Cosine',
    description: 'Text document embeddings for similarity search',
    generate: (count = 50) => {
      const topics = [
        'artificial intelligence', 'machine learning', 'deep learning', 'neural networks',
        'natural language processing', 'computer vision', 'robotics', 'data science',
        'software engineering', 'web development', 'mobile applications', 'cloud computing',
        'cybersecurity', 'blockchain', 'cryptocurrency', 'quantum computing'
      ];
      
      const points = [];
      for (let i = 1; i <= count; i++) {
        const topic = topics[i % topics.length];
        const vector = generateTextEmbedding(topic, i);
        points.push({
          id: i,
          vector,
          payload: {
            text: `Document about ${topic} - sample ${i}`,
            topic,
            word_count: 100 + (i % 500),
            language: 'en',
            created_at: new Date(Date.now() - i * 86400000).toISOString()
          }
        });
      }
      return points;
    }
  },

  ecommerce: {
    size: 256,
    distance: 'Cosine',
    description: 'Product vectors with category and pricing metadata',
    generate: (count = 50) => {
      const categories = ['electronics', 'clothing', 'books', 'home', 'sports', 'beauty'];
      const brands = ['TechCorp', 'StyleMax', 'BookWorld', 'HomeEssentials', 'SportsPro', 'BeautyPlus'];
      
      const points = [];
      for (let i = 1; i <= count; i++) {
        const category = categories[i % categories.length];
        const brand = brands[i % brands.length];
        const price = 10 + (i % 200);
        const vector = generateProductEmbedding(category, brand, price, i);
        
        points.push({
          id: i,
          vector,
          payload: {
            name: `${brand} Product ${i}`,
            category,
            brand,
            price,
            rating: 1 + (i % 5),
            in_stock: i % 3 !== 0,
            description: `High-quality ${category} product from ${brand}`
          }
        });
      }
      return points;
    }
  },

  colors: {
    size: 3,
    distance: 'Euclid',
    description: 'RGB color vectors with semantic labels',
    generate: (count = 50) => {
      const colorNames = [
        'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'brown',
        'black', 'white', 'gray', 'cyan', 'magenta', 'lime', 'navy', 'maroon'
      ];
      
      const points = [];
      for (let i = 1; i <= count; i++) {
        const colorName = colorNames[i % colorNames.length];
        const vector = generateColorVector(colorName, i);
        const [r, g, b] = vector;
        
        points.push({
          id: i,
          vector,
          payload: {
            color_name: colorName,
            hex: `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`,
            rgb: { r: Math.round(r), g: Math.round(g), b: Math.round(b) },
            brightness: (r + g + b) / 3,
            warm: r + g > b * 1.5
          }
        });
      }
      return points;
    }
  },

  geospatial: {
    size: 2,
    distance: 'Euclid',
    description: 'Geographic coordinate vectors with location metadata',
    generate: (count = 50) => {
      const cities = [
        { name: 'New York', lat: 40.7128, lon: -74.0060, country: 'USA' },
        { name: 'London', lat: 51.5074, lon: -0.1278, country: 'UK' },
        { name: 'Tokyo', lat: 35.6762, lon: 139.6503, country: 'Japan' },
        { name: 'Paris', lat: 48.8566, lon: 2.3522, country: 'France' },
        { name: 'Sydney', lat: -33.8688, lon: 151.2093, country: 'Australia' }
      ];
      
      const points = [];
      for (let i = 1; i <= count; i++) {
        const baseCity = cities[i % cities.length];
        // Add some random variation around the base city
        const lat = baseCity.lat + (Math.random() - 0.5) * 2;
        const lon = baseCity.lon + (Math.random() - 0.5) * 2;
        const vector = [lat, lon];
        
        points.push({
          id: i,
          vector,
          payload: {
            place_name: `Location ${i} near ${baseCity.name}`,
            country: baseCity.country,
            latitude: lat,
            longitude: lon,
            timezone: baseCity.country === 'USA' ? 'EST' : 'UTC',
            population: Math.floor(Math.random() * 1000000)
          }
        });
      }
      return points;
    }
  }
};

/**
 * Generate a mock text embedding vector based on topic and seed.
 * Creates deterministic but varied vectors for consistent testing.
 * 
 * ALGORITHM EXPLANATION:
 * - Uses simple hash of input text combined with sinusoidal functions
 * - Different topics get different base patterns in the vector space
 * - Similar topics (with shared keywords) will have similar vectors
 * - Vectors are normalized to unit length for cosine similarity
 * 
 * In a real application, you'd use actual embedding models like:
 * - OpenAI text-embedding-ada-002
 * - Sentence-BERT models 
 * - BGE, E5, or other transformer-based embeddings
 */
function generateTextEmbedding(topic, seed) {
  const vector = [];
  const hash = simpleHash(topic + seed);
  
  for (let i = 0; i < 384; i++) {
    const value = Math.sin(hash + i * 0.1) * Math.cos(seed + i * 0.05);
    vector.push(value);
  }
  
  return normalizeVector(vector);
}

/**
 * Generate a product embedding based on category, brand, and price.
 * Creates semantically meaningful vectors for e-commerce scenarios.
 */
function generateProductEmbedding(category, brand, price, seed) {
  const vector = [];
  const categoryHash = simpleHash(category);
  const brandHash = simpleHash(brand);
  const priceComponent = Math.log(price + 1);
  
  for (let i = 0; i < 256; i++) {
    const value = Math.sin(categoryHash + i * 0.1) * Math.cos(brandHash + i * 0.05) + 
                  Math.sin(priceComponent + i * 0.02) * 0.1;
    vector.push(value);
  }
  
  return normalizeVector(vector);
}

/**
 * Generate RGB color vector with realistic color mappings.
 * Maps color names to approximate RGB values with variations.
 */
function generateColorVector(colorName, seed) {
  const colorMap = {
    red: [255, 0, 0], blue: [0, 0, 255], green: [0, 255, 0],
    yellow: [255, 255, 0], purple: [128, 0, 128], orange: [255, 165, 0],
    pink: [255, 192, 203], brown: [165, 42, 42], black: [0, 0, 0],
    white: [255, 255, 255], gray: [128, 128, 128], cyan: [0, 255, 255],
    magenta: [255, 0, 255], lime: [0, 255, 0], navy: [0, 0, 128], maroon: [128, 0, 0]
  };
  
  const baseColor = colorMap[colorName] || [128, 128, 128];
  // Add some variation based on seed
  const variation = 20;
  return baseColor.map(c => Math.max(0, Math.min(255, c + (seed % variation) - variation/2)));
}

/**
 * Simple hash function for consistent pseudo-random number generation.
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) / 1000000000; // Normalize to reasonable range
}

/**
 * Normalize vector to unit length for cosine similarity.
 */
function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return magnitude > 0 ? vector.map(val => val / magnitude) : vector;
}

/**
 * Generate a query vector with the specified dimensions.
 * Adapts the embedding algorithm to match the target collection's vector size.
 */
function generateQueryVector(query, dimensions) {
  if (dimensions === 384) {
    return generateTextEmbedding(query, 0);
  } else if (dimensions === 256) {
    return generateProductEmbedding(query, 'search', 0, 0).slice(0, 256);
  } else if (dimensions === 3) {
    // For color searches, try to map query to RGB
    const colorMap = {
      red: [255, 0, 0], blue: [0, 0, 255], green: [0, 255, 0],
      yellow: [255, 255, 0], purple: [128, 0, 128], orange: [255, 165, 0]
    };
    const lowercaseQuery = query.toLowerCase();
    for (const [colorName, rgb] of Object.entries(colorMap)) {
      if (lowercaseQuery.includes(colorName)) {
        return rgb;
      }
    }
    // Default to gray if no color found
    return [128, 128, 128];
  } else if (dimensions === 2) {
    // For geospatial, use simple coordinate mapping
    return [0, 0]; // Default coordinates
  } else {
    // Generic vector for custom dimensions
    const vector = [];
    const hash = simpleHash(query);
    for (let i = 0; i < dimensions; i++) {
      const value = Math.sin(hash + i * 0.1) * Math.cos(i * 0.05);
      vector.push(value);
    }
    return normalizeVector(vector);
  }
}

// ---------------------------------------------------------------------------
// CORE OPERATIONS
// ---------------------------------------------------------------------------

/**
 * List all collections with detailed metadata and configuration.
 * Displays collection count, vector dimensions, and distance metrics.
 * 
 * @returns {Promise<void>}
 */
async function listCollections() {
  console.log(fmt.info("Fetching collection list..."));
  
  const response = await client.getCollections();
  const collections = response.collections || [];
  
  if (collections.length === 0) {
    console.log(fmt.info("No collections found. Create one with --create <collection-name>"));
    return;
  }

  console.log(fmt.ok(`Found ${COLOR.yellow}${collections.length}${COLOR.reset} collection${collections.length === 1 ? '' : 's'}:`));
  console.log(); // Add spacing for readability
  
  // Display collections with detailed information
  for (const collection of collections) {
    try {
      const info = await client.getCollection(collection.name);
      const vectorsConfig = info.config?.params?.vectors || {};
      const pointsCount = info.points_count || 0;
      
      console.log(`  ${COLOR.cyan}${collection.name}${COLOR.reset}`);
      console.log(`    Points: ${COLOR.yellow}${pointsCount}${COLOR.reset}`);
      
      if (vectorsConfig.size) {
        console.log(`    Vectors: ${COLOR.dim}${vectorsConfig.size}D, ${vectorsConfig.distance || 'unknown'} distance${COLOR.reset}`);
      }
      
      console.log(`    Status: ${COLOR.green}${info.status || 'active'}${COLOR.reset}`);
    } catch (err) {
      console.log(`    ${COLOR.red}Error getting details: ${err.message}${COLOR.reset}`);
    }
    console.log(); // Spacing between collections
  }
}

/**
 * Create a new collection with specified vector configuration.
 * Supports custom vector dimensions and distance metrics.
 * 
 * @param {string} name - The collection name to create
 * @param {number} size - Vector dimension size
 * @param {string} distance - Distance metric (cosine, euclidean, dot)
 * @returns {Promise<void>}
 */
async function createCollection(name, size = 384, distance = 'Cosine') {
  if (!name) {
    console.error(fmt.err("--create requires a collection name"));
    console.log(`Example: ${COLOR.green}--create my-vectors --size 384 --distance cosine${COLOR.reset}`);
    process.exit(1);
  }

  // Validate distance metric
  const validDistances = ['Cosine', 'Euclid', 'Dot'];
  const normalizedDistance = distance.charAt(0).toUpperCase() + distance.slice(1).toLowerCase();
  // Map 'euclidean' input to 'Euclid' for Qdrant API
  const mappedDistance = normalizedDistance === 'Euclidean' ? 'Euclid' : normalizedDistance;
  
  if (!validDistances.includes(mappedDistance)) {
    console.error(fmt.err(`Invalid distance metric: ${distance}. Use: cosine, euclid, or dot`));
    process.exit(1);
  }

  console.log(fmt.info(`Creating collection ${COLOR.cyan}${name}${COLOR.reset} (${size}D, ${mappedDistance} distance)...`));
  
  try {
    await client.createCollection(name, {
      vectors: {
        size: size,
        distance: mappedDistance
      }
    });
    
    console.log(fmt.ok(`Successfully created collection ${COLOR.cyan}${name}${COLOR.reset}`));
    console.log(`  Vector dimensions: ${COLOR.yellow}${size}${COLOR.reset}`);
    console.log(`  Distance metric: ${COLOR.yellow}${mappedDistance}${COLOR.reset}`);
    console.log(`  Insert points using: ${COLOR.green}--insert --collection ${name} --dataset <dataset>${COLOR.reset}`);
  } catch (err) {
    if (err.message && err.message.includes('already exists')) {
      console.log(fmt.warn(`Collection ${COLOR.cyan}${name}${COLOR.reset} already exists`));
    } else {
      throw err; // Re-throw unexpected errors for proper error handling
    }
  }
}

/**
 * Create a collection with sample data from built-in datasets.
 * Combines collection creation with immediate data population.
 * 
 * @param {string} name - The collection name to create
 * @param {string} datasetName - Built-in dataset to use
 * @returns {Promise<void>}
 */
async function createSampleCollection(name, datasetName = 'texts') {
  if (!name) {
    console.error(fmt.err("--create-sample requires a collection name"));
    console.log(`Example: ${COLOR.green}--create-sample my-vectors --dataset texts${COLOR.reset}`);
    process.exit(1);
  }

  const dataset = DATASETS[datasetName];
  if (!dataset) {
    console.error(fmt.err(`Unknown dataset: ${datasetName}`));
    console.log(`Available datasets: ${Object.keys(DATASETS).map(d => COLOR.cyan + d + COLOR.reset).join(', ')}`);
    process.exit(1);
  }

  console.log(fmt.info(`Creating collection ${COLOR.cyan}${name}${COLOR.reset} with ${COLOR.yellow}${datasetName}${COLOR.reset} dataset...`));
  
  // Create collection first
  await createCollection(name, dataset.size, dataset.distance);
  
  // Insert sample data
  const sampleCount = flags.count || 50;
  await insertPoints(name, datasetName, sampleCount);
}

/**
 * Insert points into an existing collection using built-in datasets.
 * Generates appropriate vectors and payload based on dataset type.
 * 
 * @param {string} collectionName - Target collection name
 * @param {string} datasetName - Built-in dataset to use
 * @param {number} count - Number of points to insert
 * @returns {Promise<void>}
 */
async function insertPoints(collectionName, datasetName = 'texts', count = 50) {
  if (!collectionName) {
    console.error(fmt.err("--insert requires --collection parameter"));
    console.log(`Example: ${COLOR.green}--insert --collection my-vectors --dataset texts --count 100${COLOR.reset}`);
    process.exit(1);
  }

  const dataset = DATASETS[datasetName];
  if (!dataset) {
    console.error(fmt.err(`Unknown dataset: ${datasetName}`));
    console.log(`Available datasets: ${Object.keys(DATASETS).map(d => COLOR.cyan + d + COLOR.reset).join(', ')}`);
    process.exit(1);
  }

  console.log(fmt.vector(`Generating ${COLOR.yellow}${count}${COLOR.reset} points from ${COLOR.cyan}${datasetName}${COLOR.reset} dataset...`));
  console.log(fmt.info(`Dataset: ${dataset.description}`));
  
  const points = dataset.generate(count);
  
  console.log(fmt.vector(`Inserting points into collection ${COLOR.cyan}${collectionName}${COLOR.reset}...`));
  
  // Insert points in batches for better performance
  const batchSize = 50;
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    await client.upsert(collectionName, {
      wait: true,
      points: batch
    });
    
    console.log(fmt.info(`Inserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(points.length / batchSize)} (${batch.length} points)`));
  }
  
  console.log(fmt.ok(`Successfully inserted ${COLOR.yellow}${points.length}${COLOR.reset} points into ${COLOR.cyan}${collectionName}${COLOR.reset}`));
  console.log(`  Search using: ${COLOR.green}--search "query text" --collection ${collectionName}${COLOR.reset}`);
}

/**
 * Search for similar vectors using text query.
 * Generates a query vector and finds similar points with optional filtering.
 * 
 * HOW VECTOR SEARCH WORKS:
 * 1. Text → Vector: The query text is converted to a numerical vector using the same 
 *    algorithm that was used to encode the stored documents
 * 2. Similarity Calculation: Qdrant computes cosine similarity between the query vector 
 *    and all stored vectors in the collection
 * 3. Ranking: Results are ranked by similarity score (1.0 = identical, 0.0 = opposite)
 * 4. Filtering: Optional payload filters are applied to narrow results
 * 
 * The mock text embedding function creates deterministic vectors based on topic keywords,
 * so documents with similar topics will have similar vectors and higher similarity scores.
 * 
 * @param {string} query - Text query to search for
 * @param {string} collectionName - Target collection name
 * @param {number} limit - Number of results to return
 * @param {string} filter - Optional filter expression
 * @param {number} threshold - Optional similarity threshold
 * @returns {Promise<void>}
 */
async function searchVectors(query, collectionName, limit = 10, filter = null, threshold = null) {
  if (!collectionName) {
    console.error(fmt.err("--search requires --collection parameter"));
    console.log(`Example: ${COLOR.green}--search "machine learning" --collection documents --limit 5${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.search(`Searching for "${COLOR.yellow}${query}${COLOR.reset}" in collection ${COLOR.cyan}${collectionName}${COLOR.reset}...`));
  
  // Get collection info to determine vector dimensions
  console.log(fmt.info(`Getting collection configuration...`));
  const collectionInfo = await client.getCollection(collectionName);
  const vectorConfig = collectionInfo.config?.params?.vectors;
  const vectorSize = vectorConfig?.size || 384;
  
  // Generate query vector with matching dimensions
  console.log(fmt.info(`Generating vector representation of query text...`));
  const queryVector = generateQueryVector(query, vectorSize);
  console.log(fmt.vector(`Query vector: [${queryVector.slice(0, 5).map(v => v.toFixed(3)).join(', ')}...] (${queryVector.length}D)`));
  
  const searchParams = {
    vector: queryVector,
    limit,
    with_payload: true,
    with_vector: false
  };

  if (threshold !== null) {
    searchParams.score_threshold = threshold;
  }

  if (filter) {
    searchParams.filter = parseFilter(filter);
  }
  
  console.log(fmt.info(`Computing cosine similarity with all vectors in collection...`));
  const results = await client.search(collectionName, searchParams);
  
  if (results.length === 0) {
    console.log(fmt.warn(`No results found for query "${query}"`));
    return;
  }

  console.log(fmt.ok(`Found ${COLOR.yellow}${results.length}${COLOR.reset} results (ranked by cosine similarity, 1.0 = identical):`));
  console.log();

  results.forEach((result, index) => {
    const score = result.score?.toFixed(4) || 'N/A';
    console.log(`${COLOR.yellow}${index + 1}.${COLOR.reset} ID: ${COLOR.cyan}${result.id}${COLOR.reset} (Score: ${COLOR.green}${score}${COLOR.reset})`);
    
    if (result.payload) {
      // Display key payload fields in a readable format
      Object.entries(result.payload).slice(0, 3).forEach(([key, value]) => {
        const displayValue = typeof value === 'string' && value.length > 50 
          ? value.substring(0, 50) + '...' 
          : value;
        console.log(`   ${key}: ${COLOR.dim}${displayValue}${COLOR.reset}`);
      });
    }
    console.log();
  });
}

/**
 * Search using an existing point as the query vector.
 * Retrieves the vector from the specified point and finds similar vectors.
 * 
 * @param {number} pointId - ID of the point to use as query
 * @param {string} collectionName - Target collection name
 * @param {number} limit - Number of results to return
 * @param {string} filter - Optional filter expression
 * @returns {Promise<void>}
 */
async function searchById(pointId, collectionName, limit = 10, filter = null) {
  if (!collectionName) {
    console.error(fmt.err("--search-id requires --collection parameter"));
    console.log(`Example: ${COLOR.green}--search-id 42 --collection documents --limit 5${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.search(`Searching for vectors similar to point ${COLOR.yellow}${pointId}${COLOR.reset} in collection ${COLOR.cyan}${collectionName}${COLOR.reset}...`));
  
  // First, get the point to use its vector as query
  const points = await client.retrieve(collectionName, { ids: [pointId], with_vector: true });
  
  if (points.length === 0) {
    console.error(fmt.err(`Point with ID ${pointId} not found in collection ${collectionName}`));
    return;
  }

  const queryPoint = points[0];
  const queryVector = queryPoint.vector;

  const searchParams = {
    vector: queryVector,
    limit: limit + 1, // +1 to exclude the query point itself
    with_payload: true,
    with_vector: false
  };

  if (filter) {
    searchParams.filter = parseFilter(filter);
  }
  
  const results = await client.search(collectionName, searchParams);
  
  // Filter out the query point itself from results
  const filteredResults = results.filter(result => result.id !== pointId);
  
  if (filteredResults.length === 0) {
    console.log(fmt.warn(`No similar points found for point ${pointId}`));
    return;
  }

  console.log(fmt.ok(`Found ${COLOR.yellow}${filteredResults.length}${COLOR.reset} similar points:`));
  console.log(`Query point: ID ${COLOR.cyan}${pointId}${COLOR.reset}`);
  if (queryPoint.payload) {
    const firstPayloadEntry = Object.entries(queryPoint.payload)[0];
    if (firstPayloadEntry) {
      console.log(`  ${firstPayloadEntry[0]}: ${COLOR.dim}${firstPayloadEntry[1]}${COLOR.reset}`);
    }
  }
  console.log();

  filteredResults.slice(0, limit).forEach((result, index) => {
    const score = result.score?.toFixed(4) || 'N/A';
    console.log(`${COLOR.yellow}${index + 1}.${COLOR.reset} ID: ${COLOR.cyan}${result.id}${COLOR.reset} (Score: ${COLOR.green}${score}${COLOR.reset})`);
    
    if (result.payload) {
      Object.entries(result.payload).slice(0, 3).forEach(([key, value]) => {
        const displayValue = typeof value === 'string' && value.length > 50 
          ? value.substring(0, 50) + '...' 
          : value;
        console.log(`   ${key}: ${COLOR.dim}${displayValue}${COLOR.reset}`);
      });
    }
    console.log();
  });
}

/**
 * Get a specific point by ID with full details.
 * Retrieves vector, payload, and metadata for the specified point.
 * 
 * @param {number} pointId - ID of the point to retrieve
 * @param {string} collectionName - Target collection name
 * @returns {Promise<void>}
 */
async function getPoint(pointId, collectionName) {
  if (!collectionName) {
    console.error(fmt.err("--get requires --collection parameter"));
    console.log(`Example: ${COLOR.green}--get 42 --collection documents${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.info(`Retrieving point ${COLOR.yellow}${pointId}${COLOR.reset} from collection ${COLOR.cyan}${collectionName}${COLOR.reset}...`));
  
  const points = await client.retrieve(collectionName, { 
    ids: [pointId], 
    with_vector: true, 
    with_payload: true 
  });
  
  if (points.length === 0) {
    console.error(fmt.err(`Point with ID ${pointId} not found in collection ${collectionName}`));
    return;
  }

  const point = points[0];
  
  console.log(fmt.ok(`Point details:`));
  console.log(`┌─ Point ID: ${COLOR.cyan}${point.id}${COLOR.reset}`);
  
  if (point.vector) {
    const vectorPreview = Array.isArray(point.vector) 
      ? `[${point.vector.slice(0, 5).map(v => v.toFixed(3)).join(', ')}...]`
      : 'Complex vector structure';
    console.log(`├─ Vector: ${COLOR.dim}${vectorPreview} (${Array.isArray(point.vector) ? point.vector.length : '?'} dimensions)${COLOR.reset}`);
  }
  
  if (point.payload && Object.keys(point.payload).length > 0) {
    console.log(`└─ Payload:`);
    Object.entries(point.payload).forEach(([key, value], index, arr) => {
      const isLast = index === arr.length - 1;
      const prefix = isLast ? '   └─' : '   ├─';
      const displayValue = typeof value === 'object' 
        ? JSON.stringify(value) 
        : value;
      console.log(`${prefix} ${key}: ${COLOR.yellow}${displayValue}${COLOR.reset}`);
    });
  } else {
    console.log(`└─ Payload: ${COLOR.dim}(empty)${COLOR.reset}`);
  }
}

/**
 * Delete a specific point by ID with confirmation.
 * Provides clear feedback about the deletion operation.
 * 
 * @param {number} pointId - ID of the point to delete
 * @param {string} collectionName - Target collection name
 * @returns {Promise<void>}
 */
async function deletePoint(pointId, collectionName) {
  if (!collectionName) {
    console.error(fmt.err("--delete requires --collection parameter"));
    console.log(`Example: ${COLOR.green}--delete 42 --collection documents${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.warn(`Deleting point ${COLOR.yellow}${pointId}${COLOR.reset} from collection ${COLOR.cyan}${collectionName}${COLOR.reset}...`));

  await client.delete(collectionName, {
    wait: true,
    points: [pointId]
  });

  console.log(fmt.ok(`Successfully deleted point ${COLOR.yellow}${pointId}${COLOR.reset} from ${COLOR.cyan}${collectionName}${COLOR.reset}`));
  console.log(`  ${COLOR.dim}This operation cannot be undone${COLOR.reset}`);
}

/**
 * Delete an entire collection with confirmation.
 * Provides clear feedback and warnings about the irreversible operation.
 * 
 * @param {string} collectionName - The collection name to delete
 * @returns {Promise<void>}
 */
async function deleteCollection(collectionName) {
  if (!collectionName) {
    console.error(fmt.err("--delete-collection requires a collection name"));
    console.log(`Example: ${COLOR.green}--delete-collection old-vectors${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.warn(`Deleting collection ${COLOR.cyan}${collectionName}${COLOR.reset}...`));
  
  try {
    await client.deleteCollection(collectionName);
    console.log(fmt.ok(`Successfully deleted collection ${COLOR.cyan}${collectionName}${COLOR.reset}`));
    console.log(`  ${COLOR.dim}This operation cannot be undone${COLOR.reset}`);
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      console.log(fmt.warn(`Collection ${COLOR.cyan}${collectionName}${COLOR.reset} does not exist`));
    } else {
      throw err; // Re-throw unexpected errors for proper error handling
    }
  }
}

// ---------------------------------------------------------------------------
// UTILITY FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Parse simple filter expressions into Qdrant filter format.
 * Supports basic key:value and key:<value operations.
 * 
 * @param {string} filterStr - Filter expression string
 * @returns {Object} Qdrant filter object
 */
function parseFilter(filterStr) {
  try {
    // Simple parser for common filter patterns
    if (filterStr.includes(':')) {
      const [key, value] = filterStr.split(':');
      
      if (value.startsWith('<')) {
        const numValue = parseFloat(value.substring(1));
        return {
          must: [{
            key: key.trim(),
            range: { lt: numValue }
          }]
        };
      } else if (value.startsWith('>')) {
        const numValue = parseFloat(value.substring(1));
        return {
          must: [{
            key: key.trim(),
            range: { gt: numValue }
          }]
        };
      } else {
        // Exact match
        return {
          must: [{
            key: key.trim(),
            match: { value: value.trim() }
          }]
        };
      }
    }
    
    // If no colon, treat as exact match on a default field
    return {
      must: [{
        key: 'category',
        match: { value: filterStr.trim() }
      }]
    };
  } catch (err) {
    console.log(fmt.warn(`Invalid filter expression: ${filterStr}. Using no filter.`));
    return null;
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
    if (flags.list) await listCollections();
    if (flags.create) await createCollection(flags.create, flags.size, flags.distance);
    if (flags.createSample) await createSampleCollection(flags.createSample, flags.dataset);
    if (flags.insert) await insertPoints(flags.collection, flags.dataset, flags.count);
    if (flags.search) await searchVectors(flags.search, flags.collection, flags.limit, flags.filter, flags.threshold);
    if (flags.searchId !== undefined) await searchById(flags.searchId, flags.collection, flags.limit, flags.filter);
    if (flags.get !== undefined) await getPoint(flags.get, flags.collection);
    if (flags.delete !== undefined) await deletePoint(flags.delete, flags.collection);
    if (flags.deleteCollection) await deleteCollection(flags.deleteCollection);
    
  } catch (err) {
    // Handle different types of errors with appropriate messaging
    if (err.message && err.message.includes('not found')) {
      console.error(fmt.err(`Resource not found: ${err.message}`));
      console.log(`  Use ${COLOR.green}--list${COLOR.reset} to see available collections`);
    } else if (err.message && err.message.includes('connect')) {
      console.error(fmt.err("Cannot connect to Qdrant server"));
      console.log(`  Verify Qdrant is running at: ${COLOR.cyan}${flags.endpoint || process.env.QDRANT_URL_EXTERNAL || 'https://localhost:6333'}${COLOR.reset}`);
      console.log(`  For TLS issues, try: ${COLOR.green}--strict${COLOR.reset} for valid certs or ensure self-signed certs are accepted`);
      console.log(`  Start Qdrant with: ${COLOR.green}docker run -p 6333:6333 qdrant/qdrant${COLOR.reset}`);
    } else if (err.message && err.message.includes('timeout')) {
      console.error(fmt.err("Request timeout"));
      console.log(`  Try increasing timeout with: ${COLOR.green}--timeout 60000${COLOR.reset}`);
    } else {
      // Generic error handling for unexpected issues
      console.error(fmt.err(`Operation failed: ${err.message}`));
      console.log(`  ${COLOR.dim}Use --help for usage information${COLOR.reset}`);
    }
    process.exit(1);
  }
})(); 