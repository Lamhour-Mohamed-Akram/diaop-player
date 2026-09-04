#!/usr/bin/env node
// Bumps the cache-busting `?v=N` on every asset tag in index.html.
//
// player.js reads its own `?v=` from its <script> tag and reuses it for the
// dynamically imported engine bundles (js/pv/*.js), so index.html is the single
// place the version lives. Run this before deploying a change to any js/css.
//
//   npm run bump            -> N+1
//   npm run bump -- 80      -> exactly 80
//   npm run bump -- --dry   -> print what would change
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'index.html');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const explicit = args.find((a) => /^\d+$/.test(a));

const html = readFileSync(file, 'utf8');
const versions = new Set([...html.matchAll(/\?v=(\d+)"/g)].map((m) => Number(m[1])));
if (versions.size === 0) { console.error('No ?v=N asset tags found in index.html'); process.exit(1); }
if (versions.size > 1) console.warn('Warning: mixed versions in index.html:', [...versions].join(', '));

const current = Math.max(...versions);
const next = explicit ? Number(explicit) : current + 1;
let count = 0;
const out = html.replace(/\?v=\d+"/g, () => { count++; return `?v=${next}"`; });

console.log(`${dry ? '[dry] ' : ''}index.html: v${current} -> v${next} (${count} tags)`);
if (!dry) writeFileSync(file, out);
