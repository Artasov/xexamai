import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@renderer': path.resolve(root, 'src/renderer'),
            '@shared': path.resolve(root, 'src/shared'),
        },
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.{ts,tsx}'],
        passWithNoTests: false,
    },
});
