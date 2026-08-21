import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseSemver} from './semver.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const allowedBumps = new Set(['patch', 'minor', 'major']);

export function nextStableVersion(currentVersion, bump) {
    if (!allowedBumps.has(bump)) {
        throw new Error(`Release type must be patch, minor or major; received ${JSON.stringify(bump)}`);
    }
    if (String(currentVersion).includes('-') || String(currentVersion).includes('+')) {
        throw new Error(
            `The ${bump} shortcuts only accept a stable version; received ${JSON.stringify(currentVersion)}`,
        );
    }
    const parsed = parseSemver(currentVersion);
    const [major, minor, patch] = parsed.core.map((part) => BigInt(part));
    if (bump === 'major') return `${major + 1n}.0.0`;
    if (bump === 'minor') return `${major}.${minor + 1n}.0`;
    return `${major}.${minor}.${patch + 1n}`;
}

function git(arguments_, options = {}) {
    const output = execFileSync('git', arguments_, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    return typeof output === 'string' ? output.trim() : '';
}

function command(executable, arguments_) {
    execFileSync(executable, arguments_, {
        cwd: repositoryRoot,
        env: process.env,
        stdio: 'inherit',
    });
}

function npmCommand(arguments_) {
    const npmCli = process.env.npm_execpath;
    if (npmCli) {
        command(process.execPath, [npmCli, ...arguments_]);
        return;
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, arguments_, {
        cwd: repositoryRoot,
        env: process.env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
}

function commandStatus(executable, arguments_) {
    return spawnSync(executable, arguments_, {
        cwd: repositoryRoot,
        env: process.env,
        stdio: 'ignore',
    }).status;
}

function assertCleanWorktree() {
    const changes = git(['status', '--porcelain=v1', '--untracked-files=all']);
    if (changes) {
        throw new Error(
            'Release aborted: commit or stash every change before creating a version tag.\n' +
                changes.split('\n').slice(0, 20).join('\n'),
        );
    }
}

function assertRemoteTagMissing(remote, tag) {
    const result = spawnSync(
        'git',
        ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`],
        {cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
    );
    if (result.status === 0) {
        throw new Error(`Release aborted: ${tag} already exists on ${remote}.`);
    }
    // --exit-code returns 2 when the remote is reachable but no matching ref exists.
    if (result.status !== 2) {
        throw new Error(
            `Release aborted: could not verify tags on ${remote}.\n${String(result.stderr).trim()}`,
        );
    }
}

function assertBranchContainsRemote(branch, remote) {
    const remoteReference = `refs/remotes/${remote}/${branch}`;
    if (commandStatus('git', ['rev-parse', '--verify', '--quiet', remoteReference]) !== 0) {
        throw new Error(`Release aborted: ${remoteReference} does not exist after fetch.`);
    }
    if (commandStatus('git', ['merge-base', '--is-ancestor', remoteReference, 'HEAD']) !== 0) {
        throw new Error(
            `Release aborted: local ${branch} is behind or diverged from ${remote}/${branch}. Pull/rebase first.`,
        );
    }
}

function runRelease(bump) {
    if (!allowedBumps.has(bump)) {
        throw new Error('Usage: node scripts/release.mjs <patch|minor|major>');
    }

    const expectedBranch = process.env.RELEASE_BRANCH || 'main';
    const branch = git(['branch', '--show-current']);
    if (branch !== expectedBranch) {
        throw new Error(
            `Release aborted: expected branch ${expectedBranch}, but the current branch is ${branch || '<detached>'}.`,
        );
    }
    const remote = process.env.RELEASE_REMOTE || git(['config', '--get', `branch.${branch}.remote`]) || 'origin';

    assertCleanWorktree();
    console.log(`[release] Fetching ${remote}/${branch} and release tags...`);
    git(
        [
            'fetch',
            '--prune',
            '--tags',
            remote,
            `refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
        ],
        {capture: false},
    );
    assertBranchContainsRemote(branch, remote);

    const packageJson = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );
    const currentVersion = String(packageJson.version ?? '');
    const nextVersion = nextStableVersion(currentVersion, bump);
    const tag = `v${nextVersion}`;

    if (commandStatus('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]) === 0) {
        throw new Error(`Release aborted: local tag ${tag} already exists.`);
    }
    assertRemoteTagMissing(remote, tag);

    const node = process.execPath;
    console.log(`[release] Verifying current version v${currentVersion}...`);
    command(node, ['scripts/verify-release-version.mjs', `v${currentVersion}`]);
    console.log('[release] Running generated-binding, type, unit and renderer checks...');
    npmCommand(['run', 'release:check']);

    console.log(`[release] Creating ${tag} and synchronizing npm, Tauri and Cargo metadata...`);
    npmCommand([
        'version',
        nextVersion,
        '--tag-version-prefix=v',
        '--message',
        'chore(release): v%s',
    ]);
    command(node, ['scripts/verify-release-version.mjs', tag]);

    const tagTarget = git(['rev-list', '-n', '1', tag]);
    const head = git(['rev-parse', 'HEAD']);
    if (tagTarget !== head) {
        throw new Error(`Release aborted: ${tag} does not point to the release commit.`);
    }

    console.log(`[release] Atomically pushing ${branch} and ${tag} to ${remote}...`);
    try {
        git(
            [
                'push',
                '--atomic',
                remote,
                `HEAD:refs/heads/${branch}`,
                `refs/tags/${tag}:refs/tags/${tag}`,
            ],
            {capture: false},
        );
    } catch (error) {
        throw new Error(
            `Push failed. The local release commit and ${tag} were kept for inspection; nothing was partially pushed by the atomic request.`,
            {cause: error},
        );
    }
    console.log(`[release] ${tag} pushed. The tag-triggered CI/CD workflow is now starting.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
    try {
        runRelease(process.argv[2]);
    } catch (error) {
        console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
