import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const postcssConfig = require('./configs/postcss.config.js');

export default defineConfig({
    root: path.resolve(__dirname, 'src/renderer'),
    publicDir: path.resolve(__dirname, 'public'),
    plugins: [react()],
    base: './',
    server: {
        port: 5174,
        strictPort: true,
    },
    build: {
        outDir: path.resolve(__dirname, 'dist/renderer'),
        emptyOutDir: true,
        sourcemap: true,
        target: 'es2020',
    },
    resolve: {
        alias: {
            '@main': path.resolve(__dirname, 'src/main'),
            '@renderer': path.resolve(__dirname, 'src/renderer'),
            '@shared': path.resolve(__dirname, 'src/shared'),
            '@preload': path.resolve(__dirname, 'src/preload'),
        },
    },
    css: {
        postcss: postcssConfig,
    },
});
