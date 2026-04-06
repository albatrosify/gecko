const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

// M3U STREAMS (get_live_streams but for m3u format in general fallback section)
const searchM3uStreams = `      // Process copied streams
      const copiedStreamMappings = mappings.filter(m => m.type === activeTabStr && String(m.originalId).startsWith('copy_'));
      const copiedStreams = copiedStreamMappings.map(m => {
        const match = String(m.originalId).match(/^copy_[^_]+_(.+)$/);
        if (!match) return null;
        const realId = match[1];
        const original = rawStreams.find((s: any) => String(s.stream_id) === realId || \`\${s._sourceIdx}_\${s.stream_id}\` === realId);
        if (!original) return null; // If upstream removed, copy vanishes too.
        return { ...original, stream_id: m.originalId, category_id: m.categoryId, _rawId: m.originalId, _isCopy: true };
      }).filter(Boolean);
      rawStreams = [...rawStreams, ...copiedStreams];`;

const replaceM3uStreams = `      const customItems = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.type, activeTabStr))).all();
      const copiedStreams = customItems.map(item => {
        const sourceIdx = playlistSourceIds.indexOf(item.upstreamSourceId);
        const original = rawStreams.find((s: any) => String(s.stream_id) === item.upstreamStreamId && s._sourceIdx === sourceIdx);
        if (!original) return null;
        const clone = { ...original, stream_id: item.streamId, category_id: \`custom_\${item.customCategoryId}\`, _rawId: item.streamId, _isCopy: true };
        const extra = item.extra as any || {};
        if (extra.name) clone.name = extra.name;
        if (extra.stream_icon) clone.stream_icon = extra.stream_icon;
        return clone;
      }).filter(Boolean);
      rawStreams = [...rawStreams, ...copiedStreams];`;

if (code.includes(searchM3uStreams)) {
  code = code.replace(searchM3uStreams, replaceM3uStreams);
}

// RESOLVING URL IN /live/:user/:pass/:streamId.ts
const searchUrlResolve = `    // Look up mapping by streamId (which was generated as mapping.order)
    // Note: since id maps to order, we need to find the mapping with that order.
    // Also, if playlist is not synced, streamId IS the order.
    let targetOriginalId = streamId;`;

const replaceUrlResolve = `    // Resolve custom category items first!
    const { customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');
    const customItem = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.streamId, streamId))).get();
    if (customItem) {
      // Re-map streamId to upstreamStreamId and override source lookup logic below implicitly
      // We need to inject the upstreamSourceId so it resolves correctly.
      const sourceRow = db.select().from(schemaSources).where(eq(schemaSources.id, customItem.upstreamSourceId)).get();
      if (sourceRow) {
         const overrides = (playlist as any).sourceOverrides?.[sourceRow.id];
         const effectiveUsername = overrides?.username || sourceRow.username;
         const effectivePassword = overrides?.password || sourceRow.password;
         const cl = new XtreamClient({ ...sourceRow, username: effectiveUsername, password: effectivePassword } as any);
         const targetUrl = type === 'live' ? cl.getLiveStreamUrl(customItem.upstreamStreamId, ext) : cl.getVodStreamUrl(customItem.upstreamStreamId, ext);
         return res.redirect(targetUrl);
      }
    }

    // Look up mapping by streamId (which was generated as mapping.order)
    // Note: since id maps to order, we need to find the mapping with that order.
    // Also, if playlist is not synced, streamId IS the order.
    let targetOriginalId = streamId;`;

code = code.replace(searchUrlResolve, replaceUrlResolve);

fs.writeFileSync('server/routes/proxy.ts', code);
