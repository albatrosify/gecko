const fs = require('fs');
const locales = ['en', 'de', 'es'];

for (const locale of locales) {
    const file = `src/locales/${locale}/translation.json`;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    // Check if 'ui' is at the root level and move it under 'translation'
    if (data.ui) {
        if (!data.translation) {
             data.translation = {};
        }
        data.translation.ui = data.ui;
        delete data.ui;
    }

    // Also check for other mistakenly root-level keys from the previous script
    const rootKeys = Object.keys(data);
    for (const key of rootKeys) {
        if (key !== 'translation') {
             data.translation[key] = data[key];
             delete data[key];
        }
    }

    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log(`Fixed structure for ${locale}`);
}
