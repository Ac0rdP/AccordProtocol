import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const catalogPath = join(__dirname, 'catalog.json');
export const eventCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

export function getEventSchema(topic) {
  return eventCatalog[topic] || null;
}
