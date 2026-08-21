import fs from 'node:fs';

const [repository, tag, targetCommitish, outputPath] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!repository || !tag || !targetCommitish || !outputPath || !token) {
    throw new Error('Repository, tag, target commit, output path and GITHUB_TOKEN are required');
}

const response = await fetch(`https://api.github.com/repos/${repository}/releases/generate-notes`, {
    method: 'POST',
    headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'xexamai-release-pipeline',
    },
    body: JSON.stringify({tag_name: tag, target_commitish: targetCommitish}),
});
if (!response.ok) {
    throw new Error(`GitHub release notes request failed: HTTP ${response.status} ${await response.text()}`);
}
const payload = await response.json();
fs.writeFileSync(outputPath, `${payload.body ?? ''}\n`);
