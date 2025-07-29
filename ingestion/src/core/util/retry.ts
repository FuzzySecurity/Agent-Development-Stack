/**
 * @fileoverview Retry utility with exponential backoff and jitter.
 * 
 * Provides resilient operation execution with configurable retry logic,
 * exponential backoff delays, and randomized jitter to prevent thundering
 * herd problems in distributed systems.
 */

/**
 * Retries a promise-returning operation with exponential backoff and jitter.
 * 
 * Uses exponential backoff with ±25% jitter to reduce the likelihood of
 * synchronized retries across multiple clients (thundering herd effect).
 * 
 * @template T - The return type of the operation function
 * @param fn - Promise-returning operation to execute and retry on failure
 * @param opts - Configuration options for retry behavior
 * @param opts.retries - Maximum number of retry attempts (default: 3)
 * @param opts.baseMs - Base delay in milliseconds for exponential backoff (default: 200)
 * @returns Promise resolving to the result of the first successful operation
 * @throws The final error from the last retry attempt if all attempts fail
 * 
 * @example
 * ```typescript
 * const result = await retry(() => fetchData(), { retries: 5, baseMs: 100 });
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number } = {}
): Promise<T> {
  const { retries = 3, baseMs = 200 } = opts;
  let attempt = 0;
  
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries) throw err;
      
      // Calculate exponential backoff delay with randomized jitter
      const expDelay = baseMs * 2 ** (attempt - 1);
      const jitterFactor = 0.75 + Math.random() * 0.5; // Range: 0.75 - 1.25
      const delay = expDelay * jitterFactor;
      
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
} 