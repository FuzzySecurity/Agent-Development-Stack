#!/usr/bin/env node
/**
 * AI-Agent MinIO CLI Utility
 * ---------------------------
 * A single-file helper (ES-module) for interacting with the local MinIO instance
 * used by the AI-Agent stack for S3-compatible object storage operations. Features:
 *   • List buckets and objects with detailed metadata
 *   • Upload files with automatic key generation or custom naming
 *   • Download objects to file or stdout with progress indication
 *   • Create and manage bucket lifecycle
 *   • Delete objects with confirmation feedback
 *   • Accept self-signed certificates by default for local development
 *
 * Quick Examples
 * --------------
 *  # List all buckets
 *  node unittest/minio.js --list
 *
 *  # Create a new bucket for agent artifacts
 *  node unittest/minio.js --create agent-artifacts
 *
 *  # Delete an empty bucket
 *  node unittest/minio.js --delete-bucket old-artifacts
 *
 *  # Upload a configuration file (key auto-generated from filename)
 *  node unittest/minio.js --upload ./config.json --bucket agent-artifacts
 *
 *  # Upload with custom key name
 *  node unittest/minio.js --upload ./data.csv --bucket datasets --key "processed/data-v2.csv"
 *
 *  # List all objects in a bucket with size information
 *  node unittest/minio.js --objects --bucket agent-artifacts
 *
 *  # Download with automatic filename (saves as config.json)
 *  node unittest/minio.js --download config.json --bucket agent-artifacts
 *
 *  # Download to a specific file path
 *  node unittest/minio.js --download config.json --bucket agent-artifacts -o ./config-backup.json
 *
 *  # Delete an object permanently
 *  node unittest/minio.js --delete old-data.json --bucket agent-artifacts
 *
 *  # Connect to a different MinIO instance
 *  node unittest/minio.js --list -e https://minio.example.com:9000
 *
 *  # Enforce valid TLS certificates (disable self-signed default)
 *  node unittest/minio.js --list --strict
 *
 * Environment
 * -----------
 * The script reads the sibling "../.env" file (if present) and populates any
 * MINIO_* variables not already in the environment. Required variables:
*   MINIO_ROOT_USER - MinIO access key (equivalent to AWS Access Key ID)
*   MINIO_ROOT_PASSWORD - MinIO secret key (equivalent to AWS Secret Access Key)
*   MINIO_URL_EXTERNAL - Optional custom endpoint (default: https://localhost:9000)
 *
 * Security Notes
 * --------------
 * • By default, accepts self-signed certificates for local development
 * • Use --strict flag to enforce valid TLS certificates in production
 * • Credentials are read from environment variables only (never hardcoded)
 * • Uses AWS SDK v3 with proper HTTPS agent configuration
 *
 * Built-in Modes (see --help for full list):
 *   --list                 List all buckets
 *   --objects --bucket     List objects in a bucket
 *   --create <bucket>      Create a new bucket
 *   --delete-bucket <name> Delete an empty bucket
 *   --upload <file>        Upload a file to MinIO
 *   --download <key>       Download an object from MinIO
 *   --delete <key>         Delete an object from MinIO
 */

import { readFileSync, createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, ListBucketsCommand, CreateBucketCommand, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import https from "node:https";

// ---------------------------------------------------------------------------
// Environment loader (shared with kafka CLI)
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
  magenta: "\x1b[35m"
};

