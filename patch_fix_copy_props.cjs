const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const search = `function StreamTable({ streams, selectedCategoryIds, activeTab, mappings, playlistId, applyRegex, onMappingChange, onDragEnd, loading, onSelectStream, selectedStreamIds, epgChannels, allSources, playlistSourceIds, playlist, globalFormat, scrollToId, onScrolled }: {`;
const replace = `function StreamTable({ streams, selectedCategoryIds, activeTab, mappings, playlistId, applyRegex, onMappingChange, onDragEnd, loading, onSelectStream, selectedStreamIds, epgChannels, allSources, playlistSourceIds, playlist, globalFormat, scrollToId, onScrolled, onBatchCopy }: {`;

code = code.replace(search, replace);
fs.writeFileSync('src/components/index.tsx', code);
