#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const patternsDir = path.join(root, 'references', 'site-patterns');

if (!fs.existsSync(patternsDir)) {
  process.stdout.write('none\n');
  process.exit(0);
}

const names = fs
  .readdirSync(patternsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name.replace(/\.md$/, ''))
  .sort((a, b) => a.localeCompare(b));

process.stdout.write(`${names.join('\n') || 'none'}\n`);
