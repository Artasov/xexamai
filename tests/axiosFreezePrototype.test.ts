import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('Axios Tauri compatibility', () => {
    it('does not assign descriptor names through a frozen inherited constructor', () => {
        const source = fs.readFileSync(path.join(root, 'node_modules/axios/lib/utils.js'), 'utf8');
        const paramsSource = fs.readFileSync(
            path.join(root, 'node_modules/axios/lib/helpers/AxiosURLSearchParams.js'),
            'utf8',
        );
        expect(source).toContain('Object.defineProperty(reducedDescriptors, name, {');
        expect(source).not.toContain('reducedDescriptors[name] = ret || descriptor;');
        expect(paramsSource).toContain("Object.defineProperty(prototype, 'toString', {");
        expect(paramsSource).not.toContain('prototype.toString = function toString');
    });

    it('loads when Tauri freezes built-in prototypes', () => {
        expect(() => execFileSync(
            process.execPath,
            [
                '--input-type=module',
                '--eval',
                [
                    'Object.freeze(Object.prototype);',
                    "await import('axios/unsafe/core/AxiosHeaders.js');",
                ].join(' '),
            ],
            {cwd: root, stdio: 'pipe'},
        )).not.toThrow();
    });
});
