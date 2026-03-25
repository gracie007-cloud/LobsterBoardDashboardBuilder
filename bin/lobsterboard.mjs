#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = join(__dirname, '..');

// Keep user's working directory so custom pages/data work
const child = fork(join(packageDir, 'server.cjs'), {
  env: { ...process.env, LOBSTERBOARD_PKG_DIR: packageDir },
  stdio: 'inherit'
});

child.on('exit', (code) => process.exit(code ?? 0));
