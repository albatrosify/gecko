const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const search = `import {
  LogOut,`;
const replace = `import {
  FolderPlus,
  Star,
  LogOut,`;

code = code.replace(search, replace);
fs.writeFileSync('src/components/index.tsx', code);
