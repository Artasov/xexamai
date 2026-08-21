export function parseSemver(value: string): {core: number[]; pre: string[]};
export function isPrerelease(value: string): boolean;
export function compareSemver(left: string, right: string): number;
