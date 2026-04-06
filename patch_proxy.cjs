const fs = require('fs');
let code = fs.readFileSync('server/routes/proxy.ts', 'utf8');

// LIVE CATEGORIES
const searchLiveCats = `          data = allResults.flat();

          const catMap = new Map(catMappings.filter(m => m.type === 'live').map(m => [String(m.originalId), m]));`;

const replaceLiveCats = `          data = allResults.flat();

          const customCats = db.select().from(schemaCustomCategories).where(and(eq(schemaCustomCategories.playlistId, playlist.id), eq(schemaCustomCategories.type, 'live'))).all();
          customCats.forEach(cc => {
            if (!cc.hidden) {
              data.push({ category_id: \`custom_\${cc.id}\`, category_name: cc.name, parent_id: 0, _order: cc.order, _hidden: false });
            }
          });

          const catMap = new Map(catMappings.filter(m => m.type === 'live').map(m => [String(m.originalId), m]));`;

code = code.replace(searchLiveCats, replaceLiveCats);

// VOD CATEGORIES
const searchVodCats = `            data = allResults.flat();

            const catMap = new Map(catMappings.filter(m => m.type === 'vod').map(m => [String(m.originalId), m]));`;

const replaceVodCats = `            data = allResults.flat();

            const customCats = db.select().from(schemaCustomCategories).where(and(eq(schemaCustomCategories.playlistId, playlist.id), eq(schemaCustomCategories.type, 'vod'))).all();
            customCats.forEach(cc => {
              if (!cc.hidden) {
                data.push({ category_id: \`custom_\${cc.id}\`, category_name: cc.name, parent_id: 0, _order: cc.order, _hidden: false });
              }
            });

            const catMap = new Map(catMappings.filter(m => m.type === 'vod').map(m => [String(m.originalId), m]));`;

code = code.replace(searchVodCats, replaceVodCats);

// SERIES CATEGORIES
const searchSeriesCats = `            data = allResults.flat();

            const catMap = new Map(catMappings.filter(m => m.type === 'series').map(m => [String(m.originalId), m]));`;

const replaceSeriesCats = `            data = allResults.flat();

            const customCats = db.select().from(schemaCustomCategories).where(and(eq(schemaCustomCategories.playlistId, playlist.id), eq(schemaCustomCategories.type, 'series'))).all();
            customCats.forEach(cc => {
              if (!cc.hidden) {
                data.push({ category_id: \`custom_\${cc.id}\`, category_name: cc.name, parent_id: 0, _order: cc.order, _hidden: false });
              }
            });

            const catMap = new Map(catMappings.filter(m => m.type === 'series').map(m => [String(m.originalId), m]));`;

code = code.replace(searchSeriesCats, replaceSeriesCats);

fs.writeFileSync('server/routes/proxy.ts', code);
