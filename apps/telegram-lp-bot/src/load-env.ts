import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { assertRobinCredentialIsolation } from '../../shared/credential-isolation.js';

export const robinRootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const robinEnvPath = resolve(robinRootDir, '.env');

// The repository .env is authoritative for runtime safety flags. PM2 may retain
// an older process environment across reloads, so do not allow stale inherited
// values to override the deployed file.
dotenv.config({ path: robinEnvPath, override: true });
assertRobinCredentialIsolation(process.env);
