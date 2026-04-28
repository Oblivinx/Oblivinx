import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                'src/index.ts',
                'src/types/**/*.ts',
                'src/adapters/base/StorageAdapter.ts',
                'src/plugins/base/Plugin.ts',
            ],
            statements: 100,
            branches: 100,
            functions: 100,
            lines: 100,
        },
        fakeTimers: {
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        },
    },
});
