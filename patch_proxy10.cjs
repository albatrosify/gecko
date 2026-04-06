const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

const search = `      const { sources: schemaSources, mappings: schemaMappings, categoryMappings: schemaCategoryMappings } = await import('../schema.ts');`;

const replace = `      const { sources: schemaSources, mappings: schemaMappings, categoryMappings: schemaCategoryMappings, customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');`;

code = code.replace(search, replace);
fs.writeFileSync('server/routes/proxy.ts', code);
