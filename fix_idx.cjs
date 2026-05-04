const fs = require('fs');

let content = fs.readFileSync('src/components/index.tsx', 'utf8');
content = content.replace(/function ([A-Za-z]+)\((.*?) \{\n  const \{ t \} = useTranslation\(\);/g, `function $1($2 {`);

fs.writeFileSync('src/components/index.tsx', content);
