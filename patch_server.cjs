const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const importSearch = `import { createMigrationsRouter } from './server/routes/migrations.ts';`;
const importReplace = `import { createMigrationsRouter } from './server/routes/migrations.ts';
import { createCustomCategoriesRouter } from './server/routes/customCategories.ts';`;

const useSearch = `app.use('/api', createMigrationsRouter());`;
const useReplace = `app.use('/api', createMigrationsRouter());
app.use('/api', createCustomCategoriesRouter());`;

code = code.replace(importSearch, importReplace);
code = code.replace(useSearch, useReplace);

fs.writeFileSync('server.ts', code);
