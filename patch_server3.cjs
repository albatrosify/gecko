const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const importSearch = 'import { createMigrationsRouter } from "./server/routes/migrations.ts";';
if (!code.includes('import { createCustomCategoriesRouter }')) {
  code = code.replace(importSearch, 'import { createMigrationsRouter } from "./server/routes/migrations.ts";\nimport { createCustomCategoriesRouter } from "./server/routes/customCategories.ts";');
  fs.writeFileSync('server.ts', code);
}
