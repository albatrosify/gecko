const fs = require('fs');

let content = fs.readFileSync('src/App.tsx', 'utf8');
content = `import { useTranslation } from 'react-i18next';\n` + content;

// Replace some strings in App.tsx
content = content.replace(/'Dashboard'/g, "t('sidebar.dashboard')");
content = content.replace(/'Settings'/g, "t('sidebar.settings')");
fs.writeFileSync('src/App.tsx', content);

let idxContent = fs.readFileSync('src/components/index.tsx', 'utf8');
idxContent = `import { useTranslation } from 'react-i18next';\n` + idxContent;

// Also fix the random `t` errors
idxContent = idxContent.replace(/function ([A-Za-z]+)\((.*?) \{/g, `function $1($2 {\n  const { t } = useTranslation();`);

fs.writeFileSync('src/components/index.tsx', idxContent);
