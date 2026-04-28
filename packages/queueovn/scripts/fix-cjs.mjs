// fix-cjs.mjs — renames .js to .cjs in dist/cjs for explicit CJS imports.
// This is optional; the Oblivinx bot uses ESM and does not need this.
import fs from 'fs';
import path from 'path';

const cjsDir = path.resolve('dist', 'cjs');

function renameFiles(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            renameFiles(fullPath);
        } else if (entry.name.endsWith('.js')) {
            const newPath = fullPath.replace(/\.js$/, '.cjs');
            // Also fix internal require paths
            let content = fs.readFileSync(fullPath, 'utf-8');
            content = content.replace(/require\("([^"]+)\.js"\)/g, 'require("$1.cjs")');
            fs.writeFileSync(newPath, content);
            fs.unlinkSync(fullPath);
        }
    }
}

renameFiles(cjsDir);
console.log('CJS files renamed to .cjs');
