import fs from 'node:fs';
import path from 'node:path';

const [repository, tag, targetCommitish, bodyArgument, prereleaseArgument] = process.argv.slice(2);
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const apiBase = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
if (
    !repository ||
    !tag ||
    !targetCommitish ||
    !bodyArgument ||
    !['true', 'false'].includes(prereleaseArgument) ||
    !token
) {
    throw new Error(
        'Usage: reconcile-github-release.mjs <owner/repo> <tag> <target-commitish> <body-file> <true|false> with GH_TOKEN',
    );
}

const repositoryPath = repository
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
if (repository.split('/').length !== 2) throw new Error(`Invalid GitHub repository: ${repository}`);
const prerelease = prereleaseArgument === 'true';
const body = fs.readFileSync(path.resolve(bodyArgument), 'utf8');
const apiHeaders = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'xexamai-release-pipeline',
};

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

async function getReleaseByTag() {
    const url = `${apiBase}/repos/${repositoryPath}/releases/tags/${encodeURIComponent(tag)}`;
    const response = await fetch(url, {headers: apiHeaders});
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`Could not read GitHub release ${tag}: HTTP ${response.status} ${await response.text()}`);
    }
    return readJson(response, `GitHub release ${tag}`);
}

async function getReleaseById(releaseId) {
    return githubJson(`${apiBase}/repos/${repositoryPath}/releases/${releaseId}`);
}

async function findReleaseByTag() {
    const published = await getReleaseByTag();
    if (published) return published;

    // GitHub's tag endpoint does not expose draft releases. A token with push
    // access does receive drafts from the repository release listing, which is
    // required to resume a failed publication without creating a duplicate.
    const matches = [];
    for (let page = 1; page <= 20; page += 1) {
        const releases = await githubJson(
            `${apiBase}/repos/${repositoryPath}/releases?per_page=100&page=${page}`,
        );
        if (!Array.isArray(releases)) throw new Error('GitHub releases response is not an array');
        matches.push(...releases.filter((item) => item?.tag_name === tag));
        if (releases.length < 100) break;
        if (page === 20) {
            throw new Error(`Could not exhaustively search GitHub releases for draft ${tag}`);
        }
    }
    if (matches.length > 1) {
        throw new Error(`Multiple GitHub releases unexpectedly reference tag ${tag}`);
    }
    return matches[0] ?? null;
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
        const existing = await findReleaseByTag();
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

async function deleteDraftAsset(asset) {
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
    console.log(`Removed draft GitHub release asset ${String(asset.name)}; release downloads are hosted in S3.`);
}

let release = await findReleaseByTag();
if (!release) release = await createDraftRelease();
if (release.tag_name !== tag) throw new Error(`GitHub release tag mismatch for ${tag}`);

if (!release.draft) {
    assertPublishedMetadata(release);
    console.log(`GitHub release ${tag} is already published; S3 remains the download source.`);
} else {
    for (const asset of await listAssets(release.id)) await deleteDraftAsset(asset);

    const stillDraft = await getReleaseById(release.id);
    if (!stillDraft || stillDraft.id !== release.id || !stillDraft.draft) {
        throw new Error(`GitHub release ${tag} changed while its draft assets were being reconciled`);
    }
    release = stillDraft;
    if ((await listAssets(release.id)).length > 0) {
        throw new Error(`GitHub release ${tag} still has attached assets after cleanup`);
    }
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
    if ((await listAssets(published.id)).length > 0) {
        throw new Error(`Published GitHub release ${tag} unexpectedly has attached assets`);
    }
    console.log(`Published GitHub release ${tag} with S3 download links and no duplicated assets.`);
}
