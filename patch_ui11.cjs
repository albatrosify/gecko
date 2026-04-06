const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const search = `      <div className={cn(
        "flex items-center gap-1 transition-opacity",
        isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}>
        <button
          onClick={toggleSyncOnDemand}`;

const replace = `      <div className={cn(
        "flex items-center gap-1 transition-opacity",
        isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}>
        {cat._isCustom && (
          <button
            onClick={async (e) => {
               e.stopPropagation();
               if (window.confirm('Delete custom category? Streams copied here will be removed from this category.')) {
                 await api.customCategories.remove(cat.id);
                 onMappingChange();
               }
            }}
            className="p-1 hover:bg-red-500/20 rounded text-red-500 transition-colors"
            title="Delete Custom Category"
          >
            <X size={12} />
          </button>
        )}
        <button
          onClick={toggleSyncOnDemand}`;

code = code.replace(search, replace);

const searchMiss = `                    <div className="text-zinc-600 col-span-1 truncate">Category: {stream.category_name || (stream._originalCategoryId || stream.category_id)}</div>
                    <div className="text-zinc-600 col-span-1 truncate">{stream.epg_channel_id ? \`EPG: \${stream.epg_channel_id}\` : ''}</div>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1">`;

const replaceMiss = `                    <div className="text-zinc-600 col-span-1 truncate">Category: {stream.category_name || (stream._originalCategoryId || stream.category_id)}</div>
                    <div className="text-zinc-600 col-span-1 truncate">{stream.epg_channel_id ? \`EPG: \${stream.epg_channel_id}\` : ''}</div>
                  </>
                )}
                {stream._isMissing && (
                  <div className="col-span-full mt-1 px-2 py-1 rounded bg-red-500/10 text-red-400 font-bold text-[10px] border border-red-500/20 w-max inline-flex items-center gap-1 uppercase tracking-tight">
                    <X size={10} /> Upstream Stream Missing
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1">`;

code = code.replace(searchMiss, replaceMiss);
fs.writeFileSync('src/components/index.tsx', code);
