const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

const search = `  const handleStreamProxy = async (req: express.Request, res: express.Response, type: 'live' | 'movie' | 'series') => {
    try {
      const { username, password, streamId, ext = type === 'live' ? 'ts' : 'mp4' } = req.params;

      const playlist = await findPlaylistByCredentials(username, password) as Playlist | null;
      if (!playlist) return res.status(403).send("Invalid credentials");

      const db = getDb();
      const { sources: schemaSources, mappings: schemaMappings } = await import('../schema.ts');
      const { eq, and, inArray } = await import('drizzle-orm');`;

const replace = `  const handleStreamProxy = async (req: express.Request, res: express.Response, type: 'live' | 'movie' | 'series') => {
    try {
      const { username, password, streamId, ext = type === 'live' ? 'ts' : 'mp4' } = req.params;

      const playlist = await findPlaylistByCredentials(username, password) as Playlist | null;
      if (!playlist) return res.status(403).send("Invalid credentials");

      const db = getDb();
      const { sources: schemaSources, mappings: schemaMappings, customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');
      const { eq, and, inArray } = await import('drizzle-orm');`;

code = code.replace(search, replace);

const search2 = `      let targetOriginalId = streamId;
      let targetSourceId = playlist.sourceIds?.[0];`;

const replace2 = `      let targetOriginalId = streamId;
      let targetSourceId = playlist.sourceIds?.[0];

      // Resolve custom category items first!
      const activeTab = type === 'live' ? 'live' : (type === 'movie' ? 'vod' : 'series');
      const customItem = db.select().from(schemaCustomCategoryItems).where(and(eq(schemaCustomCategoryItems.playlistId, playlist.id), eq(schemaCustomCategoryItems.streamId, streamId))).get();
      if (customItem) {
        targetOriginalId = customItem.upstreamStreamId;
        targetSourceId = customItem.upstreamSourceId;
        const sourceRow = db.select().from(schemaSources).where(eq(schemaSources.id, targetSourceId)).get();
        if (!sourceRow) return res.status(404).send("Custom item source not found");
        const overrides = (playlist as any).sourceOverrides?.[sourceRow.id];
        const effectiveUsername = overrides?.username || sourceRow.username;
        const effectivePassword = overrides?.password || sourceRow.password;
        const cl = new XtreamClient({ ...sourceRow, username: effectiveUsername, password: effectivePassword } as any);
        const targetUrl = type === 'live' ? cl.getLiveStreamUrl(targetOriginalId, ext) : (type === 'movie' ? cl.getVodStreamUrl(targetOriginalId, ext) : cl.getSeriesStreamUrl(targetOriginalId, ext));
        return res.redirect(targetUrl);
      }
`;

code = code.replace(search2, replace2);

fs.writeFileSync('server/routes/proxy.ts', code);
