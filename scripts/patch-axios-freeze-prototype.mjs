import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repositoryRoot, 'node_modules', 'axios', 'lib', 'utils.js');
const urlSearchParamsTarget = path.join(
    repositoryRoot,
    'node_modules',
    'axios',
    'lib',
    'helpers',
    'AxiosURLSearchParams.js',
);
const viteCache = path.join(repositoryRoot, 'node_modules', '.vite');
const vulnerable = 'const reducedDescriptors = {};';
const hardened = 'const reducedDescriptors = Object.create(null);';
const vulnerableAssignment = 'reducedDescriptors[name] = ret || descriptor;';
const hardenedAssignment = [
    'Object.defineProperty(reducedDescriptors, name, {',
    '        value: ret || descriptor,',
    '        enumerable: true,',
    '        configurable: true,',
    '        writable: true,',
    '      });',
].join('\n');
const vulnerableMethodStart = 'prototype.toString = function toString(encoder) {';
const hardenedMethodStart = "Object.defineProperty(prototype, 'toString', {\n  value: function toString(encoder) {";
const vulnerableMethodEnd = "    .join('&');\n};\n\nexport default AxiosURLSearchParams;";
const hardenedMethodEnd = [
    "    .join('&');",
    '  },',
    '  configurable: true,',
    '  writable: true,',
    '});',
    '',
    'export default AxiosURLSearchParams;',
].join('\n');

if (!fs.existsSync(target)) {
    throw new Error(`Axios source was not found at ${target}`);
}

let source = fs.readFileSync(target, 'utf8');
if (source.includes(hardened)) {
    console.log('[postinstall] Axios freezePrototype compatibility patch is already applied.');
} else {
    const occurrences = source.split(vulnerable).length - 1;
    if (occurrences !== 1) {
        throw new Error(
            `Expected one Axios reduceDescriptors patch point, found ${occurrences}. Review the pinned Axios update before installing.`,
        );
    }
    source = source.replace(vulnerable, hardened);
}

if (!source.includes(hardenedAssignment)) {
    const occurrences = source.split(vulnerableAssignment).length - 1;
    if (occurrences !== 1) {
        throw new Error(
            `Expected one Axios descriptor assignment patch point, found ${occurrences}. Review the pinned Axios update before installing.`,
        );
    }
    source = source.replace(vulnerableAssignment, hardenedAssignment);
}

fs.writeFileSync(target, source);

if (!fs.existsSync(urlSearchParamsTarget)) {
    throw new Error(`Axios URLSearchParams source was not found at ${urlSearchParamsTarget}`);
}

let urlSearchParamsSource = fs.readFileSync(urlSearchParamsTarget, 'utf8');
if (!urlSearchParamsSource.includes(hardenedMethodStart)) {
    const starts = urlSearchParamsSource.split(vulnerableMethodStart).length - 1;
    const ends = urlSearchParamsSource.split(vulnerableMethodEnd).length - 1;
    if (starts !== 1 || ends !== 1) {
        throw new Error(
            `Expected one AxiosURLSearchParams patch block, found starts=${starts}, ends=${ends}. Review the pinned Axios update before installing.`,
        );
    }
    urlSearchParamsSource = urlSearchParamsSource
        .replace(vulnerableMethodStart, hardenedMethodStart)
        .replace(vulnerableMethodEnd, hardenedMethodEnd);
    fs.writeFileSync(urlSearchParamsTarget, urlSearchParamsSource);
}

console.log('[postinstall] Patched Axios for Tauri freezePrototype compatibility.');

// Vite can keep an optimized Axios bundle created before this postinstall
// patch. Clearing only its generated cache makes the next dev start rebuild
// Axios from the patched source; production builds are not affected.
fs.rmSync(viteCache, {recursive: true, force: true});
console.log('[postinstall] Cleared the Vite dependency cache.');
