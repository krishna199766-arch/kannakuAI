import fs from 'node:fs';
import { config } from '../config';

// Deletes the local database and uploads; the next start re-seeds the demo company.
for (const dir of [config.dbDir, config.uploadDir]) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Removed ${dir}`);
}
