import fs from 'fs';

async function main() {
    console.log("Creating mock data for EPG proxy benchmarking...");
    // Let's create a standalone benchmark file that just measures the time it takes to fetch mock URLs sequentially vs concurrently

    const mockUrls = Array.from({length: 5}, (_, i) => `http://mock-epg-${i}.com/epg.xml`);

    // Mock fetchXml
    const fetchXml = async (url: string) => {
        // Simulate network latency (e.g., 200ms)
        await new Promise(r => setTimeout(r, 200));
        return `<tv><channel id="${url}"></channel></tv>`;
    };

    const epgDocs = mockUrls.map(url => ({ url }));

    // Sequential
    const startSeq = Date.now();
    const xmlPartsSeq = [];
    for (const epgDoc of epgDocs) {
        if (!epgDoc.url) continue;
        const xml = await fetchXml(epgDoc.url);
        if (xml) xmlPartsSeq.push(xml);
    }
    const endSeq = Date.now();
    console.log(`Sequential time: ${endSeq - startSeq}ms`);

    // Concurrent
    const startConc = Date.now();
    const xmlPromises = epgDocs.map(async (epgDoc) => {
        if (!epgDoc.url) return null;
        return await fetchXml(epgDoc.url);
    });

    const results = await Promise.all(xmlPromises);
    const xmlPartsConc = results.filter(xml => xml !== null);

    const endConc = Date.now();
    console.log(`Concurrent time: ${endConc - startConc}ms`);
    console.log(`Improvement: ${((endSeq - startSeq) - (endConc - startConc)) / (endSeq - startSeq) * 100}%`);
}

main();
