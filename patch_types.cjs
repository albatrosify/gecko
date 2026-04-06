const fs = require('fs');
let code = fs.readFileSync('src/types.ts', 'utf8');

const typeSearch = `export interface CategoryMapping {`;
const typeReplace = `export interface CustomCategory {
  id: string;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  name: string;
  order: number;
  hidden: boolean;
}

export interface CustomCategoryItem {
  id: string;
  customCategoryId: string;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  upstreamStreamId: string;
  upstreamSourceId: string;
  streamId: string;
  extra: any;
}

export interface CategoryMapping {`;

code = code.replace(typeSearch, typeReplace);
fs.writeFileSync('src/types.ts', code);
