const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchBtn2 = `  const handleAddCustomCategory = async () => {
    const name = window.prompt("Enter custom category name:");
    if (!name || !name.trim()) return;

    const newCatId = "custom_" + Date.now();
    try {
      setLoading(true);
      await api.categoryMappings.create({
        playlistId: id,
        type: activeTab,
        originalId: newCatId,
        originalName: name,
        customName: name,
        order: -1,
        hidden: false
      });
      // Add fake category so it renders before refresh
      setCategories(prev => [{ category_id: newCatId, category_name: name, id: newCatId }, ...prev]);
      await refreshMappings();
    } catch (e) {
      console.error("Failed to add custom category:", e);
      alert("Failed to create custom category.");
    } finally {
      setLoading(false);
    }
  };`;

const replaceBtn2 = `  const handleAddCustomCategory = async () => {
    const name = window.prompt("Enter custom category name:");
    if (!name || !name.trim()) return;

    try {
      setLoading(true);
      await api.customCategories.create({
        playlistId: id,
        type: activeTab,
        name: name,
        order: 0,
        hidden: false
      });
      await refreshMappings();
    } catch (e) {
      console.error("Failed to add custom category:", e);
      alert("Failed to create custom category.");
    } finally {
      setLoading(false);
    }
  };`;

code = code.replace(searchBtn2, replaceBtn2);
fs.writeFileSync('src/components/index.tsx', code);
