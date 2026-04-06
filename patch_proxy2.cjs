const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

// LIVE STREAMS
const searchLiveStreams = `           // Process copied streams
           const copiedStreamMappings = mappings.filter(m => String(m.originalId).startsWith('copy_'));
           const copiedStreams = copiedStreamMappings.map(m => {
             const match = String(m.originalId).match(/^copy_[^_]+_(.+)$/);
             if (!match) return null;
             const realId = match[1];
             const original = data.find((s: any) => String(s.stream_id) === realId || \`\${s._sourceIdx}_\${s.stream_id}\` === realId);
             if (!original) return null; // If upstream removed, copy vanishes too.
             return { ...original, stream_id: m.originalId, category_id: m.categoryId, _rawId: m.originalId, _isCopy: true };
           }).filter(Boolean);
           data = [...data, ...copiedStreams];`;

const replaceLiveStreams = `           const customItems = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.type, 'live'))).all();
           const copiedStreams = customItems.map(item => {
             const original = data.find((s: any) => String(s.stream_id) === item.upstreamStreamId && s._client && s._client.baseUrl.includes(item.upstreamSourceId));
             // Fallback to purely stream_id matching for simpler setups or if baseUrl check is flimsy, but we'll try to find by upstreamSourceId mapping to sourceIdx if we can.
             // Actually, sourceDocs maps source id to config. Let's find sourceIdx.
             const sourceIdx = playlistSourceIds.indexOf(item.upstreamSourceId);
             let exactOriginal = original;
             if (!exactOriginal) {
                 exactOriginal = data.find((s: any) => String(s.stream_id) === item.upstreamStreamId && s._sourceIdx === sourceIdx);
             }
             if (!exactOriginal) return null;

             const clone = { ...exactOriginal, stream_id: item.streamId, category_id: \`custom_\${item.customCategoryId}\`, _rawId: item.streamId, _isCopy: true };
             const extra = item.extra as any || {};
             if (extra.name) clone.name = extra.name;
             if (extra.stream_icon) clone.stream_icon = extra.stream_icon;
             return clone;
           }).filter(Boolean);
           data = [...data, ...copiedStreams];`;

code = code.replace(searchLiveStreams, replaceLiveStreams);

// VOD STREAMS
const searchVodStreams = `            // Process copied streams
            const copiedStreamMappings = mappings.filter(m => String(m.originalId).startsWith('copy_'));
            const copiedStreams = copiedStreamMappings.map(m => {
              const match = String(m.originalId).match(/^copy_[^_]+_(.+)$/);
              if (!match) return null;
              const realId = match[1];
              const original = data.find((s: any) => String(s.stream_id) === realId || \`\${s._sourceIdx}_\${s.stream_id}\` === realId);
              if (!original) return null; // If upstream removed, copy vanishes too.
              return { ...original, stream_id: m.originalId, category_id: m.categoryId, _rawId: m.originalId, _isCopy: true };
            }).filter(Boolean);
            data = [...data, ...copiedStreams];`;

const replaceVodStreams = `            const customItems = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.type, 'vod'))).all();
            const copiedStreams = customItems.map(item => {
              const sourceIdx = playlistSourceIds.indexOf(item.upstreamSourceId);
              const original = data.find((s: any) => String(s.stream_id) === item.upstreamStreamId && s._sourceIdx === sourceIdx);
              if (!original) return null;
              const clone = { ...original, stream_id: item.streamId, category_id: \`custom_\${item.customCategoryId}\`, _rawId: item.streamId, _isCopy: true };
              const extra = item.extra as any || {};
              if (extra.name) clone.name = extra.name;
              if (extra.stream_icon) clone.stream_icon = extra.stream_icon;
              return clone;
            }).filter(Boolean);
            data = [...data, ...copiedStreams];`;

code = code.replace(searchVodStreams, replaceVodStreams);

// SERIES STREAMS
const searchSeriesStreams = `            // Process copied streams
            const copiedStreamMappings = mappings.filter(m => String(m.originalId).startsWith('copy_'));
            const copiedStreams = copiedStreamMappings.map(m => {
              const match = String(m.originalId).match(/^copy_[^_]+_(.+)$/);
              if (!match) return null;
              const realId = match[1];
              const original = data.find((s: any) => String(s.series_id) === realId || \`\${s._sourceIdx}_\${s.series_id}\` === realId);
              if (!original) return null; // If upstream removed, copy vanishes too.
              return { ...original, series_id: m.originalId, category_id: m.categoryId, _rawId: m.originalId, _isCopy: true };
            }).filter(Boolean);
            data = [...data, ...copiedStreams];`;

const replaceSeriesStreams = `            const customItems = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.type, 'series'))).all();
            const copiedStreams = customItems.map(item => {
              const sourceIdx = playlistSourceIds.indexOf(item.upstreamSourceId);
              const original = data.find((s: any) => String(s.series_id) === item.upstreamStreamId && s._sourceIdx === sourceIdx);
              if (!original) return null;
              const clone = { ...original, series_id: item.streamId, category_id: \`custom_\${item.customCategoryId}\`, _rawId: item.streamId, _isCopy: true };
              const extra = item.extra as any || {};
              if (extra.name) clone.name = extra.name;
              if (extra.cover) clone.cover = extra.cover;
              return clone;
            }).filter(Boolean);
            data = [...data, ...copiedStreams];`;

code = code.replace(searchSeriesStreams, replaceSeriesStreams);

fs.writeFileSync('server/routes/proxy.ts', code);