const fmt = {
  ok: (msg) => `${COLOR.green}✔${COLOR.reset} ${msg}`,
  info: (msg) => `${COLOR.cyan}ℹ${COLOR.reset} ${msg}`,
  warn: (msg) => `${COLOR.yellow}⚠${COLOR.reset} ${msg}`,
  err: (msg) => `${COLOR.red}✖${COLOR.reset} ${msg}`,
  upload: (msg) => `${COLOR.magenta}↗${COLOR.reset} ${msg}`,
  download: (msg) => `${COLOR.cyan}↙${COLOR.reset} ${msg}`
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
${COLOR.cyan}MinIO CLI Test Tool${COLOR.reset}
${COLOR.dim}═══════════════════════${COLOR.reset}
Professional utility for interacting with MinIO S3-compatible object storage.

 ${COLOR.yellow}MODES${COLOR.reset} (choose one)
   ${COLOR.green}--list${COLOR.reset}                     List all buckets with creation dates
   ${COLOR.green}--objects${COLOR.reset}                  List objects in a bucket (requires --bucket)
   ${COLOR.green}--create <bucket>${COLOR.reset}          Create a new bucket with the specified name
   ${COLOR.green}--delete-bucket <bucket>${COLOR.reset}   Delete an empty bucket permanently
   ${COLOR.green}--upload <file>${COLOR.reset}            Upload file to bucket (requires --bucket)
   ${COLOR.green}--download <key>${COLOR.reset}           Download object from bucket (requires --bucket)
   ${COLOR.green}--delete <key>${COLOR.reset}             Delete object from bucket (requires --bucket)

${COLOR.yellow}COMMON OPTIONS${COLOR.reset}
  ${COLOR.cyan}--bucket <name>${COLOR.reset}            Target bucket for object operations
  ${COLOR.cyan}-e, --endpoint <url>${COLOR.reset}       Override MinIO endpoint (default: https://localhost:9000)
  ${COLOR.cyan}--strict${COLOR.reset}                   Require valid TLS certificates (reject self-signed)
  ${COLOR.cyan}-h, --help${COLOR.reset}                 Show this comprehensive help message

${COLOR.yellow}UPLOAD OPTIONS${COLOR.reset}
  ${COLOR.cyan}--key <name>${COLOR.reset}               Custom object key (defaults to filename)

 ${COLOR.yellow}DOWNLOAD OPTIONS${COLOR.reset}
   ${COLOR.cyan}-o <path>${COLOR.reset}                  Output file path (defaults to object key name)

${COLOR.yellow}EXAMPLES${COLOR.reset}
  List all buckets:
    ${COLOR.dim}node unittest/minio.js --list${COLOR.reset}

     Create bucket for agent data:
     ${COLOR.dim}node unittest/minio.js --create agent-data${COLOR.reset}

   Delete an empty bucket:
     ${COLOR.dim}node unittest/minio.js --delete-bucket old-bucket${COLOR.reset}

   Upload configuration with auto-generated key:
    ${COLOR.dim}node unittest/minio.js --upload config.json --bucket agent-data${COLOR.reset}

  Upload with custom key structure:
    ${COLOR.dim}node unittest/minio.js --upload data.csv --bucket datasets --key "2024/january/processed.csv"${COLOR.reset}

  List objects with size information:
    ${COLOR.dim}node unittest/minio.js --objects --bucket agent-data${COLOR.reset}

     Download with automatic filename (saves as config.json):
     ${COLOR.dim}node unittest/minio.js --download config.json --bucket agent-data${COLOR.reset}

   Download to specific file:
     ${COLOR.dim}node unittest/minio.js --download config.json --bucket agent-data -o ./backup.json${COLOR.reset}

  Delete an object permanently:
    ${COLOR.dim}node unittest/minio.js --delete old-config.json --bucket agent-data${COLOR.reset}

  Connect to remote MinIO instance:
    ${COLOR.dim}node unittest/minio.js --list -e https://minio.production.com:9000${COLOR.reset}

${COLOR.yellow}SECURITY${COLOR.reset}
  ${COLOR.dim}• Accepts self-signed certificates by default for local development${COLOR.reset}
  ${COLOR.dim}• Use --strict to enforce certificate validation for production${COLOR.reset}
  ${COLOR.dim}• Credentials loaded from MINIO_ROOT_USER and MINIO_ROOT_PASSWORD${COLOR.reset}
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
    case "--objects":
      flags.objects = true;
      break;
         case "--create":
       flags.create = args[++i];
       break;
     case "--delete-bucket":
       flags.deleteBucket = args[++i];
       break;
     case "--upload":
      flags.upload = args[++i];
      break;
    case "--download":
      flags.download = args[++i];
      break;
    case "--delete":
      flags.delete = args[++i];
      break;
    case "--bucket":
      flags.bucket = args[++i];
      break;
    case "-e":
    case "--endpoint":
      flags.endpoint = args[++i];
      break;
    case "--key":
      flags.key = args[++i];
      break;
    case "--strict":
      flags.strict = true;
      break;
    case "-o":
      flags.out = args[++i];
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
// S3 CLIENT BUILDER
// ---------------------------------------------------------------------------

/**
 * Build and configure S3 client with proper TLS handling for MinIO.
 * Supports both strict TLS validation and self-signed certificate acceptance.
 * 
 * @returns {S3Client} Configured S3 client ready for MinIO operations
 * @throws {Error} If required credentials are missing from environment
 */
function buildS3Client() {
  // Validate required environment variables
  const user = process.env.MINIO_ROOT_USER;
  const pass = process.env.MINIO_ROOT_PASSWORD;
  
  if (!user || !pass) {
    console.error(fmt.err("Missing required MinIO credentials"));
    console.error(`  Set ${COLOR.yellow}MINIO_ROOT_USER${COLOR.reset} and ${COLOR.yellow}MINIO_ROOT_PASSWORD${COLOR.reset} in environment`);
    process.exit(1);
  }

  // Determine endpoint with fallback chain
  const endpoint = flags.endpoint || process.env.MINIO_URL_EXTERNAL || "https://localhost:9000";
  const acceptSelfSigned = !flags.strict; // Default to accepting self-signed certs for development

  console.log(fmt.info(`Connecting to MinIO at ${COLOR.cyan}${endpoint}${COLOR.reset}${acceptSelfSigned ? ' (accepting self-signed certs)' : ' (strict TLS)'}`));

  const clientConfig = {
    endpoint,
    region: "us-east-1", // MinIO requires a region, but the value is arbitrary
    credentials: { 
      accessKeyId: user, 
      secretAccessKey: pass 
    },
    forcePathStyle: true, // Required for MinIO compatibility (bucket in path, not subdomain)
  };

  // Configure custom HTTPS agent for self-signed certificate support
  if (acceptSelfSigned) {
    const agent = new https.Agent({
      rejectUnauthorized: false // Allow self-signed certificates
    });
    
    // Use NodeHttpHandler with custom agent to avoid global TLS warnings
    clientConfig.requestHandler = new NodeHttpHandler({
      httpsAgent: agent
    });
  }

  return new S3Client(clientConfig);
}

// Initialize S3 client with error handling
const s3 = buildS3Client();

// ---------------------------------------------------------------------------
// CORE OPERATIONS
// ---------------------------------------------------------------------------

/**
 * List all buckets with creation metadata and formatting.
 * Displays bucket count summary and individual bucket details.
 * 
 * @returns {Promise<void>}
 */
async function listBuckets() {
  console.log(fmt.info("Fetching bucket list..."));
  
  const { Buckets } = await s3.send(new ListBucketsCommand({}));
  
  if (!Buckets || Buckets.length === 0) {
    console.log(fmt.info("No buckets found. Create one with --create <bucket-name>"));
    return;
  }

  console.log(fmt.ok(`Found ${COLOR.yellow}${Buckets.length}${COLOR.reset} bucket${Buckets.length === 1 ? '' : 's'}:`));
  console.log(); // Add spacing for readability
  
  // Display buckets with creation dates
  for (const bucket of Buckets) {
    const createdDate = bucket.CreationDate ? bucket.CreationDate.toISOString().split('T')[0] : 'unknown';
    console.log(`  ${COLOR.cyan}${bucket.Name}${COLOR.reset} ${COLOR.dim}(created ${createdDate})${COLOR.reset}`);
  }
}

/**
 * Create a new bucket with the specified name.
 * Handles bucket naming validation and duplicate detection.
 * 
 * @param {string} name - The bucket name to create
 * @returns {Promise<void>}
 * @throws {Error} If bucket name is invalid or already exists
 */
async function createBucket(name) {
  if (!name) {
    console.error(fmt.err("--create requires a bucket name"));
    console.log(`Example: ${COLOR.green}--create my-bucket${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.info(`Creating bucket ${COLOR.cyan}${name}${COLOR.reset}...`));
  
  try {
    await s3.send(new CreateBucketCommand({ Bucket: name }));
    console.log(fmt.ok(`Successfully created bucket ${COLOR.cyan}${name}${COLOR.reset}`));
    console.log(`  You can now upload objects using: ${COLOR.green}--upload <file> --bucket ${name}${COLOR.reset}`);
  } catch (err) {
    if (err.name === "BucketAlreadyOwnedByYou" || err.name === "BucketAlreadyExists") {
      console.log(fmt.warn(`Bucket ${COLOR.cyan}${name}${COLOR.reset} already exists and is accessible`));
    } else {
      throw err; // Re-throw unexpected errors for proper error handling
    }
  }
}

/**
 * Delete an empty bucket with the specified name.
 * Provides clear feedback and warnings about the irreversible operation.
 * 
 * @param {string} name - The bucket name to delete
 * @returns {Promise<void>}
 * @throws {Error} If bucket doesn't exist, is not empty, or deletion fails
 */
async function deleteBucket(name) {
  if (!name) {
    console.error(fmt.err("--delete-bucket requires a bucket name"));
    console.log(`Example: ${COLOR.green}--delete-bucket old-bucket${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.warn(`Deleting bucket ${COLOR.cyan}${name}${COLOR.reset}...`));
  
  try {
    await s3.send(new DeleteBucketCommand({ Bucket: name }));
    console.log(fmt.ok(`Successfully deleted bucket ${COLOR.cyan}${name}${COLOR.reset}`));
    console.log(`  ${COLOR.dim}This operation cannot be undone${COLOR.reset}`);
  } catch (err) {
    if (err.name === "NoSuchBucket") {
      console.log(fmt.warn(`Bucket ${COLOR.cyan}${name}${COLOR.reset} does not exist`));
    } else if (err.name === "BucketNotEmpty") {
      console.error(fmt.err(`Bucket ${COLOR.cyan}${name}${COLOR.reset} is not empty`));
      console.log(`  Delete all objects first using: ${COLOR.green}--objects --bucket ${name}${COLOR.reset} (to list)`);
      console.log(`  Then delete each object using: ${COLOR.green}--delete <key> --bucket ${name}${COLOR.reset}`);
      process.exit(1);
    } else {
      throw err; // Re-throw unexpected errors for proper error handling
    }
  }
}

/**
 * List all objects in the specified bucket with size and metadata.
 * Provides detailed object information including size formatting.
 * 
 * @param {string} bucket - The bucket name to list objects from
 * @returns {Promise<void>}
 * @throws {Error} If bucket doesn't exist or is inaccessible
 */
async function listObjects(bucket) {
  if (!bucket) {
    console.error(fmt.err("--objects requires --bucket parameter"));
    console.log(`Example: ${COLOR.green}--objects --bucket my-bucket${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.info(`Listing objects in bucket ${COLOR.cyan}${bucket}${COLOR.reset}...`));
  
  const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  
  if (!Contents || Contents.length === 0) {
    console.log(fmt.info(`Bucket ${COLOR.cyan}${bucket}${COLOR.reset} is empty`));
    console.log(`  Upload files using: ${COLOR.green}--upload <file> --bucket ${bucket}${COLOR.reset}`);
    return;
  }

  console.log(fmt.ok(`Found ${COLOR.yellow}${Contents.length}${COLOR.reset} object${Contents.length === 1 ? '' : 's'} in ${COLOR.cyan}${bucket}${COLOR.reset}:`));
  console.log();

  // Sort by key name for consistent display
  const sortedObjects = Contents.sort((a, b) => (a.Key || '').localeCompare(b.Key || ''));
  
  for (const obj of sortedObjects) {
    const size = formatBytes(obj.Size || 0);
    const modified = obj.LastModified ? obj.LastModified.toISOString().split('T')[0] : 'unknown';
    console.log(`  ${COLOR.yellow}${obj.Key}${COLOR.reset} ${COLOR.dim}(${size}, modified ${modified})${COLOR.reset}`);
  }
}

/**
 * Upload a file to the specified bucket with progress feedback.
 * Automatically generates object key from filename unless overridden.
 * 
 * @param {string} filePath - Local file path to upload
 * @param {string} bucket - Target bucket name
 * @param {string|null} key - Optional custom object key (defaults to filename)
 * @returns {Promise<void>}
 * @throws {Error} If file doesn't exist or upload fails
 */
async function uploadFile(filePath, bucket, key) {
  // Validate required parameters
  if (!bucket || !filePath) {
    console.error(fmt.err("--upload requires both a file path and --bucket parameter"));
    console.log(`Example: ${COLOR.green}--upload ./data.json --bucket my-bucket${COLOR.reset}`);
    process.exit(1);
  }

  // Check file existence
  if (!existsSync(filePath)) {
    console.error(fmt.err(`File not found: ${COLOR.yellow}${filePath}${COLOR.reset}`));
    console.log("  Verify the file path and try again");
    process.exit(1);
  }

  // Generate key from filename if not provided
  key = key || path.basename(filePath);
  
  console.log(fmt.upload(`Uploading ${COLOR.yellow}${filePath}${COLOR.reset} → ${COLOR.cyan}${bucket}/${key}${COLOR.reset}...`));

  // Create readable stream for efficient upload
  const body = createReadStream(filePath);
  
  await s3.send(new PutObjectCommand({ 
    Bucket: bucket, 
    Key: key, 
    Body: body 
  }));

  console.log(fmt.ok(`Successfully uploaded to ${COLOR.cyan}${bucket}/${key}${COLOR.reset}`));
  console.log(`  Download using: ${COLOR.green}--download ${key} --bucket ${bucket}${COLOR.reset}`);
}

/**
 * Download an object from the specified bucket to file.
 * Automatically saves with the object key name unless output path is specified.
 * 
 * @param {string} key - Object key to download
 * @param {string} bucket - Source bucket name  
 * @param {string|null} outPath - Optional output file path (defaults to object key name)
 * @returns {Promise<void>}
 * @throws {Error} If object doesn't exist or download fails
 */
async function downloadObject(key, bucket, outPath) {
  // Validate required parameters
  if (!bucket || !key) {
    console.error(fmt.err("--download requires both an object key and --bucket parameter"));
    console.log(`Example: ${COLOR.green}--download config.json --bucket my-bucket${COLOR.reset}`);
    process.exit(1);
  }

  // Use object key as filename if no output path specified
  const outputFile = outPath || path.basename(key);
  console.log(fmt.download(`Downloading ${COLOR.cyan}${bucket}/${key}${COLOR.reset} → ${COLOR.yellow}${outputFile}${COLOR.reset}...`));

  const { Body } = await s3.send(new GetObjectCommand({ 
    Bucket: bucket, 
    Key: key 
  }));

  // Always download to file (either specified path or auto-generated filename)
  const writeStream = createWriteStream(outputFile);
  await Body.pipe(writeStream);
  console.log(fmt.ok(`Downloaded to ${COLOR.yellow}${outputFile}${COLOR.reset}`));
}

/**
 * Delete an object from the specified bucket with confirmation.
 * Provides clear feedback about the deletion operation.
 * 
 * @param {string} key - Object key to delete
 * @param {string} bucket - Source bucket name
 * @returns {Promise<void>}
 * @throws {Error} If object doesn't exist or deletion fails
 */
async function deleteObject(key, bucket) {
  // Validate required parameters
  if (!bucket || !key) {
    console.error(fmt.err("--delete requires both an object key and --bucket parameter"));
    console.log(`Example: ${COLOR.green}--delete old-file.json --bucket my-bucket${COLOR.reset}`);
    process.exit(1);
  }

  console.log(fmt.warn(`Deleting ${COLOR.cyan}${bucket}/${key}${COLOR.reset}...`));

  await s3.send(new DeleteObjectCommand({ 
    Bucket: bucket, 
    Key: key 
  }));

  console.log(fmt.ok(`Successfully deleted ${COLOR.cyan}${bucket}/${key}${COLOR.reset}`));
  console.log(`  ${COLOR.dim}This operation cannot be undone${COLOR.reset}`);
}

// ---------------------------------------------------------------------------
// UTILITY FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Format byte count into human-readable string with appropriate units.
 * Provides clear size representation for object listings.
 * 
 * @param {number} bytes - Raw byte count
 * @returns {string} Formatted size string (e.g., "1.5 KB", "2.3 MB")
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
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
    if (flags.list) await listBuckets();
    if (flags.create) await createBucket(flags.create);
    if (flags.deleteBucket) await deleteBucket(flags.deleteBucket);
    if (flags.objects) await listObjects(flags.bucket);
    if (flags.upload) await uploadFile(flags.upload, flags.bucket, flags.key);
    if (flags.download) await downloadObject(flags.download, flags.bucket, flags.out);
    if (flags.delete) await deleteObject(flags.delete, flags.bucket);
    
  } catch (err) {
    // Handle different types of errors with appropriate messaging
    if (err.name === 'NoSuchBucket') {
      console.error(fmt.err(`Bucket does not exist: ${COLOR.cyan}${flags.bucket}${COLOR.reset}`));
      console.log(`  Create it first using: ${COLOR.green}--create ${flags.bucket}${COLOR.reset}`);
    } else if (err.name === 'NoSuchKey') {
      console.error(fmt.err(`Object not found: ${COLOR.yellow}${flags.download || flags.delete}${COLOR.reset}`));
      console.log(`  List available objects using: ${COLOR.green}--objects --bucket ${flags.bucket}${COLOR.reset}`);
    } else if (err.code === 'ENOENT') {
      console.error(fmt.err(`File not found: ${COLOR.yellow}${flags.upload}${COLOR.reset}`));
    } else if (err.code === 'ECONNREFUSED') {
      console.error(fmt.err("Cannot connect to MinIO server"));
      console.log(`  Verify MinIO is running and endpoint is correct: ${COLOR.cyan}${flags.endpoint || process.env.MINIO_URL_EXTERNAL || 'https://localhost:9000'}${COLOR.reset}`);
    } else {
      // Generic error handling for unexpected issues
      console.error(fmt.err(`Operation failed: ${err.message}`));
      console.log(`  ${COLOR.dim}Use --help for usage information${COLOR.reset}`);
    }
    process.exit(1);
  }
})(); 