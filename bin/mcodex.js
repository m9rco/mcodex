#!/usr/bin/env node
import { bootstrap } from '../src/bootstrap.js';

try {
  process.exitCode = await bootstrap(process.argv.slice(2));
} catch (error) {
  console.error(`mcodex: ${error.message}`);
  process.exitCode = 1;
}
