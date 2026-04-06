const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchCatIcon = `            <div className="flex items-center gap-1 min-w-0">
              <span className={cn(
                "text-xs font-medium truncate transition-colors",`;

const replaceCatIcon = `            <div className="flex items-center gap-1 min-w-0">
              {cat._isCustom && <Star size={10} className="text-yellow-500 shrink-0" />}
              <span className={cn(
                "text-xs font-medium truncate transition-colors",`;

code = code.replace(searchCatIcon, replaceCatIcon);
fs.writeFileSync('src/components/index.tsx', code);
