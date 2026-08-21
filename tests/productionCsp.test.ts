import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(
    fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
) as {
    app: {
        security: {
            csp: string;
            devCsp: string;
            dangerousDisableAssetCspModification: string[];
        };
    };
};

const sourcesFor = (policy: string, directive: string) => {
    const entry = policy
        .split(';')
        .map((value) => value.trim().split(/\s+/))
        .find(([name]) => name === directive);
    return entry?.slice(1) ?? [];
};

describe('production Content Security Policy', () => {
    it('keeps MUI and React runtime styles usable after Tauri asset processing', () => {
        const security = config.app.security;

        // Tauri normally injects a nonce into style-src in production. Browsers then
        // ignore unsafe-inline, blocking Emotion style elements and React style props.
        expect(security.dangerousDisableAssetCspModification).toEqual(['style-src']);
        for (const policy of [security.csp, security.devCsp]) {
            expect(sourcesFor(policy, 'style-src')).toEqual(
                expect.arrayContaining(["'self'", "'unsafe-inline'"]),
            );
        }
    });

    it('allows profile images from the application media bucket host', () => {
        for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
            expect(sourcesFor(policy, 'img-src')).toContain('https://s3.twcstorage.ru');
        }
    });
});
