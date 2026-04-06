const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const search = `  playlist?: Playlist | null;
  globalFormat?: string;
  scrollToId?: string | null;
  onScrolled?: () => void;

}) {`;

const replace = `  playlist?: Playlist | null;
  globalFormat?: string;
  scrollToId?: string | null;
  onScrolled?: () => void;
  onBatchCopy?: (target: string, stream?: any) => void;
}) {`;

code = code.replace(search, replace);
fs.writeFileSync('src/components/index.tsx', code);
