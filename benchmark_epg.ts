import { performance } from 'perf_hooks';

// Mock function representing network delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const fetchXml = async (url: string) => {
  await delay(500); // simulate 500ms network request
  return `<tv source="${url}"></tv>`;
};

async function sequential(sources: string[]) {
  const start = performance.now();
  const xmlParts: string[] = [];
  for (const url of sources) {
    const xml = await fetchXml(url);
    if (xml) xmlParts.push(xml);
  }
  const end = performance.now();
  console.log(`Sequential took ${(end - start).toFixed(2)} ms`);
}

async function parallel(sources: string[]) {
  const start = performance.now();
  const fetchPromises = [];
  for (const url of sources) {
    fetchPromises.push(fetchXml(url));
  }
  const results = await Promise.all(fetchPromises);
  const xmlParts = results.filter(Boolean);
  const end = performance.now();
  console.log(`Parallel took ${(end - start).toFixed(2)} ms`);
}

const sources = ['url1', 'url2', 'url3', 'url4', 'url5'];

async function run() {
  await sequential(sources);
  await parallel(sources);
}

run();
