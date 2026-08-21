import fs from 'node:fs';
import path from 'node:path';
import {isPrerelease} from './semver.mjs';

const [artifactsArgument, tag, notesPath, outputDirectoryArgument, publicationDateArgument] =
    process.argv.slice(2);
if (!artifactsArgument || !tag || !notesPath || !outputDirectoryArgument || !publicationDateArgument) {
    throw new Error(
        'Usage: build-update-manifest.mjs <artifacts-dir> <tag> <notes-file> <output-dir> <publication-date>',
    );
}
const version = tag.replace(/^v/, '');
const artifactsDirectory = path.resolve(artifactsArgument);
const outputDirectory = path.resolve(outputDirectoryArgument);
const endpoint = (process.env.S3_ENDPOINT ?? '').replace(/\/$/, '');
const bucket = process.env.S3_BUCKET;
if (!endpoint || !bucket) throw new Error('S3_ENDPOINT and S3_BUCKET are required');
const publicationDate = new Date(publicationDateArgument);
if (Number.isNaN(publicationDate.getTime())) {
    throw new Error(`Invalid publication date: ${publicationDateArgument}`);
}

const metadataFiles = fs.readdirSync(artifactsDirectory, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactsDirectory, entry.name, 'metadata.json'))
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => left.localeCompare(right));
const metadata = metadataFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
const targetPattern = /^(windows|darwin|linux)-(x86_64|aarch64|i686)-(nsis|msi|app|appimage|deb)$/;
const updaterEntries = metadata.flatMap((item) => {
    if (!['windows', 'macos', 'linux'].includes(item.platform) || !Array.isArray(item.files)) {
        throw new Error(`Invalid release metadata platform: ${String(item.platform)}`);
    }
    return (item.updaters ?? []).map((updater) => {
        if (
            typeof updater.target !== 'string' ||
            !targetPattern.test(updater.target) ||
            typeof updater.updaterFile !== 'string' ||
            path.basename(updater.updaterFile) !== updater.updaterFile ||
            !item.files.includes(updater.updaterFile) ||
            typeof updater.signature !== 'string' ||
            !updater.signature.trim()
        ) {
            throw new Error(`Invalid signed updater metadata for ${String(updater.target)}`);
        }
        return {platform: item.platform, ...updater, signature: updater.signature.trim()};
    });
});
const requiredInstallerFamilies = [
    ['windows', 'nsis'],
    ['windows', 'msi'],
    ['darwin', 'app'],
    ['linux', 'appimage'],
    ['linux', 'deb'],
];
for (const [platformName, installer] of requiredInstallerFamilies) {
    const targetExpression = new RegExp(`^${platformName}-(?:x86_64|aarch64|i686)-${installer}$`);
    if (!updaterEntries.some((item) => targetExpression.test(item.target))) {
        throw new Error(`Missing signed updater target for ${platformName}-${installer}`);
    }
}
const uniqueTargets = new Set(updaterEntries.map((item) => item.target));
if (uniqueTargets.size !== updaterEntries.length) {
    throw new Error('Duplicate updater target in release metadata');
}

const encodePath = (value) => value.split('/').map(encodeURIComponent).join('/');
const publicUrl = (key) => `${endpoint}/${bucket}/${encodePath(key)}`;
const platforms = {};
for (const item of updaterEntries) {
    const key = `xexamai/${tag}/${item.platform}/${item.updaterFile}`;
    platforms[item.target] = {signature: item.signature, url: publicUrl(key)};
}

const notes = fs.readFileSync(notesPath, 'utf8').trim();
const manifest = {
    version,
    notes,
    pub_date: publicationDate.toISOString(),
    platforms,
};
fs.mkdirSync(outputDirectory, {recursive: true});
fs.writeFileSync(path.join(outputDirectory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const releaseBody = [
    'Meet **XEXAMAI** — your AI interview assistant',
    '',
    '## Download links',
    '',
];
for (const item of metadata.sort((a, b) => a.platform.localeCompare(b.platform))) {
    releaseBody.push(`### ${item.platform === 'macos' ? 'macOS' : item.platform[0].toUpperCase() + item.platform.slice(1)}`, '');
    for (const filename of item.files.filter((name) => !name.endsWith('.sig'))) {
        const key = `xexamai/${tag}/${item.platform}/${filename}`;
        releaseBody.push(`- [${filename}](${publicUrl(key)})`);
    }
    releaseBody.push('');
}
releaseBody.push('---', '', '## Changes', '', notes || 'No release notes were generated.', '');
fs.writeFileSync(path.join(outputDirectory, 'release-body.md'), releaseBody.join('\n'));

const prerelease = isPrerelease(version);
fs.writeFileSync(
    path.join(outputDirectory, 'publication.json'),
    `${JSON.stringify({channel: prerelease ? 'beta' : 'stable', manifestName: prerelease ? 'latest-beta.json' : 'latest.json'}, null, 2)}\n`,
);
