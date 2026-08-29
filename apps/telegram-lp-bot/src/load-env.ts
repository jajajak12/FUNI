import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { assertFuniCredentialIsolation } from '../../shared/credential-isolation.js';

export const funiRootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const funiEnvPath = resolve(funiRootDir, '.env');

// The repository .env is authoritative for runtime safety flags. PM2 may retain
// an older process environment across reloads, so do not allow stale inherited
// values to override the deployed file.
dotenv.config({ path: funiEnvPath, override: true });
assertFuniCredentialIsolation(process.env);
