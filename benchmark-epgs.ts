import { performance } from 'perf_hooks';

const fetchXmlHead = async (url: string, sourceName: string): Promise<string> => {
  return new Promise(resolve => setTimeout(() => resolve(`xml data for ${sourceName}`), 100)); // Simulate 100ms latency
};

async function testSequential() {
  const epgDocs = [
    { url: 'url1', name: 'epg1' },
    { url: 'url2', name: 'epg2' },
    { url: 'url3', name: 'epg3' }
  ];

  const sourceDocs = [
    { extra: { useUpstreamEpg: true }, url: 'url4', username: 'user', password: 'pwd', name: 'src1' },
    { extra: { useUpstreamEpg: true }, url: 'url5', username: 'user', password: 'pwd', name: 'src2' }
  ];

  const xmlSources: { xml: string; sourceName: string }[] = [];

  const start = performance.now();

  for (const e of epgDocs) {
    if (e.url) xmlSources.push({ xml: await fetchXmlHead(e.url, e.name || e.url), sourceName: e.name || e.url });
  }

  for (const s of sourceDocs) {
    const sExtra = (s.extra as any) || {};
    if (sExtra.useUpstreamEpg && s.url && s.username) {
      const url = `${s.url}/xmltv.php?username=${encodeURIComponent(s.username)}&password=${encodeURIComponent(s.password!)}`;
      xmlSources.push({ xml: await fetchXmlHead(url, `Upstream: ${s.name || s.url}`), sourceName: `Upstream: ${s.name || s.url}` });
    }
  }

  const end = performance.now();
  console.log(`Sequential execution time: ${(end - start).toFixed(2)}ms`);
}

async function testParallel() {
  const epgDocs = [
    { url: 'url1', name: 'epg1' },
    { url: 'url2', name: 'epg2' },
    { url: 'url3', name: 'epg3' }
  ];

  const sourceDocs = [
    { extra: { useUpstreamEpg: true }, url: 'url4', username: 'user', password: 'pwd', name: 'src1' },
    { extra: { useUpstreamEpg: true }, url: 'url5', username: 'user', password: 'pwd', name: 'src2' }
  ];

  const fetchPromises: Promise<{ xml: string; sourceName: string }>[] = [];
  const start = performance.now();

  for (const e of epgDocs) {
    if (e.url) {
      const sourceName = e.name || e.url;
      fetchPromises.push(fetchXmlHead(e.url, sourceName).then(xml => ({ xml, sourceName })));
    }
  }

  for (const s of sourceDocs) {
    const sExtra = (s.extra as any) || {};
    if (sExtra.useUpstreamEpg && s.url && s.username) {
      const url = `${s.url}/xmltv.php?username=${encodeURIComponent(s.username)}&password=${encodeURIComponent(s.password!)}`;
      const sourceName = `Upstream: ${s.name || s.url}`;
      fetchPromises.push(fetchXmlHead(url, sourceName).then(xml => ({ xml, sourceName })));
    }
  }

  const xmlSources = await Promise.all(fetchPromises);
  const end = performance.now();
  console.log(`Parallel execution time: ${(end - start).toFixed(2)}ms`);
}

async function run() {
  await testSequential();
  await testParallel();
}

run();
