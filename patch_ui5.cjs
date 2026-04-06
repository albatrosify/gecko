const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchCatGen = `  const sortedCategories = useMemo(() => {
    if (!categories.length) return [];

    const mappingByOriginalId = new Map();
    categoryMappings.forEach(m => {
      if (m.type === activeTab) {
        mappingByOriginalId.set(m.originalId, m);
      }
    });`;

const replaceCatGen = `  const sortedCategories = useMemo(() => {
    let combinedCategories = [...categories];

    // Inject custom categories
    customCategories.forEach(cc => {
      if (cc.type === activeTab) {
        combinedCategories.push({
          category_id: \`custom_\${cc.id}\`,
          category_name: cc.name,
          id: cc.id,
          _isCustom: true
        });
      }
    });

    if (!combinedCategories.length) return [];

    const mappingByOriginalId = new Map();
    categoryMappings.forEach(m => {
      if (m.type === activeTab) {
        mappingByOriginalId.set(m.originalId, m);
      }
    });`;

code = code.replace(searchCatGen, replaceCatGen);
fs.writeFileSync('src/components/index.tsx', code);
