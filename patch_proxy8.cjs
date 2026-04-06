const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

const search = `      const targetExt = ext || (type === 'live' ? 'ts' : 'mp4');
      const targetUrl = type === 'live' ? cl.getLiveStreamUrl(targetOriginalId, targetExt) : (type === 'movie' ? cl.getVodStreamUrl(targetOriginalId, targetExt) : cl.getSeriesStreamUrl(targetOriginalId, targetExt));`;

const replace = `      const targetExt = ext || (type === 'live' ? 'ts' : 'mp4');
      const targetUrl = type === 'live' ? cl.getLiveStreamUrl(targetOriginalId) : (type === 'movie' ? cl.getVodStreamUrl(targetOriginalId, targetExt) : cl.getSeriesStreamUrl(targetOriginalId, targetExt));`;

code = code.replace(search, replace);
fs.writeFileSync('server/routes/proxy.ts', code);

let serverCode = fs.readFileSync('server.ts', 'utf8');
const searchServer = `import { createMigrationsRouter } from './server/routes/migrations.ts';`;
const replaceServer = `import { createMigrationsRouter } from './server/routes/migrations.ts';
import { createCustomCategoriesRouter } from './server/routes/customCategories.ts';`;
serverCode = serverCode.replace(searchServer, replaceServer);
fs.writeFileSync('server.ts', serverCode);
