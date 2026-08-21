import fs from 'node:fs';
import path from 'node:path';

const [bundleArgument, outputArgument, platformArgument] = process.argv.slice(2);
if (!bundleArgument || !outputArgument || !platformArgument) {
    throw new Error('Usage: prepare-release-artifacts.mjs <bundle-dir> <output-dir> <windows|darwin|linux>');
}

const bundleDirectory = path.resolve(bundleArgument);
const outputRoot = path.resolve(outputArgument);
const platform = platformArgument.toLowerCase();
const architecture = ({X64: 'x86_64', ARM64: 'aarch64', X86: 'i686'})[process.env.RUNNER_ARCH] ??
    ({x64: 'x86_64', arm64: 'aarch64', ia32: 'i686'})[process.arch];
if (!architecture) {
    throw new Error(`Unsupported release architecture: ${process.env.RUNNER_ARCH ?? process.arch}`);
}

const platformNames = {windows: 'windows', darwin: 'macos', linux: 'linux'};
if (!platformNames[platform]) {
    throw new Error(`Unsupported release platform: ${platform}`);
}

function walk(directory) {
    return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
        const item = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(item) : [item];
    });
}

const deliverablePatterns = {
    windows: [
        /\.exe$/i,
        /\.msi$/i,
        /\.(?:exe|msi)\.zip$/i,
        /\.(?:exe|msi)\.sig$/i,
    ],
    darwin: [/\.dmg$/i, /\.app\.tar\.gz$/i, /\.app\.tar\.gz\.sig$/i],
    linux: [/\.AppImage$/i, /\.AppImage\.sig$/i, /\.deb$/i, /\.deb\.sig$/i],
};
const updaterTargets = {
    // With createUpdaterArtifacts=true, Tauri v2 signs and reuses the normal
    // Windows/Linux bundles. Legacy zip/tar payloads are v1Compatible-only.
    windows: [
        {installer: 'nsis', pattern: /-setup\.exe$/i},
        {installer: 'msi', pattern: /\.msi$/i},
    ],
    darwin: [{installer: 'app', pattern: /\.app\.tar\.gz$/i}],
    linux: [
        {installer: 'appimage', pattern: /\.AppImage$/i},
        {installer: 'deb', pattern: /\.deb$/i},
    ],
};

const allFiles = walk(bundleDirectory);
const deliverables = allFiles.filter((file) => deliverablePatterns[platform].some((pattern) => pattern.test(file)));
if (deliverables.length === 0) {
    throw new Error(`No ${platform} release artifacts found under ${bundleDirectory}`);
}

const updaters = updaterTargets[platform].map(({installer, pattern}) => {
    const updaterArtifact = deliverables.find((file) => pattern.test(file) && !file.endsWith('.sig'));
    if (!updaterArtifact) throw new Error(`No ${installer} updater artifact found for ${platform}`);
    const signaturePath = `${updaterArtifact}.sig`;
    if (!fs.existsSync(signaturePath)) {
        throw new Error(`Missing Tauri updater signature: ${signaturePath}`);
    }
    return {
        target: `${platform}-${architecture}-${installer}`,
        updaterFile: path.basename(updaterArtifact),
        signature: fs.readFileSync(signaturePath, 'utf8').trim(),
    };
});

const platformDirectory = path.join(outputRoot, platformNames[platform]);
const filesDirectory = path.join(platformDirectory, 'files');
fs.rmSync(platformDirectory, {recursive: true, force: true});
fs.mkdirSync(filesDirectory, {recursive: true});

const copiedNames = new Set();
for (const source of deliverables) {
    const name = path.basename(source);
    if (copiedNames.has(name)) {
        throw new Error(`Duplicate release artifact name ${name}; keep bundle names unique`);
    }
    copiedNames.add(name);
    fs.copyFileSync(source, path.join(filesDirectory, name));
}

const metadata = {
    platform: platformNames[platform],
    updaters,
    files: [...copiedNames].sort(),
};
fs.writeFileSync(path.join(platformDirectory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Prepared ${metadata.files.length} ${metadata.platform} artifacts; ${updaters.length} updater targets.`);
