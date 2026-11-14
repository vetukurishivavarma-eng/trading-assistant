// Lets the app import ../journal.mjs, the same logic the web version runs.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];
if (!config.resolver.sourceExts.includes('mjs')) config.resolver.sourceExts.push('mjs');
module.exports = config;
