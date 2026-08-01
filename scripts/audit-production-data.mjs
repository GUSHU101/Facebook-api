import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const audit = require('./audit-production-data.js');

export const main = audit.main;
