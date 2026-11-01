import { readFileSync } from 'node:fs';

// Source and compiled modules both resolve to the project manifest.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('Missing application version in package.json');

export const APP_VERSION: string = manifest.version;
