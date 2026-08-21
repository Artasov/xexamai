import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {compareSemver} from './semver.mjs';

const [artifactsArgument, publicationArgument, tag, requestedMode = 'all'] = process.argv.slice(2);
const endpoint = (process.env.S3_ENDPOINT ?? '').replace(/\/$/, '');
const bucket = process.env.S3_BUCKET;
const region = process.env.AWS_DEFAULT_REGION;
const accessKey = process.env.AWS_ACCESS_KEY_ID;
const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
const sessionToken = process.env.AWS_SESSION_TOKEN;
const validModes = new Set(['all', 'immutable', 'channel']);
if (
    ![artifactsArgument, publicationArgument, tag, endpoint, bucket, region, accessKey, secretKey].every(Boolean) ||
    !validModes.has(requestedMode)
) {
    throw new Error(
        'Usage: upload-release-to-s3.mjs <artifacts-dir> <publication-dir> <tag> [all|immutable|channel] with S3 credentials/configuration',
    );
}

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encodePath = (value) => value
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
const mimeType = (name) => name.endsWith('.json')
    ? 'application/json'
    : name.endsWith('.md')
        ? 'text/markdown; charset=utf-8'
        : 'application/octet-stream';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// S3-compatible stores commonly return 403 for a missing public object when
// the publishing principal has PutObject/GetObject but no ListBucket access.
// Treat that response as "not observable" and let the conditional PUT decide:
// If-None-Match still prevents overwriting an existing object.
const isMissingOrUnobservable = (response) => [403, 404].includes(response.status);

async function sha256File(file) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    return digest.digest('hex');
}

function objectUrl(key) {
    return new URL(`${endpoint}/${bucket}/${encodePath(key)}`);
}

function cacheBusted(url, parameter) {
    const result = new URL(url);
    result.searchParams.set(parameter, crypto.randomUUID());
    return result;
}

async function existingObjectHash(url) {
    const response = await fetch(cacheBusted(url, 'immutable-check'), {cache: 'no-store'});
    if (isMissingOrUnobservable(response)) return null;
    if (!response.ok) {
        throw new Error(`Could not validate immutable S3 object ${url.pathname}: HTTP ${response.status}`);
    }
    const digest = crypto.createHash('sha256');
    if (response.body) {
        for await (const chunk of response.body) digest.update(chunk);
    }
    return digest.digest('hex');
}

async function signedPut(file, key, {mutable = false, precondition = {}} = {}) {
    const url = objectUrl(key);
    const payloadHash = await sha256File(file);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers = {
        'content-type': mimeType(file),
        'cache-control': mutable
            ? 'no-cache, no-store, must-revalidate'
            : 'public, max-age=31536000, immutable',
        host: url.host,
        'x-amz-acl': 'public-read',
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        ...precondition,
    };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames
        .map((name) => `${name}:${headers[name].trim()}\n`)
        .join('');
    const canonicalRequest = [
        'PUT',
        url.pathname,
        '',
        canonicalHeaders,
        signedHeaderNames.join(';'),
        payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        hash(canonicalRequest),
    ].join('\n');
    const dateKey = hmac(`AWS4${secretKey}`, dateStamp);
    const regionKey = hmac(dateKey, region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = crypto
        .createHmac('sha256', signingKey)
        .update(stringToSign)
        .digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
    const stat = fs.statSync(file);
    return fetch(url, {
        method: 'PUT',
        headers: {
            ...headers,
            Authorization: authorization,
            'Content-Length': String(stat.size),
        },
        body: fs.createReadStream(file),
        duplex: 'half',
    });
}

async function uploadImmutable(file, key) {
    const url = objectUrl(key);
    const payloadHash = await sha256File(file);
    const existingHash = await existingObjectHash(url);
    if (existingHash === payloadHash) {
        console.log(`Immutable object ${key} already exists with identical content; skipping.`);
        return;
    }
    if (existingHash !== null) {
        throw new Error(`Refusing to overwrite immutable S3 object ${key} with different content`);
    }

    const response = await signedPut(file, key, {
        precondition: {'if-none-match': '*'},
    });
    if (response.ok) {
        console.log(`Uploaded ${key}`);
        return;
    }
    if (response.status === 412) {
        const racedHash = await existingObjectHash(url);
        if (racedHash === payloadHash) {
            console.log(`Immutable object ${key} was concurrently published with identical content; skipping.`);
            return;
        }
        throw new Error(`Refusing to overwrite concurrently published immutable S3 object ${key}`);
    }
    throw new Error(`S3 upload failed for ${key}: HTTP ${response.status} ${await response.text()}`);
}

async function readCanonicalManifest(url) {
    const response = await fetch(cacheBusted(url, 'canonical-manifest-check'), {cache: 'no-store'});
    if (isMissingOrUnobservable(response)) return null;
    if (!response.ok) {
        throw new Error(`Could not read immutable release manifest ${url.pathname}: HTTP ${response.status}`);
    }
    const maximumBytes = 1024 * 1024;
    const chunks = [];
    let size = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > maximumBytes) {
                throw new Error(`Immutable release manifest ${url.pathname} exceeds ${maximumBytes} bytes`);
            }
            chunks.push(Buffer.from(chunk));
        }
    }
    return Buffer.concat(chunks);
}

