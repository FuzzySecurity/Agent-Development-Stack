import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * @fileoverview MinIO object storage client configuration and utility functions.
 * 
 * Provides S3-compatible operations for MinIO including file uploads, bucket management,
 * and presigned URL generation. Uses AWS SDK v3 with custom endpoint configuration.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CLIENT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const endpoint = process.env.MINIO_URL;
if (!endpoint) {
  throw new Error("MINIO_URL environment variable is required");
}

const accessKeyId = process.env.MINIO_ROOT_USER;
const secretAccessKey = process.env.MINIO_ROOT_PASSWORD;
if (!accessKeyId || !secretAccessKey) {
  throw new Error("MINIO_ROOT_USER and MINIO_ROOT_PASSWORD environment variables are required");
}

/**
 * Configured S3 client for MinIO operations.
 * 
 * Uses force path style for MinIO compatibility and configured with
 * credentials from environment variables.
 */
export const minioClient = new S3Client({
  credentials: { accessKeyId, secretAccessKey },
  endpoint,
  forcePathStyle: true,
  region: "us-east-1",
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BUCKET MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const ensuredBuckets = new Set<string>();

/**
 * Ensures a bucket exists, creating it if necessary.
 * Caches bucket existence to avoid redundant API calls.
 * 
 * @param bucket - Name of the bucket to ensure exists
 * @throws {Error} When bucket operations fail
 */
async function ensureBucketExists(bucket: string): Promise<void> {
  if (ensuredBuckets.has(bucket)) return;
  try {
    await minioClient.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await minioClient.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  ensuredBuckets.add(bucket);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OBJECT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Uploads an object to MinIO storage from memory.
 * 
 * @param bucket - Target bucket name
 * @param key - Object key (path/filename within bucket)
 * @param body - Object content as string, Buffer, or Uint8Array
 * @throws {Error} When upload operation fails
 */
export async function uploadObject(
  bucket: string,
  key: string,
  body: string | Uint8Array | Buffer
): Promise<void> {
  await ensureBucketExists(bucket);
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body });
  await minioClient.send(command);
}

/**
 * Uploads a file from the local filesystem to MinIO storage.
 * Uses the filename as the object key within the bucket.
 * 
 * @param bucket - Target bucket name
 * @param filePath - Local file path to upload
 * @returns The object key used for the uploaded file
 * @throws {Error} When file read or upload operation fails
 */
export async function uploadFile(bucket: string, filePath: string): Promise<string> {
  const data = await readFile(filePath);
  const key = basename(filePath);
  await uploadObject(bucket, key, data);
  return key;
}

/**
 * Generates a presigned URL for temporary read access to an object.
 * 
 * @param bucket - Source bucket name
 * @param key - Object key to generate access for
 * @param expiresInSeconds - URL expiration time in seconds (default: 24 hours)
 * @returns Promise resolving to presigned URL string
 * @throws {Error} When URL generation fails
 */
export async function generatePresignedUrl(
  bucket: string,
  key: string,
  expiresInSeconds = 60 * 60 * 24
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(minioClient, command, { expiresIn: expiresInSeconds });
}