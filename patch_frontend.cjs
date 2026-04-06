const fs = require('fs');
let code = fs.readFileSync('src/api.ts', 'utf8');

const search = `export const categoryMappings = {`;
const replace = `export const customCategories = {
  async list(playlistId: string) {
    return request<any[]>(\`/api/custom-categories?playlistId=\${playlistId}\`);
  },
  async create(data: any) {
    return request<any>('/api/custom-categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async update(id: string, data: any) {
    return request<any>(\`/api/custom-categories/\${id}\`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async remove(id: string) {
    return request<any>(\`/api/custom-categories/\${id}\`, { method: 'DELETE' });
  },
};

export const customCategoryItems = {
  async list(playlistId: string) {
    return request<any[]>(\`/api/custom-category-items?playlistId=\${playlistId}\`);
  },
  async create(data: any) {
    return request<any>('/api/custom-category-items', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async batchCreate(items: any[]) {
    return request<any>('/api/custom-category-items/batch', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  },
  async remove(id: string) {
    return request<any>(\`/api/custom-category-items/\${id}\`, { method: 'DELETE' });
  },
};

export const categoryMappings = {`;

code = code.replace(search, replace);

const exportSearch = `const api = { auth, sources, epgs, playlists, mappings, categoryMappings, upstream, proxy, admin, system, settings, qualityScan };`;
const exportReplace = `const api = { auth, sources, epgs, playlists, mappings, categoryMappings, customCategories, customCategoryItems, upstream, proxy, admin, system, settings, qualityScan };`;

code = code.replace(exportSearch, exportReplace);

fs.writeFileSync('src/api.ts', code);
