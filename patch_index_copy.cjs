const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchBtn = `  const handleBatchCopy = async (targetCustomCategoryIdStr: string, scope: 'all' | 'categories' | 'streams') => {
    let activeStreams: any[] = [];

    if (scope === 'all') {
      activeStreams = sortedStreams;
    } else if (scope === 'categories') {
      activeStreams = sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    } else if (scope === 'streams') {
      activeStreams = sortedStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));
    }`;

const replaceBtn = `  const handleBatchCopy = async (targetCustomCategoryIdStr: string, scope: 'all' | 'categories' | 'streams' | 'single', specificStream?: any) => {
    let activeStreams: any[] = [];

    if (scope === 'all') {
      activeStreams = sortedStreams;
    } else if (scope === 'categories') {
      activeStreams = sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    } else if (scope === 'streams') {
      activeStreams = sortedStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));
    } else if (scope === 'single' && specificStream) {
      activeStreams = [specificStream];
    }`;

code = code.replace(searchBtn, replaceBtn);
fs.writeFileSync('src/components/index.tsx', code);
