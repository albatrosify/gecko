const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchState = `  const [categories, setCategories] = useState<any[]>([]);`;
const replaceState = `  const [categories, setCategories] = useState<any[]>([]);
  const [customCategories, setCustomCategories] = useState<any[]>([]);
  const [customCategoryItems, setCustomCategoryItems] = useState<any[]>([]);`;

code = code.replace(searchState, replaceState);

const searchFetchMappings = `      const [streamMaps, catMaps] = await Promise.all([
        api.mappings.list(id),
        api.categoryMappings.list(id),
      ]);
      setMappings(streamMaps || []);
      setCategoryMappings(catMaps || []);`;

const replaceFetchMappings = `      const [streamMaps, catMaps, cCats, cCatItems] = await Promise.all([
        api.mappings.list(id),
        api.categoryMappings.list(id),
        api.customCategories.list(id),
        api.customCategoryItems.list(id),
      ]);
      setMappings(streamMaps || []);
      setCategoryMappings(catMaps || []);
      setCustomCategories(cCats || []);
      setCustomCategoryItems(cCatItems || []);`;

code = code.replace(searchFetchMappings, replaceFetchMappings);

const searchRefresh = `  const refreshMappings = async () => {
    if (!id) return;
    try {
      const [streamMaps, catMaps] = await Promise.all([
        api.mappings.list(id),
        api.categoryMappings.list(id),
      ]);
      setMappings(streamMaps || []);
      setCategoryMappings(catMaps || []);
    } catch (e) {
      console.error(e);
    }
  };`;

const replaceRefresh = `  const refreshMappings = async () => {
    if (!id) return;
    try {
      const [streamMaps, catMaps, cCats, cCatItems] = await Promise.all([
        api.mappings.list(id),
        api.categoryMappings.list(id),
        api.customCategories.list(id),
        api.customCategoryItems.list(id),
      ]);
      setMappings(streamMaps || []);
      setCategoryMappings(catMaps || []);
      setCustomCategories(cCats || []);
      setCustomCategoryItems(cCatItems || []);
    } catch (e) {
      console.error(e);
    }
  };`;

code = code.replace(searchRefresh, replaceRefresh);

fs.writeFileSync('src/components/index.tsx', code);
