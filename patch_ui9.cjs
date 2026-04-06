const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchHidden = `              <button
                onClick={() => setShowHiddenCategories(v => !v)}
                className={\`p-2 rounded-xl border transition-all shrink-0 \${
                  showHiddenCategories
                    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20'
                    : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:bg-zinc-800'
                }\`}
                title={showHiddenCategories ? 'Hide hidden categories' : 'Show hidden categories'}
              >
                {showHiddenCategories ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
              {selectedCategoryIds.size > 0 && (`;

const replaceHidden = `              <button
                onClick={() => setShowHiddenCategories(v => !v)}
                className={\`p-2 rounded-xl border transition-all shrink-0 \${
                  showHiddenCategories
                    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20'
                    : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:bg-zinc-800'
                }\`}
                title={showHiddenCategories ? 'Hide hidden categories' : 'Show hidden categories'}
              >
                {showHiddenCategories ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
              <button
                onClick={async () => {
                  const name = window.prompt("Enter custom category name:");
                  if (!name || !name.trim()) return;
                  try {
                    setLoading(true);
                    await api.customCategories.create({ playlistId: id, type: activeTab, name: name, order: 0, hidden: false });
                    await refreshMappings();
                  } catch (e) {
                    console.error("Failed to add custom category:", e);
                    alert("Failed to create custom category.");
                  } finally {
                    setLoading(false);
                  }
                }}
                className="p-2 rounded-xl border bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20 transition-all shrink-0"
                title="Add Custom Category"
              >
                <FolderPlus size={16} />
              </button>
              {selectedCategoryIds.size > 0 && (`;

code = code.replace(searchHidden, replaceHidden);
fs.writeFileSync('src/components/index.tsx', code);
