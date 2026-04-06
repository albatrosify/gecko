const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');
code = code.replace(/\\\`/g, '\`');
fs.writeFileSync('server/routes/proxy.ts', code);
