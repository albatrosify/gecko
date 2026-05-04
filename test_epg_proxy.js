import axios from "axios";

async function testFetchXml(url) {
    const delay = Math.random() * 500 + 500; // 500-1000ms delay
    return new Promise(resolve => setTimeout(() => resolve(`<tv>${url}</tv>`), delay));
}

async function sequential(sourceDocs) {
    const xmlParts = [];
    for (const sourceRow of sourceDocs) {
        const sExtra = sourceRow.extra || {};
        const effectiveUsername = sourceRow.username;
        const effectivePassword = sourceRow.password;

        if (!sExtra.useUpstreamEpg || !sourceRow.url || !effectiveUsername) continue;
        const upstreamEpgUrl = `${sourceRow.url}/xmltv.php?username=${encodeURIComponent(effectiveUsername)}&password=${encodeURIComponent(effectivePassword || '')}`;

        const xml = await testFetchXml(upstreamEpgUrl);
        if (xml) xmlParts.push(xml);
    }
    return xmlParts;
}

async function parallel(sourceDocs) {
    const xmlParts = [];
    const promises = [];
    for (const sourceRow of sourceDocs) {
        const sExtra = sourceRow.extra || {};
        const effectiveUsername = sourceRow.username;
        const effectivePassword = sourceRow.password;

        if (!sExtra.useUpstreamEpg || !sourceRow.url || !effectiveUsername) continue;
        const upstreamEpgUrl = `${sourceRow.url}/xmltv.php?username=${encodeURIComponent(effectiveUsername)}&password=${encodeURIComponent(effectivePassword || '')}`;

        promises.push(
            testFetchXml(upstreamEpgUrl).then(xml => {
                if (xml) xmlParts.push(xml);
            })
        );
    }
    await Promise.all(promises);
    return xmlParts;
}

const docs = Array.from({ length: 5 }, (_, i) => ({
    url: `http://source${i}.com`,
    username: `user${i}`,
    password: `pass${i}`,
    extra: { useUpstreamEpg: true }
}));

async function run() {
    console.log("Running Sequential...");
    let start = Date.now();
    await sequential(docs);
    let end = Date.now();
    console.log(`Sequential time: ${end - start}ms`);

    console.log("Running Parallel...");
    start = Date.now();
    await parallel(docs);
    end = Date.now();
    console.log(`Parallel time: ${end - start}ms`);
}

run();
