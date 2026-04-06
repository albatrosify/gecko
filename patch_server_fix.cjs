const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const importSearch = `import { createCustomCategoriesRouter } from './server/routes/customCategories.ts';`;
if (!code.includes(importSearch)) {
   const beforeImport = `import { createMigrationsRouter } from './server/routes/migrations.ts';`;
   const afterImport = `import { createMigrationsRouter } from './server/routes/migrations.ts';
import { createCustomCategoriesRouter } from './server/routes/customCategories.ts';`;
   code = code.replace(beforeImport, afterImport);
   fs.writeFileSync('server.ts', code);
}
