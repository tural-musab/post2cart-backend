const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const manifestPath = path.join(__dirname, 'manifest.json');
const lockPath = path.join(__dirname, 'backend-contract.lock.json');

const manifestContent = fs.readFileSync(manifestPath, 'utf8');
const lockContent = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

// Calculate a simple MD5 hash of the formatted manifest content
// Here we might just parse and stringify to remove whitespace differences
const normalizedManifest = JSON.stringify(JSON.parse(manifestContent));
const hash = crypto.createHash('md5').update(normalizedManifest).digest('hex');

if (hash !== lockContent.hash) {
    console.error('❌ CI Guard Failed: API Contract (manifest.json) has changed but backend-contract.lock.json has a different hash.');
    console.error(`Expected hash: ${hash}, found: ${lockContent.hash}`);
    console.error('Please update the lock file or revert changes to the manifest.');
    process.exit(1);
}

console.log('✅ CI Guard Passed: API Contract manifest and lock file are synchronized.');
process.exit(0);
