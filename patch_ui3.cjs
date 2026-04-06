const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchLoadStreams = `      const streamResults = await Promise.all(activeSources.map(s =>
        api.upstream.fetchStreams(s, activeTab, forceRefresh, activeSourceIds.indexOf(s.id))
      ));
      const mergedStreams = streamResults.flatMap(r => r.streams || []);

      // Inject copied streams
      const maps = await api.mappings.list(id as string);
      const activeTabMappings = maps.filter(m => m.type === activeTab);
      const copiedStreams = activeTabMappings.filter(m => m.originalId.startsWith('copy_'));
      const extraStreams: any[] = [];
      copiedStreams.forEach(m => {
        // extract original real ID
        const match = m.originalId.match(/^copy_[^_]+_(.+)$/);
        if (match) {
           const realId = match[1];
           // Find original stream
           const originalStream = mergedStreams.find(s => String(s.stream_id ?? s.series_id) === realId || \`\${s._sourceIdx}_\${s.stream_id ?? s.series_id}\` === realId);
           if (originalStream) {
              const clone = { ...originalStream, _rawId: m.originalId, _uniqueId: m.originalId, category_id: m.categoryId };
              // We set the stream_id/series_id to match originalId so sorting/filtering by ID works
              if (clone.stream_id) clone.stream_id = m.originalId;
              if (clone.series_id) clone.series_id = m.originalId;
              extraStreams.push(clone);
           }
        }
      });

      setStreams([...mergedStreams, ...extraStreams]);`;

const replaceLoadStreams = `      const streamResults = await Promise.all(activeSources.map(s =>
        api.upstream.fetchStreams(s, activeTab, forceRefresh, activeSourceIds.indexOf(s.id))
      ));
      const mergedStreams = streamResults.flatMap(r => r.streams || []);

      // Inject copied streams from customCategoryItems
      const cItems = await api.customCategoryItems.list(id as string);
      const activeTabItems = cItems.filter(item => item.type === activeTab);
      const extraStreams: any[] = [];

      activeTabItems.forEach(item => {
        const sourceIdx = activeSourceIds.indexOf(item.upstreamSourceId);
        const originalStream = mergedStreams.find(s => String(s.stream_id ?? s.series_id) === item.upstreamStreamId && s._sourceIdx === sourceIdx);
        if (originalStream) {
          const clone = { ...originalStream, _rawId: item.streamId, _uniqueId: item.streamId, category_id: \`custom_\${item.customCategoryId}\`, _isCopy: true };
          if (clone.stream_id) clone.stream_id = item.streamId;
          if (clone.series_id) clone.series_id = item.streamId;
          extraStreams.push(clone);
        } else {
          // Add a dummy missing item representation
          extraStreams.push({
            _rawId: item.streamId,
            _uniqueId: item.streamId,
            stream_id: item.streamId,
            series_id: item.streamId,
            category_id: \`custom_\${item.customCategoryId}\`,
            name: item.extra?.name || 'Unknown Channel',
            stream_icon: item.extra?.stream_icon,
            cover: item.extra?.cover,
            _isMissing: true,
            _isCopy: true
          });
        }
      });

      setStreams([...mergedStreams, ...extraStreams]);`;

code = code.replace(searchLoadStreams, replaceLoadStreams);
fs.writeFileSync('src/components/index.tsx', code);
