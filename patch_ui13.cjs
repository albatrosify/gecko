const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const search = `import {
  Plus,`;
const replace = `import {
  Plus, FolderPlus, Star,`;

code = code.replace(search, replace);
fs.writeFileSync('src/components/index.tsx', code);
