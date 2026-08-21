import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const styles = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');

describe('global window styling', () => {
    it('uses a thin neutral scrollbar for every scroll container', () => {
        expect(styles).toContain('*::-webkit-scrollbar {');
        expect(styles).toContain('width: 5px !important;');
        expect(styles).toContain('scrollbar-color: rgba(148, 163, 184, 0.34) transparent;');
        expect(styles).toContain('*::-webkit-scrollbar-button');
        expect(styles).toContain('display: none !important;');
    });

    it('never exposes the native WebView keyboard focus outline', () => {
        expect(styles).toContain('*:focus-visible,');
        expect(styles).toContain('[tabindex]:focus-visible');
        expect(styles).toContain('outline: none !important;');
        expect(styles).toContain('.MuiButtonBase-root.Mui-focusVisible');
    });
});
