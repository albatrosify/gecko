const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchCatGenMap = `    const categoriesWithMapping = (categories || []).map((c) => {
      const catId = String(c.category_id || c.id);
      const mapping = mappingByOriginalId.get(catId);
      return {
        ...c,
        customName: mapping?.customName,
        order: mapping ? (mapping.order ?? 999999) : 999999,
        hidden: mapping?.hidden ?? false,
        syncOnDemand: mapping?.syncOnDemand ?? false
      };
    });`;

const replaceCatGenMap = `    const categoriesWithMapping = (combinedCategories || []).map((c) => {
      const catId = String(c.category_id || c.id);
      if (c._isCustom) {
        const cc = customCategories.find(x => x.id === c.id);
        return {
          ...c,
          customName: c.category_name,
          order: cc?.order ?? 0,
          hidden: cc?.hidden ?? false,
          syncOnDemand: false
        };
      }
      const mapping = mappingByOriginalId.get(catId);
      return {
        ...c,
        customName: mapping?.customName,
        order: mapping ? (mapping.order ?? 999999) : 999999,
        hidden: mapping?.hidden ?? false,
        syncOnDemand: mapping?.syncOnDemand ?? false
      };
    });`;

code = code.replace(searchCatGenMap, replaceCatGenMap);

const searchCatDep = `  }, [categories, categoryMappings, activeTab, categorySearch, showHiddenCategories]);`;
const replaceCatDep = `  }, [categories, categoryMappings, customCategories, activeTab, categorySearch, showHiddenCategories]);`;

code = code.replace(searchCatDep, replaceCatDep);

fs.writeFileSync('src/components/index.tsx', code);