function parseManifest(bytes, description) {
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new Error(`${description} is not valid JSON`, {cause: error});
    }
}

function assertSameReleaseManifest(remote, candidate, key) {
    if (
        typeof remote?.version !== 'string' ||
        remote.version !== candidate.version ||
        typeof remote.notes !== 'string' ||
        typeof remote.pub_date !== 'string' ||
        Number.isNaN(new Date(remote.pub_date).getTime()) ||
        !remote.platforms ||
        typeof remote.platforms !== 'object' ||
        Array.isArray(remote.platforms) ||
        stableJson(remote.platforms) !== stableJson(candidate.platforms)
    ) {
        throw new Error(`Refusing to replace or adopt mismatched immutable release manifest ${key}`);
    }
}

function synchronizeReleaseBodyNotes(publicationDirectory, notes) {
    const bodyPath = path.join(publicationDirectory, 'release-body.md');
    if (!fs.existsSync(bodyPath)) {
        throw new Error(`Release body is missing: ${bodyPath}`);
    }
    const body = fs.readFileSync(bodyPath, 'utf8');
    const marker = '---\n\n## Changes\n\n';
    const markerIndex = body.indexOf(marker);
    if (markerIndex < 0) {
        throw new Error('Release body does not contain the canonical Changes section');
    }
    const canonicalNotes = notes.trim() || 'No release notes were generated.';
    const synchronized = `${body.slice(0, markerIndex + marker.length)}${canonicalNotes}\n`;
    if (synchronized !== body) {
        fs.writeFileSync(bodyPath, synchronized);
        console.log('Synchronized GitHub release notes with the canonical updater manifest.');
    }
}

function adoptImmutableManifest(file, key, candidate, localBytes, remoteBytes) {
    const remote = parseManifest(remoteBytes, `Immutable release manifest ${key}`);
    assertSameReleaseManifest(remote, candidate, key);
    if (!remoteBytes.equals(localBytes)) {
        // Release notes can legitimately be regenerated differently on a
        // historical rerun. The first immutable per-tag manifest is canonical;
        // reuse it byte-for-byte instead of making the release unrecoverable.
        fs.writeFileSync(file, remoteBytes);
        console.log(`Adopted existing canonical immutable release manifest ${key}.`);
    } else {
        console.log(`Immutable release manifest ${key} already exists identically; skipping.`);
    }
    return remote;
}

