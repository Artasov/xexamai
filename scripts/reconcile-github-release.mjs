import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [repository, tag, targetCommitish, bodyArgument, artifactsArgument, prereleaseArgument] =
    process.argv.slice(2);
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const apiBase = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
if (
    !repository ||
    !tag ||
    !targetCommitish ||
    !bodyArgument ||
    !artifactsArgument ||
    !['true', 'false'].includes(prereleaseArgument) ||
    !token
) {
    throw new Error(
        'Usage: reconcile-github-release.mjs <owner/repo> <tag> <target-commitish> <body-file> <artifacts-dir> <true|false> with GH_TOKEN',
    );
}

const repositoryPath = repository
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
if (repository.split('/').length !== 2) throw new Error(`Invalid GitHub repository: ${repository}`);
const prerelease = prereleaseArgument === 'true';
const body = fs.readFileSync(path.resolve(bodyArgument), 'utf8');
const artifactsDirectory = path.resolve(artifactsArgument);
const apiHeaders = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'xexamai-release-pipeline',
};

async function sha256File(file) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    return digest.digest('hex');
}

async function sha256Response(response) {
    const digest = crypto.createHash('sha256');
    if (response.body) {
        for await (const chunk of response.body) digest.update(chunk);
    }
    return digest.digest('hex');
}

async function readJson(response, operation) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : null;
    } catch (error) {
        throw new Error(`${operation} returned invalid JSON`, {cause: error});
    }
}

async function githubJson(url, {method = 'GET', payload, expected = [200]} = {}) {
    const response = await fetch(url, {
        method,
        headers: {
            ...apiHeaders,
            ...(payload === undefined ? {} : {'Content-Type': 'application/json'}),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!expected.includes(response.status)) {
        throw new Error(
            `GitHub ${method} ${new URL(url).pathname} failed: HTTP ${response.status} ${await response.text()}`,
        );
    }
    return readJson(response, `GitHub ${method} ${new URL(url).pathname}`);
}

async function expectedAssets() {
    const assets = new Map();
    for (const platform of fs
        .readdirSync(artifactsDirectory, {withFileTypes: true})
        .filter((entry) => entry.isDirectory())) {
        const filesDirectory = path.join(artifactsDirectory, platform.name, 'files');
        if (!fs.existsSync(filesDirectory)) continue;
        for (const entry of fs.readdirSync(filesDirectory, {withFileTypes: true})) {
            if (!entry.isFile()) continue;
            if (assets.has(entry.name)) {
                throw new Error(`Duplicate GitHub release asset name: ${entry.name}`);
            }
            const file = path.join(filesDirectory, entry.name);
            const stat = fs.statSync(file);
            assets.set(entry.name, {
                file,
                size: stat.size,
                sha256: await sha256File(file),
            });
        }
    }
    if (assets.size === 0) throw new Error('No GitHub release assets were found');
    return assets;
}

async function getReleaseByTag() {
    const url = `${apiBase}/repos/${repositoryPath}/releases/tags/${encodeURIComponent(tag)}`;
    const response = await fetch(url, {headers: apiHeaders});
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`Could not read GitHub release ${tag}: HTTP ${response.status} ${await response.text()}`);
    }
    return readJson(response, `GitHub release ${tag}`);
}

async function createDraftRelease() {
    const url = `${apiBase}/repos/${repositoryPath}/releases`;
    const payload = {
        tag_name: tag,
        target_commitish: targetCommitish,
        name: tag,
        body,
        draft: true,
        prerelease,
    };
    const response = await fetch(url, {
        method: 'POST',
        headers: {...apiHeaders, 'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
    });
    if (response.status === 201) {
        console.log(`Created draft GitHub release ${tag}.`);
        return readJson(response, `Create GitHub release ${tag}`);
    }
    // A rerun racing an already-created draft should reconcile that draft,
    // never create a second publication path.
    if (response.status === 422) {
        const existing = await getReleaseByTag();
        if (existing) return existing;
    }
    throw new Error(`Could not create draft GitHub release ${tag}: HTTP ${response.status} ${await response.text()}`);
}

async function listAssets(releaseId) {
    const assets = [];
    for (let page = 1; ; page += 1) {
        const pageAssets = await githubJson(
            `${apiBase}/repos/${repositoryPath}/releases/${releaseId}/assets?per_page=100&page=${page}`,
        );
        if (!Array.isArray(pageAssets)) throw new Error('GitHub release assets response is not an array');
        assets.push(...pageAssets);
        if (pageAssets.length < 100) return assets;
    }
}

async function actualAssetHash(asset) {
    if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
        return asset.digest.slice('sha256:'.length).toLowerCase();
    }
    const response = await fetch(asset.url, {
        headers: {...apiHeaders, Accept: 'application/octet-stream'},
        redirect: 'follow',
    });
    if (!response.ok) {
        throw new Error(`Could not download existing GitHub asset ${asset.name}: HTTP ${response.status}`);
    }
    return sha256Response(response);
}

