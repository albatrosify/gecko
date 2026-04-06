const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const search = `  playlist?: Playlist | null;
  globalFormat?: string;
  scrollToId?: string | null;
  onScrolled?: () => void;
  onBatchCopy?: (target: string, stream?: any) => void;
}) {`;

const replace = `  playlist?: Playlist | null;
  globalFormat?: string;
  scrollToId?: string | null;
  onScrolled?: () => void;
  onBatchCopy?: (target: string, stream?: any) => void;
}) {`;

const search2 = `                  playlist,
                  globalFormat,
                  onBatchCopy,

                }}`;
const replace2 = `                  playlist,
                  globalFormat,
                  onBatchCopy,

                }}`;

// Let's actually check how onBatchCopy is passed to StreamTable