async function uploadOrAdoptImmutableManifest(file, key, candidate) {
    const url = objectUrl(key);
    const localBytes = fs.readFileSync(file);
    let remoteBytes = await readCanonicalManifest(url);
    if (!remoteBytes) {
        const response = await signedPut(file, key, {precondition: {'if-none-match': '*'}});
        if (response.ok) {
            console.log(`Uploaded ${key}`);
            return candidate;
        }
        if (![409, 412].includes(response.status)) {
            throw new Error(`S3 upload failed for ${key}: HTTP ${response.status} ${await response.text()}`);
        }
        remoteBytes = await readCanonicalManifest(url);
        if (!remoteBytes) {
            throw new Error(`Immutable release manifest ${key} raced publication but is still unavailable`);
        }
    }

    return adoptImmutableManifest(file, key, candidate, localBytes, remoteBytes);
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function compareChannelManifest(current, candidate, channel) {
    if (!current || typeof current.version !== 'string') {
        throw new Error(`Existing ${channel} manifest has no semantic version`);
    }
    const comparison = compareSemver(current.version, candidate.version);
    if (comparison > 0) {
        return {
            publish: false,
            message: `Channel ${channel} already points to newer ${current.version}; leaving it unchanged.`,
        };
    }
    if (comparison === 0) {
        if (stableJson(current.platforms ?? {}) !== stableJson(candidate.platforms ?? {})) {
            throw new Error(
                `Refusing to mutate already published ${channel} release ${candidate.version}`,
            );
        }
        return {
            publish: false,
            message: `Channel ${channel} already points to ${candidate.version} with identical signed artifacts.`,
        };
    }
    return {publish: true};
}

async function readChannelManifest(key, channel) {
    const url = objectUrl(key);
    const response = await fetch(cacheBusted(url, 'release-check'), {cache: 'no-store'});
    if (isMissingOrUnobservable(response)) return {manifest: null, etag: null};
    if (!response.ok) {
        throw new Error(`Could not validate existing ${channel} manifest: HTTP ${response.status}`);
    }
    const etag = response.headers.get('etag');
    if (!etag) {
        throw new Error(`Existing ${channel} manifest response has no ETag; refusing a non-atomic update`);
    }
    let manifest;
    try {
        manifest = await response.json();
    } catch (error) {
        throw new Error(`Existing ${channel} manifest is not valid JSON`, {cause: error});
    }
    return {manifest, etag};
}

async function publishChannelManifest(file, key, candidate, channel) {
    const maximumAttempts = 8;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const current = await readChannelManifest(key, channel);
        if (current.manifest) {
            const decision = compareChannelManifest(current.manifest, candidate, channel);
            if (!decision.publish) {
                console.log(decision.message);
                return;
            }
        }

        const precondition = current.etag
            ? {'if-match': current.etag}
            : {'if-none-match': '*'};
        const response = await signedPut(file, key, {mutable: true, precondition});
        if (response.ok) {
            console.log(`Atomically promoted ${channel} channel to ${candidate.version}.`);
            return;
        }
        if (![404, 409, 412].includes(response.status)) {
            throw new Error(
                `S3 channel promotion failed for ${key}: HTTP ${response.status} ${await response.text()}`,
            );
        }
        console.log(
            `Channel ${channel} changed during promotion (HTTP ${response.status}); rereading before retry ${attempt}/${maximumAttempts}.`,
        );
        if (attempt < maximumAttempts) {
            await sleep(Math.min(25 * (2 ** (attempt - 1)), 400));
        }
    }
    throw new Error(`Could not atomically promote ${channel} channel after 8 attempts`);
}

const artifactsDirectory = path.resolve(artifactsArgument);
const publicationDirectory = path.resolve(publicationArgument);
const publication = JSON.parse(
    fs.readFileSync(path.join(publicationDirectory, 'publication.json'), 'utf8'),
);
const manifestPath = path.join(publicationDirectory, 'latest.json');
let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (requestedMode !== 'channel') {
    const tagManifestKey = `xexamai/${tag}/latest.json`;
    const localManifestBytes = fs.readFileSync(manifestPath);
    const existingManifestBytes = await readCanonicalManifest(objectUrl(tagManifestKey));
    if (existingManifestBytes) {
        // Validate the canonical release identity before writing any other
        // immutable keys for this tag.
        manifest = adoptImmutableManifest(
            manifestPath,
            tagManifestKey,
            manifest,
            localManifestBytes,
            existingManifestBytes,
        );
    }
    for (const platformEntry of fs
        .readdirSync(artifactsDirectory, {withFileTypes: true})
        .filter((entry) => entry.isDirectory())) {
        const filesDirectory = path.join(artifactsDirectory, platformEntry.name, 'files');
        if (!fs.existsSync(filesDirectory)) continue;
        for (const filename of fs.readdirSync(filesDirectory)) {
            await uploadImmutable(
                path.join(filesDirectory, filename),
                `xexamai/${tag}/${platformEntry.name}/${filename}`,
            );
        }
    }
    if (!existingManifestBytes) {
        manifest = await uploadOrAdoptImmutableManifest(manifestPath, tagManifestKey, manifest);
    }
    synchronizeReleaseBodyNotes(publicationDirectory, manifest.notes);
}

if (requestedMode !== 'immutable') {
    await publishChannelManifest(
        manifestPath,
        `xexamai/${publication.manifestName}`,
        manifest,
        publication.channel,
    );
}
