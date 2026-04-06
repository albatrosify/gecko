const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

const searchM3u = `      let rawStreams = allResults.flat();

      const catMap = new Map(catMappings.filter(m => m.type === activeTabStr).map(m => [String(m.originalId), m]));`;

const replaceM3u = `      let rawStreams = allResults.flat();

      // Process copied streams
      const copiedStreamMappings = mappings.filter(m => m.type === activeTabStr && String(m.originalId).startsWith('copy_'));
      const copiedStreams = copiedStreamMappings.map(m => {
        const match = String(m.originalId).match(/^copy_[^_]+_(.+)$/);
        if (!match) return null;
        const realId = match[1];
        const original = rawStreams.find((s: any) => String(s.stream_id) === realId || \`\${s._sourceIdx}_\${s.stream_id}\` === realId);
        if (!original) return null; // If upstream removed, copy vanishes too.
        return { ...original, stream_id: m.originalId, category_id: m.categoryId, _rawId: m.originalId, _isCopy: true };
      }).filter(Boolean);
      rawStreams = [...rawStreams, ...copiedStreams];

      const catMap = new Map(catMappings.filter(m => m.type === activeTabStr).map(m => [String(m.originalId), m]));`;

if (code.includes(searchM3u)) {
   code = code.replace(searchM3u, replaceM3u);
} else {
   console.log("M3U anchor not found!");
}

fs.writeFileSync('server/routes/proxy.ts', code);
