const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchProps = `                  playlistSourceIds={playlist.sourceIds}
                  playlist={playlist}
                  globalFormat={globalFormat}
                  scrollToId={scrollToStreamId}
                  onScrolled={() => setScrollToStreamId(null)}
                />`;

const replaceProps = `                  playlistSourceIds={playlist.sourceIds}
                  playlist={playlist}
                  globalFormat={globalFormat}
                  scrollToId={scrollToStreamId}
                  onScrolled={() => setScrollToStreamId(null)}
                  onBatchCopy={(target, stream) => handleBatchCopy(target, 'single', stream)}
                />`;

code = code.replace(searchProps, replaceProps);
fs.writeFileSync('src/components/index.tsx', code);
