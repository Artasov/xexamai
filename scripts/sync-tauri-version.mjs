import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {execSync} from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(root, 'src-tauri', 'Cargo.toml');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));

let updated = false;
let cargoTomlUpdated = false;

// Update tauri.conf.json
if (tauriConfig.version !== pkg.version) {
    tauriConfig.version = pkg.version;
    fs.writeFileSync(tauriConfigPath, JSON.stringify(tauriConfig, null, 2) + '\n');
    console.log(`[sync-tauri-version] Updated tauri.conf.json version -> ${pkg.version}`);
    updated = true;
} else {
    console.log('[sync-tauri-version] Tauri config version already up to date.');
}

// Update Cargo.toml
const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
const versionRegex = /^version\s*=\s*"([^"]+)"/m;
const match = cargoToml.match(versionRegex);

if (match && match[1] !== pkg.version) {
    const updatedCargoToml = cargoToml.replace(versionRegex, `version = "${pkg.version}"`);
    fs.writeFileSync(cargoTomlPath, updatedCargoToml);
    console.log(`[sync-tauri-version] Updated Cargo.toml version -> ${pkg.version}`);
    updated = true;
    cargoTomlUpdated = true;
} else if (match && match[1] === pkg.version) {
    console.log('[sync-tauri-version] Cargo.toml version already up to date.');
} else {
    console.warn('[sync-tauri-version] Could not find version in Cargo.toml');
}

// Update Cargo.lock if Cargo.toml was updated
if (cargoTomlUpdated) {
    try {
        console.log('[sync-tauri-version] Updating Cargo.lock...');
        execSync('cargo check', {
            cwd: path.join(root, 'src-tauri'),
            stdio: 'inherit'
        });
        console.log('[sync-tauri-version] Cargo.lock updated successfully.');
    } catch (error) {
        console.warn('[sync-tauri-version] Failed to update Cargo.lock:', error.message);
        console.warn('[sync-tauri-version] Cargo.lock will be updated on next cargo build.');
    }
}
