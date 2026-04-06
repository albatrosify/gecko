const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const searchCopyBtn = `  const handleBatchCopy = async (newCategoryId: string, scope: 'all' | 'categories' | 'streams') => {
    let activeStreams: any[] = [];

    if (scope === 'all') {
      activeStreams = sortedStreams;
    } else if (scope === 'categories') {
      activeStreams = sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    } else if (scope === 'streams') {
      activeStreams = sortedStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));
    }

    if (activeStreams.length === 0) {
      alert("No channels selected in scope.");
      return;
    }

    const mappingLookup = new Map(mappings.filter(m => m.type === activeTab).map(m => [m.originalId, m]));

    // Check if new category is custom. For now, we only copy to custom categories to prevent polluting upstream.
    // If we allow copying anywhere, the logic is the same: create a new mapping with copy_ prefix.

    const updates = activeStreams.map(stream => {
      const sid = String(stream._rawId || stream._uniqueId);
      const existingMapping = mappingLookup.get(sid);
      const newOriginalId = \`copy_\${newCategoryId}_\${sid}\`;

      // Don't copy if it's already a copied stream (prevent infinite nesting easily)
      if (sid.startsWith('copy_')) return null;

      return {
        playlistId: id,
        type: activeTab,
        originalId: newOriginalId,
        originalName: stream.name || stream.title || '',
        customName: existingMapping?.customName || stream.name || stream.title || '',
        order: existingMapping?.order ?? stream.order ?? 999999,
        hidden: false,
        categoryId: newCategoryId,
        epgMapping: existingMapping?.epgMapping,
        epgIcon: existingMapping?.epgIcon || '',
        epgSource: existingMapping?.epgSource || '',
        sourceIdx: stream._sourceIdx ?? 0,
        regexRenames: existingMapping?.regexRenames
      };
    }).filter(Boolean);

    if (updates.length > 0) {
      try {
        setLoading(true);
        // We use batchUpdate which does upserts, but since these are new originalIds without 'id', it will insert them.
        await api.mappings.batchUpdate(updates as any[]);
        await refreshMappings();
      } catch (error) {
        console.error("Batch copy failed:", error);
        alert("Failed to apply batch changes.");
      } finally {
        setLoading(false);
      }
    } else {
      alert("No changes to apply.");
    }
  };`;

const replaceCopyBtn = `  const handleBatchCopy = async (targetCustomCategoryIdStr: string, scope: 'all' | 'categories' | 'streams') => {
    let activeStreams: any[] = [];

    if (scope === 'all') {
      activeStreams = sortedStreams;
    } else if (scope === 'categories') {
      activeStreams = sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    } else if (scope === 'streams') {
      activeStreams = sortedStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));
    }

    if (activeStreams.length === 0) {
      alert("No channels selected in scope.");
      return;
    }

    let targetCustomCategoryId = targetCustomCategoryIdStr;
    if (targetCustomCategoryIdStr.startsWith('custom_')) {
      targetCustomCategoryId = targetCustomCategoryIdStr.substring(7);
    }

    // Find the custom category
    const cc = customCategories.find(c => c.id === targetCustomCategoryId || c.name === targetCustomCategoryIdStr);
    if (!cc) {
      alert("Target custom category not found.");
      return;
    }

    const trueCustomCategoryId = cc.id;

    // Build custom category items
    const items = activeStreams.map(stream => {
      // Avoid copying copies for simplicity, or handle resolving their original IDs
      if (stream._isCopy) return null;

      const upstreamStreamId = String(stream.stream_id ?? stream.series_id);
      const upstreamSourceId = playlist.sourceIds[stream._sourceIdx ?? 0];
      if (!upstreamSourceId) return null;

      const streamId = String(Date.now() + Math.floor(Math.random() * 1000));

      return {
        customCategoryId: trueCustomCategoryId,
        playlistId: id,
        type: activeTab,
        upstreamStreamId,
        upstreamSourceId,
        streamId,
        extra: {
          name: stream.name || stream.title || '',
          stream_icon: stream.stream_icon,
          cover: stream.cover
        }
      };
    }).filter(Boolean);

    if (items.length > 0) {
      try {
        setLoading(true);
        await api.customCategoryItems.batchCreate(items);
        await refreshMappings();
        // Since loadData depends on these to inject clones into the UI stream array, we should re-load data.
        await loadData(true);
      } catch (error) {
        console.error("Batch copy failed:", error);
        alert("Failed to apply batch changes.");
      } finally {
        setLoading(false);
      }
    } else {
      alert("No suitable channels to copy.");
    }
  };`;

code = code.replace(searchCopyBtn, replaceCopyBtn);
fs.writeFileSync('src/components/index.tsx', code);
