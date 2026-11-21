import { defineConfig } from 'vitest/config';
import { realpathSync } from 'node:fs';
export default defineConfig({root:realpathSync(process.cwd()),test:{include:['tests/**/*.test.ts'],fileParallelism:false,testTimeout:40000}});
