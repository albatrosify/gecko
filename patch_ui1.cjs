const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

// Replace folder-plus icon with Star/X missing logic
const searchImport = `  FolderPlus
} from 'lucide-react';`;
const replaceImport = `  FolderPlus,
  Star,
  X
} from 'lucide-react';`;

code = code.replace(searchImport, replaceImport);

fs.writeFileSync('src/components/index.tsx', code);
