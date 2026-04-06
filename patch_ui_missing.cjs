const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const search = `        if (originalStream) {
          const clone = { ...originalStream, _rawId: item.streamId, _uniqueId: item.streamId, category_id: \`custom_\${item.customCategoryId}\`, _isCopy: true };`;

const replace = `        if (originalStream) {
          const clone = { ...originalStream, _rawId: item.streamId, _uniqueId: item.streamId, category_id: \`custom_\${item.customCategoryId}\`, _isCopy: true, _customItemId: item.id };`;

code = code.replace(search, replace);

const search2 = `            _isMissing: true,
            _isCopy: true
          });`;

const replace2 = `            _isMissing: true,
            _isCopy: true,
            _customItemId: item.id
          });`;

code = code.replace(search2, replace2);

const searchRow = `                {stream._isMissing && (
                  <div className="col-span-full mt-1 px-2 py-1 rounded bg-red-500/10 text-red-400 font-bold text-[10px] border border-red-500/20 w-max inline-flex items-center gap-1 uppercase tracking-tight">
                    <X size={10} /> Upstream Stream Missing
                  </div>
                )}`;

const replaceRow = `                {stream._isMissing && (
                  <div className="col-span-full mt-1 flex items-center gap-2">
                    <div className="px-2 py-1 rounded bg-red-500/10 text-red-400 font-bold text-[10px] border border-red-500/20 w-max inline-flex items-center gap-1 uppercase tracking-tight">
                      <X size={10} /> Upstream Stream Missing
                    </div>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (stream._customItemId) {
                           await api.customCategoryItems.remove(stream._customItemId);
                           onMappingChange(); // This triggers data reload in the parent
                        }
                      }}
                      className="px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-red-400 hover:bg-red-500/20 font-bold text-[10px] border border-zinc-700 hover:border-red-500/30 transition-all flex items-center gap-1"
                    >
                      <Trash2 size={10} /> Remove
                    </button>
                  </div>
                )}`;

code = code.replace(searchRow, replaceRow);

const searchClass = `      <div className={cn(
        "flex-1 flex gap-3 min-w-0 pr-4",
        !stream.stream_icon && "pl-2"
      )}>`;

const replaceClass = `      <div className={cn(
        "flex-1 flex gap-3 min-w-0 pr-4",
        !stream.stream_icon && "pl-2",
        stream._isMissing && "opacity-50 grayscale"
      )}>`;

code = code.replace(searchClass, replaceClass);
fs.writeFileSync('src/components/index.tsx', code);
