import { writeFile } from 'node:fs/promises';

const configPath = new URL('../../dist/config.json', import.meta.url);
const serialized = `${JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:3000' }, null, 2)}\n`;

await writeFile(configPath, serialized, 'utf8');
