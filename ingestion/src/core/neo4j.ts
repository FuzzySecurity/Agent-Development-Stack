import neo4j from "neo4j-driver";

/**
 * @fileoverview Neo4j database connection and driver configuration.
 * 
 * Establishes a connection to Neo4j using environment variables for authentication.
 * The driver instance is configured with lossless integer handling disabled for
 * simplified JavaScript numeric operations.
 */

/**
 * Neo4j Bolt driver instance configured from environment variables.
 * 
 * Requires the following environment variables:
 * - NEO4J_URI: Connection string (e.g., "bolt://localhost:7687")
 * - NEO4J_USER: Database username
 * - NEO4J_PASSWORD: Database password
 * 
 * Configuration:
 * - disableLosslessIntegers: true (converts Neo4j integers to JavaScript numbers)
 */
export const driver = neo4j.driver(
  process.env.NEO4J_URI!,
  neo4j.auth.basic(
    process.env.NEO4J_USER!,
    process.env.NEO4J_PASSWORD!
  ),
  { disableLosslessIntegers: true }
);
