import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    plugins: [
        {
            // libsodium-wrappers' ESM build imports "./libsodium.mjs" relative
            // to its own dist/modules-esm/, where that file does not exist;
            // route it to the real ESM build shipped by the libsodium package.
            name: 'libsodium-esm-fix',
            resolveId(id, importer) {
                if (
                    id === './libsodium.mjs' &&
                    importer &&
                    importer.endsWith('libsodium-wrappers/dist/modules-esm/libsodium-wrappers.mjs')
                ) {
                    return resolve(process.cwd(), 'node_modules/libsodium/dist/modules-esm/libsodium.mjs')
                }
            },
        },
    ],
    build: {
        target: 'esnext',
        manifest: false,
        rollupOptions: {
            output: {
                entryFileNames: `[name].js`,
                chunkFileNames: `[name].js`,
                assetFileNames: `[name].[ext]`,
                manualChunks: {
                    vendor: ['libsodium-wrappers', 'fast-sha256', 'zstddec', 'pcm-player', 'wasm-feature-detect'],
                },
            }
        }
    },
})