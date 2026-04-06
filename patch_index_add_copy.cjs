const fs = require('fs');
let code = fs.readFileSync('src/components/index.tsx', 'utf8');

const insertAfter = `  const handleBatchMove = async (newCategoryId: string, scope: 'all' | 'categories' | 'streams') => {`;

const insertText = `  const handleBatchCopy = async (targetCustomCategoryIdStr: string, scope: 'all' | 'categories' | 'streams' | 'single', specificStream?: any) => {
    let activeStreams: any[] = [];

    if (scope === 'all') {
      activeStreams = sortedStreams;
    } else if (scope === 'categories') {
      activeStreams = sortedStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    } else if (scope === 'streams') {
      activeStreams = sortedStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));
    } else if (scope === 'single' && specificStream) {
      activeStreams = [specificStream];
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
      const upstreamSourceId = playlist!.sourceIds[stream._sourceIdx ?? 0];
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
  };

  const handleBatchMove = async (newCategoryId: string, scope: 'all' | 'categories' | 'streams') => {`;

code = code.replace(insertAfter, insertText);
fs.writeFileSync('src/components/index.tsx', code);
