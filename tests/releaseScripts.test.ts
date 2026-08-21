import {execFile, execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {nextStableVersion} from '../scripts/release.mjs';
import {compareSemver, isPrerelease} from '../scripts/semver.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xexamai-release-'));
    temporaryDirectories.push(directory);
    return directory;
}

function runScript(script: string, arguments_: string[], environment: NodeJS.ProcessEnv = {}): void {
    execFileSync(process.execPath, [path.join(root, 'scripts', script), ...arguments_], {
        cwd: root,
        env: {...process.env, ...environment},
        stdio: 'pipe',
    });
}

async function runScriptAsync(script: string, arguments_: string[], environment: NodeJS.ProcessEnv = {}): Promise<void> {
    await execFileAsync(process.execPath, [path.join(root, 'scripts', script), ...arguments_], {
        cwd: root,
        env: {...process.env, ...environment},
    });
}

async function fakeS3(initial: Record<string, string>, missingStatus = 404) {
    const objects = new Map<string, Buffer>(
        Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]),
    );
    const etags = new Map<string, string>();
    const raceValues = new Map<string, Buffer>();
    const puts: Array<{path: string; ifMatch?: string; ifNoneMatch?: string}> = [];
    const assignEtag = (pathname: string, body: Buffer) => {
        const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
        etags.set(pathname, etag);
        return etag;
    };
    for (const [pathname, body] of objects) assignEtag(pathname, body);
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (request.method === 'GET') {
            const body = objects.get(pathname);
            if (!body) {
                response.statusCode = missingStatus;
                response.end();
                return;
            }
            response.statusCode = 200;
            response.setHeader('ETag', etags.get(pathname) ?? assignEtag(pathname, body));
            response.end(body);
            return;
        }
        if (request.method !== 'PUT') {
            response.statusCode = 405;
            response.end();
            return;
        }
        const ifNoneMatch = request.headers['if-none-match'];
        const ifMatch = request.headers['if-match'];
        puts.push({
            path: pathname,
            ifMatch: typeof ifMatch === 'string' ? ifMatch : undefined,
            ifNoneMatch: typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined,
        });
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
            const raceValue = raceValues.get(pathname);
            if (raceValue) {
                raceValues.delete(pathname);
                objects.set(pathname, raceValue);
                assignEtag(pathname, raceValue);
                response.statusCode = 412;
                response.end();
                return;
            }
            if (
                (ifNoneMatch === '*' && objects.has(pathname)) ||
                (typeof ifMatch === 'string' && etags.get(pathname) !== ifMatch)
            ) {
                response.statusCode = 412;
                response.end();
                return;
            }
            const body = Buffer.concat(chunks);
            objects.set(pathname, body);
            assignEtag(pathname, body);
            response.statusCode = 200;
            response.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake S3 did not bind a TCP port');
    return {
        endpoint: `http://127.0.0.1:${address.port}`,
        objects,
        puts,
        injectRace: (pathname: string, value: string) => {
            raceValues.set(pathname, Buffer.from(value));
        },
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

type GitHubAssetFixture = {
    name: string;
    content: string;
    digest?: boolean;
};

async function fakeGitHub(options: {
    exists?: boolean;
    readStatus?: number;
    draft?: boolean;
    immutable?: boolean;
    prerelease?: boolean;
    name?: string;
    body?: string;
    assets?: GitHubAssetFixture[];
} = {}) {
    let endpoint = '';
    let nextAssetId = 1;
    let release = options.exists === false
        ? null
        : {
            id: 1,
            tag_name: 'v2.5.0',
            name: options.name ?? 'v2.5.0',
            body: options.body ?? 'Release body',
            draft: options.draft ?? true,
            prerelease: options.prerelease ?? false,
            immutable: options.immutable ?? false,
        };
    const assets = new Map<number, {
        id: number;
        name: string;
        content: Buffer;
        includeDigest: boolean;
    }>();
    for (const item of options.assets ?? []) {
        const id = nextAssetId++;
        assets.set(id, {
            id,
            name: item.name,
            content: Buffer.from(item.content),
            includeDigest: item.digest ?? true,
        });
    }
    const uploads: string[] = [];
    const deletes: string[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let creates = 0;

    const readBody = (request: http.IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
    const writeJson = (response: http.ServerResponse, status: number, value: unknown) => {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(value));
    };
    const releaseJson = () => {
        if (!release) return null;
        return {
            ...release,
            upload_url: `${endpoint}/uploads/${release.id}/assets{?name,label}`,
        };
    };
    const assetJson = (asset: NonNullable<ReturnType<typeof assets.get>>) => ({
        id: asset.id,
        name: asset.name,
        size: asset.content.length,
        state: 'uploaded',
        digest: asset.includeDigest
            ? `sha256:${crypto.createHash('sha256').update(asset.content).digest('hex')}`
            : null,
        url: `${endpoint}/repos/acme/xexamai/releases/assets/${asset.id}`,
    });

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        if (request.method === 'GET' && pathname === '/repos/acme/xexamai/releases/tags/v2.5.0') {
            if (options.readStatus && options.readStatus !== 200) {
                writeJson(response, options.readStatus, {message: 'injected read failure'});
                return;
            }
            if (!release) {
                writeJson(response, 404, {message: 'Not Found'});
                return;
            }
            writeJson(response, 200, releaseJson());
            return;
        }
        if (request.method === 'POST' && pathname === '/repos/acme/xexamai/releases') {
            if (release) {
                writeJson(response, 422, {message: 'already_exists'});
                return;
            }
            const payload = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
            creates += 1;
            release = {
                id: 1,
                tag_name: String(payload.tag_name),
                name: String(payload.name),
                body: String(payload.body),
                draft: Boolean(payload.draft),
                prerelease: Boolean(payload.prerelease),
                immutable: false,
            };
            writeJson(response, 201, releaseJson());
            return;
        }
        if (request.method === 'GET' && pathname === '/repos/acme/xexamai/releases/1/assets') {
            writeJson(response, 200, [...assets.values()].map(assetJson));
            return;
        }
        const assetMatch = pathname.match(/^\/repos\/acme\/xexamai\/releases\/assets\/(\d+)$/);
        if (assetMatch && request.method === 'GET') {
            const asset = assets.get(Number(assetMatch[1]));
            if (!asset) {
                writeJson(response, 404, {message: 'Not Found'});
                return;
            }
            response.statusCode = 200;
            response.end(asset.content);
            return;
        }
        if (assetMatch && request.method === 'DELETE') {
            const id = Number(assetMatch[1]);
            const asset = assets.get(id);
            if (!asset) {
                writeJson(response, 404, {message: 'Not Found'});
                return;
            }
            deletes.push(asset.name);
            assets.delete(id);
            response.statusCode = 204;
            response.end();
            return;
        }
        if (request.method === 'POST' && pathname === '/uploads/1/assets') {
            const name = url.searchParams.get('name');
            if (!name || [...assets.values()].some((asset) => asset.name === name)) {
                writeJson(response, 422, {message: 'already_exists'});
                return;
            }
            const content = await readBody(request);
            const id = nextAssetId++;
            const asset = {id, name, content, includeDigest: true};
            assets.set(id, asset);
            uploads.push(name);
            writeJson(response, 201, assetJson(asset));
            return;
        }
        if (request.method === 'PATCH' && pathname === '/repos/acme/xexamai/releases/1') {
            if (!release) {
                writeJson(response, 404, {message: 'Not Found'});
                return;
            }
            const payload = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
            patches.push(payload);
            release = {...release, ...payload};
            writeJson(response, 200, releaseJson());
            return;
        }
        writeJson(response, 404, {message: `Unhandled ${request.method} ${pathname}`});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake GitHub did not bind a TCP port');
    endpoint = `http://127.0.0.1:${address.port}`;
    return {
        endpoint,
        assets,
        uploads,
        deletes,
        patches,
        get release() {
            return release;
        },
        get creates() {
            return creates;
        },
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

function createUploadFixture(directory: string, content = 'signed artifact') {
    const artifacts = path.join(directory, 'artifacts');
    const files = path.join(artifacts, 'windows', 'files');
    const publication = path.join(directory, 'publication');
    fs.mkdirSync(files, {recursive: true});
    fs.mkdirSync(publication, {recursive: true});
    fs.writeFileSync(path.join(files, 'app.bin'), content);
    fs.writeFileSync(path.join(publication, 'publication.json'), JSON.stringify({
        channel: 'stable',
        manifestName: 'latest.json',
    }));
    fs.writeFileSync(path.join(publication, 'latest.json'), JSON.stringify({
        version: '2.5.0',
        notes: 'current notes',
        pub_date: '2026-08-20T14:23:45.000Z',
        platforms: {windows: {url: 'https://example.invalid/app.bin', signature: 'signature'}},
    }));
    fs.writeFileSync(
        path.join(publication, 'release-body.md'),
        'Release downloads\n\n---\n\n## Changes\n\ncurrent notes\n',
    );
    return {artifacts, publication};
}

function createGitHubFixture(directory: string, files: Record<string, string>) {
    const artifacts = path.join(directory, 'artifacts');
    const filesDirectory = path.join(artifacts, 'windows', 'files');
    const bodyFile = path.join(directory, 'release-body.md');
    fs.mkdirSync(filesDirectory, {recursive: true});
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(filesDirectory, name), content);
    }
    fs.writeFileSync(bodyFile, 'Release body');
    return {artifacts, bodyFile};
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

describe('release artifact scripts', () => {
    it('computes explicit stable release increments for the IDE shortcuts', () => {
        expect(nextStableVersion('2.4.1', 'patch')).toBe('2.4.2');
        expect(nextStableVersion('2.4.1', 'minor')).toBe('2.5.0');
        expect(nextStableVersion('2.4.1', 'major')).toBe('3.0.0');
        expect(() => nextStableVersion('2.5.0-beta.1', 'patch')).toThrow(
            /only accept a stable version/,
        );
        expect(() => nextStableVersion('2.4.1', 'preview')).toThrow(
            /patch, minor or major/,
        );
    });

    it('classifies every valid SemVer prerelease and preserves SemVer ordering', () => {
        expect(isPrerelease('2.5.0-preview.1')).toBe(true);
        expect(isPrerelease('2.5.0-dev.7+build.3')).toBe(true);
        expect(isPrerelease('2.5.0')).toBe(false);
        expect(compareSemver('2.5.0-preview.2', '2.5.0-preview.10')).toBeLessThan(0);
        expect(compareSemver('2.5.0-preview.9007199254740993', '2.5.0-preview.9007199254740994')).toBeLessThan(0);
        expect(compareSemver('2.5.0-rc.1', '2.5.0')).toBeLessThan(0);
        expect(() => isPrerelease('2.5')).toThrow(/Invalid semantic version/);
        expect(() => isPrerelease('2.5.0-rc.01')).toThrow(/Invalid semantic version/);
    });

    it('selects a signed native Windows updater payload', () => {
        const directory = temporaryDirectory();
        const bundle = path.join(directory, 'bundle', 'nsis');
        const output = path.join(directory, 'output');
        fs.mkdirSync(bundle, {recursive: true});
        fs.writeFileSync(path.join(bundle, 'XEXAMAI_2.4.1_x64-setup.exe'), 'installer');
        fs.writeFileSync(path.join(bundle, 'XEXAMAI_2.4.1_x64-setup.exe.sig'), 'signature');
        fs.writeFileSync(path.join(bundle, 'XEXAMAI_2.4.1_x64_en-US.msi'), 'msi installer');
        fs.writeFileSync(path.join(bundle, 'XEXAMAI_2.4.1_x64_en-US.msi.sig'), 'msi signature');

        runScript('prepare-release-artifacts.mjs', [path.dirname(bundle), output, 'windows'], {
            RUNNER_ARCH: 'X64',
        });

        const metadata = JSON.parse(fs.readFileSync(path.join(output, 'windows', 'metadata.json'), 'utf8'));
        expect(metadata).toMatchObject({
            platform: 'windows',
            updaters: [
                {
                    target: 'windows-x86_64-nsis',
                    updaterFile: 'XEXAMAI_2.4.1_x64-setup.exe',
                    signature: 'signature',
                },
                {
                    target: 'windows-x86_64-msi',
                    updaterFile: 'XEXAMAI_2.4.1_x64_en-US.msi',
                    signature: 'msi signature',
                },
            ],
        });
        expect(metadata.files).toEqual([
            'XEXAMAI_2.4.1_x64-setup.exe',
            'XEXAMAI_2.4.1_x64-setup.exe.sig',
            'XEXAMAI_2.4.1_x64_en-US.msi',
            'XEXAMAI_2.4.1_x64_en-US.msi.sig',
        ]);
    });

    it('selects the signed native AppImage as the Linux updater payload', () => {
        const directory = temporaryDirectory();
        const bundle = path.join(directory, 'bundle', 'appimage');
        const output = path.join(directory, 'output');
        fs.mkdirSync(bundle, {recursive: true});
        fs.writeFileSync(path.join(bundle, 'XEXAMAI_2.4.1_amd64.AppImage'), 'updater bundle');
        fs.writeFileSync(path.join(bundle, 'XEXAMAI_2.4.1_amd64.AppImage.sig'), 'signature');
        fs.writeFileSync(path.join(bundle, 'XEXAMAI_2.4.1_amd64.deb'), 'deb package');
        fs.writeFileSync(path.join(bundle, 'XEXAMAI_2.4.1_amd64.deb.sig'), 'deb signature');

        runScript('prepare-release-artifacts.mjs', [path.dirname(bundle), output, 'linux'], {
            RUNNER_ARCH: 'X64',
        });

        const metadata = JSON.parse(fs.readFileSync(path.join(output, 'linux', 'metadata.json'), 'utf8'));
        expect(metadata).toMatchObject({
            platform: 'linux',
            updaters: [
                {
                    target: 'linux-x86_64-appimage',
                    updaterFile: 'XEXAMAI_2.4.1_amd64.AppImage',
                    signature: 'signature',
                },
                {
                    target: 'linux-x86_64-deb',
                    updaterFile: 'XEXAMAI_2.4.1_amd64.deb',
                    signature: 'deb signature',
                },
            ],
        });
        expect(metadata.files).toContain('XEXAMAI_2.4.1_amd64.AppImage');
        expect(metadata.files).toContain('XEXAMAI_2.4.1_amd64.AppImage.sig');
    });

    it('builds a beta channel manifest only when every desktop platform is signed', () => {
        const directory = temporaryDirectory();
        const artifacts = path.join(directory, 'artifacts');
        const output = path.join(directory, 'publication');
        const notes = path.join(directory, 'notes.md');
        fs.writeFileSync(notes, 'Release notes');

        for (const [folder, updaters] of [
            ['windows', [
                {target: 'windows-x86_64-nsis', updaterFile: 'app-setup.exe'},
                {target: 'windows-x86_64-msi', updaterFile: 'app.msi'},
            ]],
            ['macos', [{target: 'darwin-aarch64-app', updaterFile: 'app.app.tar.gz'}]],
            ['linux', [
                {target: 'linux-x86_64-appimage', updaterFile: 'app.AppImage'},
                {target: 'linux-x86_64-deb', updaterFile: 'app.deb'},
            ]],
        ] as const) {
            const platformDirectory = path.join(artifacts, folder);
            fs.mkdirSync(platformDirectory, {recursive: true});
            fs.writeFileSync(path.join(platformDirectory, 'metadata.json'), JSON.stringify({
                platform: folder,
                updaters: updaters.map((updater) => ({...updater, signature: `${updater.target}-signature`})),
                files: updaters.map((updater) => updater.updaterFile),
            }));
        }

        runScript('build-update-manifest.mjs', [
            artifacts,
            'v2.5.0-beta.1',
            notes,
            output,
            '2026-08-20T18:23:45+04:00',
        ], {
            S3_ENDPOINT: 'https://updates.example.test',
            S3_BUCKET: 'desktop-releases',
        });

        const manifest = JSON.parse(fs.readFileSync(path.join(output, 'latest.json'), 'utf8'));
        const publication = JSON.parse(fs.readFileSync(path.join(output, 'publication.json'), 'utf8'));
        expect(manifest.version).toBe('2.5.0-beta.1');
        expect(manifest.pub_date).toBe('2026-08-20T14:23:45.000Z');
        expect(Object.keys(manifest.platforms).sort()).toEqual([
            'darwin-aarch64-app',
            'linux-x86_64-appimage',
            'linux-x86_64-deb',
            'windows-x86_64-msi',
            'windows-x86_64-nsis',
        ]);
        expect(manifest.platforms['windows-x86_64-nsis'].url).toContain('/app-setup.exe');
        expect(publication).toEqual({channel: 'beta', manifestName: 'latest-beta.json'});

        const secondOutput = path.join(directory, 'publication-rerun');
        runScript('build-update-manifest.mjs', [
            artifacts,
            'v2.5.0-beta.1',
            notes,
            secondOutput,
            '2026-08-20T18:23:45+04:00',
        ], {
            S3_ENDPOINT: 'https://updates.example.test',
            S3_BUCKET: 'desktop-releases',
        });
        expect(fs.readFileSync(path.join(secondOutput, 'latest.json')))
            .toEqual(fs.readFileSync(path.join(output, 'latest.json')));
    });

    it('routes non-alpha prereleases to the beta manifest', () => {
        const directory = temporaryDirectory();
        const artifacts = path.join(directory, 'artifacts');
        const output = path.join(directory, 'publication');
        const notes = path.join(directory, 'notes.md');
        fs.writeFileSync(notes, 'Preview notes');
        for (const [folder, updaters] of [
            ['windows', [
                {target: 'windows-x86_64-nsis', updaterFile: 'windows.exe'},
                {target: 'windows-x86_64-msi', updaterFile: 'windows.msi'},
            ]],
            ['macos', [{target: 'darwin-aarch64-app', updaterFile: 'macos.tar.gz'}]],
            ['linux', [
                {target: 'linux-x86_64-appimage', updaterFile: 'linux.AppImage'},
                {target: 'linux-x86_64-deb', updaterFile: 'linux.deb'},
            ]],
        ] as const) {
            const platformDirectory = path.join(artifacts, folder);
            fs.mkdirSync(platformDirectory, {recursive: true});
            fs.writeFileSync(path.join(platformDirectory, 'metadata.json'), JSON.stringify({
                platform: folder,
                updaters: updaters.map((updater) => ({...updater, signature: `${updater.target}-signature`})),
                files: updaters.map((updater) => updater.updaterFile),
            }));
        }

        runScript('build-update-manifest.mjs', [
            artifacts,
            'v2.5.0-preview.1',
            notes,
            output,
            '2026-08-20T14:23:45Z',
        ], {
            S3_ENDPOINT: 'https://updates.example.test',
            S3_BUCKET: 'desktop-releases',
        });
        expect(JSON.parse(fs.readFileSync(path.join(output, 'publication.json'), 'utf8')))
            .toEqual({channel: 'beta', manifestName: 'latest-beta.json'});
    });

    it('keeps partially published tag objects immutable and resumes identical uploads', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const server = await fakeS3({
            '/bucket/xexamai/v2.5.0/windows/app.bin': 'signed artifact',
        });
        try {
            await runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            );
        } finally {
            await server.close();
        }

        expect(server.puts.find((item) => item.path.endsWith('/windows/app.bin'))).toBeUndefined();
        expect(server.puts.find((item) => item.path.endsWith('/v2.5.0/latest.json'))?.ifNoneMatch).toBe('*');
        expect(server.puts.find((item) => item.path.endsWith('/xexamai/latest.json'))?.ifNoneMatch).toBe('*');
    });

    it('publishes safely when missing S3 objects are hidden behind HTTP 403', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const server = await fakeS3({}, 403);
        try {
            await runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            );
        } finally {
            await server.close();
        }

        expect(server.puts.find((item) => item.path.endsWith('/windows/app.bin'))?.ifNoneMatch).toBe('*');
        expect(server.puts.find((item) => item.path.endsWith('/v2.5.0/latest.json'))?.ifNoneMatch).toBe('*');
        expect(server.puts.find((item) => item.path.endsWith('/xexamai/latest.json'))?.ifNoneMatch).toBe('*');
        expect(JSON.parse(server.objects.get('/bucket/xexamai/latest.json')?.toString() ?? '{}').version)
            .toBe('2.5.0');
    });

    it('refuses to overwrite a mismatched object from a partial release', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const immutablePath = '/bucket/xexamai/v2.5.0/windows/app.bin';
        const server = await fakeS3({[immutablePath]: 'different build'});
        try {
            await expect(runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            )).rejects.toThrow();
        } finally {
            await server.close();
        }

        expect(server.objects.get(immutablePath)?.toString()).toBe('different build');
        expect(server.puts.find((item) => item.path === immutablePath)).toBeUndefined();
    });

    it('adopts the first immutable tag manifest byte-for-byte on a historical rerun', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const tagManifestPath = '/bucket/xexamai/v2.5.0/latest.json';
        const canonicalManifest = `${JSON.stringify({
            version: '2.5.0',
            notes: 'original generated notes',
            pub_date: '2026-08-19T10:00:00.000Z',
            platforms: {windows: {signature: 'signature', url: 'https://example.invalid/app.bin'}},
        }, null, 2)}\n`;
        const server = await fakeS3({
            '/bucket/xexamai/v2.5.0/windows/app.bin': 'signed artifact',
            [tagManifestPath]: canonicalManifest,
        });
        try {
            await runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0', 'immutable'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            );
        } finally {
            await server.close();
        }

        expect(fs.readFileSync(path.join(fixture.publication, 'latest.json'), 'utf8'))
            .toBe(canonicalManifest);
        expect(fs.readFileSync(path.join(fixture.publication, 'release-body.md'), 'utf8'))
            .toBe('Release downloads\n\n---\n\n## Changes\n\noriginal generated notes\n');
        expect(server.puts.find((item) => item.path === tagManifestPath)).toBeUndefined();
    });

    it('validates an existing tag manifest before writing any immutable release objects', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const tagManifestPath = '/bucket/xexamai/v2.5.0/latest.json';
        const server = await fakeS3({
            [tagManifestPath]: JSON.stringify({
                version: '2.5.0',
                notes: 'other build',
                pub_date: '2026-08-19T10:00:00.000Z',
                platforms: {windows: {url: 'https://example.invalid/other.bin', signature: 'other'}},
            }),
        });
        try {
            await expect(runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0', 'immutable'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            )).rejects.toThrow();
        } finally {
            await server.close();
        }

        expect(server.puts).toEqual([]);
        expect(server.objects.has('/bucket/xexamai/v2.5.0/windows/app.bin')).toBe(false);
    });

    it('retries a raced first channel publication with an ETag compare-and-swap', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const channelPath = '/bucket/xexamai/latest.json';
        const server = await fakeS3({});
        server.injectRace(channelPath, JSON.stringify({
            version: '2.4.0',
            platforms: {windows: {url: 'old', signature: 'old'}},
        }));
        try {
            await runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0', 'channel'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            );
        } finally {
            await server.close();
        }

        const channelPuts = server.puts.filter((item) => item.path === channelPath);
        expect(channelPuts).toHaveLength(2);
        expect(channelPuts[0]).toMatchObject({ifNoneMatch: '*'});
        expect(channelPuts[1]?.ifMatch).toMatch(/^"[a-f0-9]{32}"$/);
        expect(JSON.parse(server.objects.get(channelPath)?.toString() ?? '{}').version).toBe('2.5.0');
    });

    it('never rolls a channel pointer back when a newer tag wins the ETag race', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const channelPath = '/bucket/xexamai/latest.json';
        const server = await fakeS3({
            [channelPath]: JSON.stringify({
                version: '2.4.0',
                platforms: {windows: {url: 'old', signature: 'old'}},
            }),
        });
        server.injectRace(channelPath, JSON.stringify({
            version: '2.6.0',
            platforms: {windows: {url: 'newer', signature: 'newer'}},
        }));
        try {
            await runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0', 'channel'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            );
        } finally {
            await server.close();
        }

        expect(server.puts.filter((item) => item.path === channelPath)).toHaveLength(1);
        expect(JSON.parse(server.objects.get(channelPath)?.toString() ?? '{}').version).toBe('2.6.0');
    });

    it('accepts an identical same-version channel manifest regardless of JSON key order', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const channelPath = '/bucket/xexamai/latest.json';
        const server = await fakeS3({
            [channelPath]: JSON.stringify({
                platforms: {windows: {signature: 'signature', url: 'https://example.invalid/app.bin'}},
                version: '2.5.0',
            }),
        });
        try {
            await runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0', 'channel'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            );
        } finally {
            await server.close();
        }

        expect(server.puts.filter((item) => item.path === channelPath)).toEqual([]);
    });

    it('refuses a same-version channel pointer with different signed artifacts', async () => {
        const directory = temporaryDirectory();
        const fixture = createUploadFixture(directory);
        const channelPath = '/bucket/xexamai/latest.json';
        const original = JSON.stringify({
            version: '2.5.0',
            platforms: {windows: {url: 'different', signature: 'different'}},
        });
        const server = await fakeS3({[channelPath]: original});
        try {
            await expect(runScriptAsync(
                'upload-release-to-s3.mjs',
                [fixture.artifacts, fixture.publication, 'v2.5.0', 'channel'],
                {
                    S3_ENDPOINT: server.endpoint,
                    S3_BUCKET: 'bucket',
                    AWS_DEFAULT_REGION: 'test-1',
                    AWS_ACCESS_KEY_ID: 'test-access',
                    AWS_SECRET_ACCESS_KEY: 'test-secret',
                },
            )).rejects.toThrow();
        } finally {
            await server.close();
        }

        expect(server.puts.filter((item) => item.path === channelPath)).toEqual([]);
        expect(server.objects.get(channelPath)?.toString()).toBe(original);
    });

    it('repairs a partial draft release, preserves matching bytes and publishes an exact set', async () => {
        const directory = temporaryDirectory();
        const fixture = createGitHubFixture(directory, {
            'app.bin': 'correct application',
            'app.sig': 'correct signature',
            'manual.txt': 'manual',
        });
        const server = await fakeGitHub({
            draft: true,
            name: 'unfinished',
            body: 'old body',
            assets: [
                {name: 'app.bin', content: 'correct application', digest: false},
                {name: 'app.sig', content: 'broken signature'},
                {name: 'stale.bin', content: 'stale'},
            ],
        });
        const preservedId = [...server.assets.values()].find((asset) => asset.name === 'app.bin')?.id;
        try {
            await runScriptAsync(
                'reconcile-github-release.mjs',
                ['acme/xexamai', 'v2.5.0', 'commit-sha', fixture.bodyFile, fixture.artifacts, 'false'],
                {GITHUB_API_URL: server.endpoint, GH_TOKEN: 'test-token'},
            );
        } finally {
            await server.close();
        }

        expect(server.deletes.sort()).toEqual(['app.sig', 'stale.bin']);
        expect(server.uploads.sort()).toEqual(['app.sig', 'manual.txt']);
        expect([...server.assets.values()].find((asset) => asset.name === 'app.bin')?.id).toBe(preservedId);
        expect([...server.assets.values()].map((asset) => asset.name).sort()).toEqual([
            'app.bin',
            'app.sig',
            'manual.txt',
        ]);
        expect(server.release).toMatchObject({draft: false, name: 'v2.5.0', body: 'Release body'});
        expect(server.patches).toHaveLength(1);
    });

    it('creates a missing release as a draft before uploading and publishing it', async () => {
        const directory = temporaryDirectory();
        const fixture = createGitHubFixture(directory, {'app.bin': 'application'});
        const server = await fakeGitHub({exists: false});
        try {
            await runScriptAsync(
                'reconcile-github-release.mjs',
                ['acme/xexamai', 'v2.5.0', 'commit-sha', fixture.bodyFile, fixture.artifacts, 'false'],
                {GITHUB_API_URL: server.endpoint, GH_TOKEN: 'test-token'},
            );
        } finally {
            await server.close();
        }

        expect(server.creates).toBe(1);
        expect(server.uploads).toEqual(['app.bin']);
        expect(server.release).toMatchObject({draft: false, name: 'v2.5.0'});
    });

    it('does not mutate a published release with a mismatched asset', async () => {
        const directory = temporaryDirectory();
        const fixture = createGitHubFixture(directory, {
            'app.bin': 'correct application',
            'app.sig': 'correct signature',
        });
        const server = await fakeGitHub({
            draft: false,
            assets: [{name: 'app.bin', content: 'wrong application'}],
        });
        try {
            await expect(runScriptAsync(
                'reconcile-github-release.mjs',
                ['acme/xexamai', 'v2.5.0', 'commit-sha', fixture.bodyFile, fixture.artifacts, 'false'],
                {GITHUB_API_URL: server.endpoint, GH_TOKEN: 'test-token'},
            )).rejects.toThrow();
        } finally {
            await server.close();
        }

        expect(server.deletes).toEqual([]);
        expect(server.uploads).toEqual([]);
        expect(server.patches).toEqual([]);
        expect([...server.assets.values()][0]?.content.toString()).toBe('wrong application');
        expect(server.release).toMatchObject({draft: false});
    });

    it('does not fill in a missing asset on an already-published release', async () => {
        const directory = temporaryDirectory();
        const fixture = createGitHubFixture(directory, {
            'app.bin': 'application',
            'app.sig': 'signature',
        });
        const server = await fakeGitHub({
            draft: false,
            assets: [{name: 'app.bin', content: 'application'}],
        });
        try {
            await expect(runScriptAsync(
                'reconcile-github-release.mjs',
                ['acme/xexamai', 'v2.5.0', 'commit-sha', fixture.bodyFile, fixture.artifacts, 'false'],
                {GITHUB_API_URL: server.endpoint, GH_TOKEN: 'test-token'},
            )).rejects.toThrow();
        } finally {
            await server.close();
        }

        expect(server.uploads).toEqual([]);
        expect(server.deletes).toEqual([]);
        expect(server.patches).toEqual([]);
    });

    it('accepts an exact published asset set without rewriting historical release notes', async () => {
        const directory = temporaryDirectory();
        const fixture = createGitHubFixture(directory, {'app.bin': 'application'});
        const server = await fakeGitHub({
            draft: false,
            name: 'Historical title',
            body: 'Historical release notes',
            assets: [{name: 'app.bin', content: 'application'}],
        });
        try {
            await runScriptAsync(
                'reconcile-github-release.mjs',
                ['acme/xexamai', 'v2.5.0', 'commit-sha', fixture.bodyFile, fixture.artifacts, 'false'],
                {GITHUB_API_URL: server.endpoint, GH_TOKEN: 'test-token'},
            );
        } finally {
            await server.close();
        }

        expect(server.uploads).toEqual([]);
        expect(server.deletes).toEqual([]);
        expect(server.patches).toEqual([]);
        expect(server.release).toMatchObject({
            draft: false,
            name: 'Historical title',
            body: 'Historical release notes',
        });
    });

    it('does not treat a GitHub API failure as an absent release', async () => {
        const directory = temporaryDirectory();
        const fixture = createGitHubFixture(directory, {'app.bin': 'application'});
        const server = await fakeGitHub({exists: false, readStatus: 503});
        try {
            await expect(runScriptAsync(
                'reconcile-github-release.mjs',
                ['acme/xexamai', 'v2.5.0', 'commit-sha', fixture.bodyFile, fixture.artifacts, 'false'],
                {GITHUB_API_URL: server.endpoint, GH_TOKEN: 'test-token'},
            )).rejects.toThrow();
        } finally {
            await server.close();
        }

        expect(server.creates).toBe(0);
        expect(server.uploads).toEqual([]);
        expect(server.patches).toEqual([]);
    });
});
