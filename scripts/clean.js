const fs = require('fs');
const path = require('path');

function rimraf(p) {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(p)) {
            rimraf(path.join(p, entry));
        }
        try {
            fs.rmdirSync(p);
        } catch {
        }
    } else {
        try {
            fs.unlinkSync(p);
        } catch {
        }
    }
}

const cwd = process.cwd();
for (const dir of ['build', 'dist']) {
    rimraf(path.join(cwd, dir));
}
console.log('Cleaned build and dist');

