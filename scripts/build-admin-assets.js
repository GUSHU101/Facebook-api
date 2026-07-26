const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const vuePackageRoot = path.dirname(require.resolve('vue/package.json'));
const source = path.join(vuePackageRoot, 'dist', 'vue.global.prod.js');
const destination = path.join(projectRoot, 'src', 'public', 'vue.global.prod.js');

fs.copyFileSync(source, destination);
console.log(`Copied pinned Vue browser runtime to ${path.relative(projectRoot, destination)}`);
