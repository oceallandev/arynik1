import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, '..');
const sourceDir = resolve(frontendDir, 'dist');
const repoDistDir = resolve(frontendDir, '..', 'dist');

if (!existsSync(sourceDir)) {
  throw new Error(`Build output not found: ${sourceDir}`);
}

rmSync(repoDistDir, { recursive: true, force: true });
mkdirSync(repoDistDir, { recursive: true });
cpSync(sourceDir, repoDistDir, { recursive: true });
