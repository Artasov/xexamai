import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSemver} from './semver.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const expectedTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
const expectedVersion = expectedTag.replace(/^v/, '');
try {
    parseSemver(expectedVersion);
} catch {
    throw new Error(`Release tag must be v<semver>; received ${JSON.stringify(expectedTag)}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const cargoToml = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLock = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
const cargoLockVersion = cargoLock.match(
    /\[\[package\]\]\s+name\s*=\s*"xexamai"\s+version\s*=\s*"([^"]+)"/,
)?.[1];

const versions = new Map([
    ['release tag', expectedVersion],
    ['package.json', packageJson.version],
    ['package-lock.json', packageLock.version],
    ['package-lock root package', packageLock.packages?.['']?.version],
    ['tauri.conf.json', tauriConfig.version],
    ['Cargo.toml', cargoVersion],
    ['Cargo.lock root package', cargoLockVersion],
]);

const invalid = [...versions.entries()].filter(([, version]) => version !== expectedVersion);
if (invalid.length > 0) {
    const details = [...versions.entries()].map(([source, version]) => `${source}: ${version ?? '<missing>'}`).join('\n');
    throw new Error(`Release versions are not synchronized:\n${details}`);
}

console.log(`Verified release version ${expectedVersion} in tag, npm, Tauri and Cargo metadata.`);
