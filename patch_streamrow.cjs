const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchProps = `                  allSources,
                  playlistSourceIds,
                  playlist,
                  globalFormat,`;

const replaceProps = `                  allSources,
                  playlistSourceIds,
                  playlist,
                  globalFormat,
                  onBatchCopy,`;

code = code.replace(searchProps, replaceProps);

const searchDe = `    playlistSourceIds,
    playlist,
    globalFormat,

  } = data;`;

const replaceDe = `    playlistSourceIds,
    playlist,
    globalFormat,
    onBatchCopy
  } = data;`;

code = code.replace(searchDe, replaceDe);

const searchActions = `              <button
                onClick={(e) => { e.stopPropagation(); setEditingStreamId(originalId); }}
                className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300"
                title="Edit Mapping"
              >
                <Edit2 size={14} />
              </button>`;

const replaceActions = `              {!stream._isCopy && onBatchCopy && (
                <button
                  onClick={(e) => {
                     e.stopPropagation();
                     const target = window.prompt("Enter custom category ID or name to copy this stream to (e.g. custom_123):");
                     if (target) onBatchCopy(target, stream);
                  }}
                  className="p-1.5 hover:bg-purple-500/20 rounded text-purple-400 hover:text-purple-300"
                  title="Copy to Custom Category"
                >
                  <Copy size={14} />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); setEditingStreamId(originalId); }}
                className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300"
                title="Edit Mapping"
              >
                <Edit2 size={14} />
              </button>`;

code = code.replace(searchActions, replaceActions);
fs.writeFileSync('src/components/index.tsx', code);