async function inspectAssets(releaseId, expected) {
    const assets = await listAssets(releaseId);
    const matching = new Map();
    const repair = [];
    for (const asset of assets) {
        if (typeof asset.name !== 'string' || !asset.name) {
            repair.push({asset, reason: 'invalid name'});
            continue;
        }
        const local = expected.get(asset.name);
        if (!local) {
            repair.push({asset, reason: 'unexpected name'});
            continue;
        }
        if (asset.state !== 'uploaded' || asset.size !== local.size) {
            repair.push({asset, reason: 'size/state mismatch'});
            continue;
        }
        const remoteHash = await actualAssetHash(asset);
        if (remoteHash !== local.sha256) {
            repair.push({asset, reason: 'checksum mismatch'});
            continue;
        }
        if (matching.has(asset.name)) {
            repair.push({asset, reason: 'duplicate name'});
            continue;
        }
        matching.set(asset.name, asset);
    }
    const missing = [...expected.keys()].filter((name) => !matching.has(name));
    return {matching, repair, missing};
}

function assertExactAssets(inspection) {
    if (inspection.repair.length > 0) {
        const details = inspection.repair
            .map(({asset, reason}) => `${String(asset.name ?? asset.id ?? 'unknown')} (${reason})`)
            .join(', ');
        throw new Error(`GitHub release ${tag} has non-matching assets: ${details}`);
    }
    if (inspection.missing.length > 0) {
        throw new Error(`GitHub release ${tag} is missing assets: ${inspection.missing.join(', ')}`);
    }
}

function assertPublishedMetadata(release, {requireExpectedContent = false} = {}) {
    if (release.draft) throw new Error(`GitHub release ${tag} is unexpectedly still a draft`);
    if (release.tag_name !== tag) throw new Error(`GitHub release tag mismatch for ${tag}`);
    if (Boolean(release.prerelease) !== prerelease) {
        throw new Error(`Published GitHub release ${tag} has the wrong prerelease state`);
    }
    if (requireExpectedContent && (release.name !== tag || release.body !== body)) {
        throw new Error(`Published GitHub release ${tag} metadata differs from the expected release`);
    }
}

async function deleteAsset(asset, reason) {
    if (!Number.isInteger(asset.id)) {
        throw new Error(`Cannot repair GitHub release asset ${String(asset.name)} without a numeric id`);
    }
    const response = await fetch(
        `${apiBase}/repos/${repositoryPath}/releases/assets/${asset.id}`,
        {method: 'DELETE', headers: apiHeaders},
    );
    if (response.status !== 204) {
        throw new Error(
            `Could not delete draft GitHub asset ${String(asset.name)}: HTTP ${response.status} ${await response.text()}`,
        );
    }
    console.log(`Removed ${reason} draft GitHub release asset ${String(asset.name)}.`);
}

async function uploadAsset(release, name, asset) {
    const uploadBase = String(release.upload_url ?? '').replace(/\{.*$/, '');
    if (!uploadBase) throw new Error(`GitHub release ${tag} has no upload URL`);
    const url = new URL(uploadBase);
    url.searchParams.set('name', name);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            ...apiHeaders,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(asset.size),
        },
        body: fs.createReadStream(asset.file),
        duplex: 'half',
    });
    if (response.status !== 201) {
        throw new Error(`Could not upload GitHub asset ${name}: HTTP ${response.status} ${await response.text()}`);
    }
    console.log(`Uploaded missing GitHub release asset ${name}.`);
}

const expected = await expectedAssets();
let release = await getReleaseByTag();
if (!release) release = await createDraftRelease();
if (release.tag_name !== tag) throw new Error(`GitHub release tag mismatch for ${tag}`);

if (!release.draft) {
    assertPublishedMetadata(release);
    assertExactAssets(await inspectAssets(release.id, expected));
    console.log(`GitHub release ${tag} is published with the exact expected asset set.`);
} else {
    const inspection = await inspectAssets(release.id, expected);
    for (const item of inspection.repair) await deleteAsset(item.asset, item.reason);

    const stillDraft = await getReleaseByTag();
    if (!stillDraft || stillDraft.id !== release.id || !stillDraft.draft) {
        throw new Error(`GitHub release ${tag} changed while its draft assets were being reconciled`);
    }
    release = stillDraft;
    const missing = [...expected.entries()].filter(([name]) => !inspection.matching.has(name));
    for (const [name, asset] of missing) await uploadAsset(release, name, asset);

    assertExactAssets(await inspectAssets(release.id, expected));
    release = await githubJson(`${apiBase}/repos/${repositoryPath}/releases/${release.id}`, {
        method: 'PATCH',
        payload: {
            name: tag,
            body,
            draft: false,
            prerelease,
        },
    });
    assertPublishedMetadata(release, {requireExpectedContent: true});
    const published = await getReleaseByTag();
    if (!published || published.id !== release.id) {
        throw new Error(`Published GitHub release ${tag} could not be read back`);
    }
    assertPublishedMetadata(published, {requireExpectedContent: true});
    assertExactAssets(await inspectAssets(published.id, expected));
    console.log(`Published reconciled GitHub release ${tag}.`);
}
