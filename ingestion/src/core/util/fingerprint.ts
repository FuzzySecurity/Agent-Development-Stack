import crypto from "node:crypto";

/**
 * @fileoverview Deterministic fingerprinting utility for JSON objects.
 * 
 * Provides stable SHA-256 hash generation for arbitrary objects with
 * consistent ordering to ensure the same object always produces the
 * same fingerprint regardless of property order.
 */

/**
 * Generates a deterministic SHA-256 fingerprint for any JSON-serializable object.
 * 
 * The fingerprinting process normalizes object key ordering by sorting keys
 * alphabetically, ensuring that objects with identical content but different
 * property order will always produce the same hash.
 * 
 * @param obj - Plain object to generate fingerprint for
 * @returns 64-character hexadecimal SHA-256 digest
 * 
 * @example
 * ```typescript
 * const hash1 = fingerprint({ b: 2, a: 1 });
 * const hash2 = fingerprint({ a: 1, b: 2 });
 * console.log(hash1 === hash2); // true - same content, same hash
 * ```
 */
export function fingerprint(obj: Record<string, unknown>): string {
  const ordered = Object.keys(obj)
    .sort()
    .map(k => `${k}=${obj[k]}`)
    .join("|");
  
  return crypto.createHash("sha256").update(ordered).digest("hex");
}
