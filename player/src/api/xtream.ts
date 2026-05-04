import axios from 'axios';

type XtreamConfig = {
  url: string;
  username: string;
  password?: string;
};

export const getXtreamApi = (config: XtreamConfig) => {
  const { url, username, password } = config;
  const baseUrl = `${url}/player_api.php`;
  const baseParams = { username, password: password || '' };

  return {
    getLiveCategories: async () => {
      const res = await axios.get(baseUrl, { params: { ...baseParams, action: 'get_live_categories' } });
      return res.data;
    },
    getLiveStreams: async (categoryId?: string) => {
      const params: any = { ...baseParams, action: 'get_live_streams' };
      if (categoryId) params.category_id = categoryId;
      const res = await axios.get(baseUrl, { params });
      return res.data;
    },
    getVodCategories: async () => {
      const res = await axios.get(baseUrl, { params: { ...baseParams, action: 'get_vod_categories' } });
      return res.data;
    },
    getVodStreams: async (categoryId?: string) => {
      const params: any = { ...baseParams, action: 'get_vod_streams' };
      if (categoryId) params.category_id = categoryId;
      const res = await axios.get(baseUrl, { params });
      return res.data;
    },
    getSeriesCategories: async () => {
      const res = await axios.get(baseUrl, { params: { ...baseParams, action: 'get_series_categories' } });
      return res.data;
    },
    getSeries: async (categoryId?: string) => {
      const params: any = { ...baseParams, action: 'get_series' };
      if (categoryId) params.category_id = categoryId;
      const res = await axios.get(baseUrl, { params });
      return res.data;
    },
    getSeriesInfo: async (seriesId: string) => {
      const res = await axios.get(baseUrl, { params: { ...baseParams, action: 'get_series_info', series_id: seriesId } });
      return res.data;
    }
  };
};
