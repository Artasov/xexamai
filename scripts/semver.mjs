const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(value) {
    const match = String(value).match(SEMVER_PATTERN);
    if (!match) throw new Error(`Invalid semantic version: ${value}`);
    const pre = match[4]?.split('.') ?? [];
    if (pre.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
        throw new Error(`Invalid semantic version: ${value}`);
    }
    return {
        core: match.slice(1, 4),
        pre,
    };
}

export function isPrerelease(value) {
    return parseSemver(value).pre.length > 0;
}

export function compareSemver(left, right) {
    const a = parseSemver(left);
    const b = parseSemver(right);
    for (let index = 0; index < 3; index += 1) {
        if (a.core[index] !== b.core[index]) return compareNumericIdentifier(a.core[index], b.core[index]);
    }
    if (a.pre.length === 0 || b.pre.length === 0) {
        return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
    }
    for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
        if (a.pre[index] === undefined || b.pre[index] === undefined) {
            return a.pre[index] === undefined ? -1 : 1;
        }
        if (a.pre[index] === b.pre[index]) continue;
        const aNumeric = /^\d+$/.test(a.pre[index]);
        const bNumeric = /^\d+$/.test(b.pre[index]);
        if (aNumeric && bNumeric) return compareNumericIdentifier(a.pre[index], b.pre[index]);
        if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
        return a.pre[index] < b.pre[index] ? -1 : 1;
    }
    return 0;
}

function compareNumericIdentifier(left, right) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
}
