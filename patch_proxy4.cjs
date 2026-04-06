const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

const searchGetStreamUrl = `  router.get("/series/:username/:password/:streamId.ts", async (req, res) => {`;

const replaceGetStreamUrl = `  router.get("/series/:username/:password/:streamId.ts", async (req, res) => {`;

code = code.replace(searchGetStreamUrl, replaceGetStreamUrl);
fs.writeFileSync('server/routes/proxy.ts', code);
