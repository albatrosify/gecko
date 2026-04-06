const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

const search = `    // Look up stream mapping by raw upstream stream ID.
    const { mappings: schemaMappings, sources: schemaSources } = await import('../schema.ts');
    const { eq, and, inArray } = await import('drizzle-orm');`;

const replace = `    // Resolve custom category items first!
    const activeTab = type === 'live' ? 'live' : (type === 'movie' ? 'vod' : 'series');
    const { mappings: schemaMappings, sources: schemaSources, customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');
    const { eq, and, inArray } = await import('drizzle-orm');

    const customItem = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.streamId, streamId))).get();
    if (customItem) {
      const targetOriginalId = customItem.upstreamStreamId;
      const targetSourceId = customItem.upstreamSourceId;
      const sourceRow = db.select().from(schemaSources).where(eq(schemaSources.id, targetSourceId)).get();
      if (!sourceRow) return res.status(404).send("Custom item source not found");
      const overrides = (playlist as any).sourceOverrides?.[sourceRow.id];
      const effectiveUsername = overrides?.username || sourceRow.username;
      const effectivePassword = overrides?.password || sourceRow.password;
      const cl = new XtreamClient({ ...sourceRow, username: effectiveUsername, password: effectivePassword } as any);
      const targetExt = ext || (type === 'live' ? 'ts' : 'mp4');
      const targetUrl = type === 'live' ? cl.getLiveStreamUrl(targetOriginalId, targetExt) : (type === 'movie' ? cl.getVodStreamUrl(targetOriginalId, targetExt) : cl.getSeriesStreamUrl(targetOriginalId, targetExt));
      return res.redirect(targetUrl);
    }

    // Look up stream mapping by raw upstream stream ID.`;

code = code.replace(search, replace);
fs.writeFileSync('server/routes/proxy.ts', code);
