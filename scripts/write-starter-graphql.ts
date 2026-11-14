#!/usr/bin/env bun
/**
 * Writes src/graphql/starter.graphql from the starter catalogue (catalog/): the schema the frontend builds a page
 * against until a product serves its own. Run it after the catalogue changes; a kind whose name the schema refuses
 * is named on standard error and left out.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { starterSchema } from './graphql-starter.js';

const { sdl, refused } = starterSchema();
const target = join(import.meta.dir, '..', 'src/graphql/starter.graphql');
writeFileSync(target, sdl);
for (const one of refused) console.error(`${one.kind}: ${one.reason}`);
console.error(`wrote ${target}`);
