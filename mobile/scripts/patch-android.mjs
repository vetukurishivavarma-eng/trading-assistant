// Re-applies signing + low-RAM build settings after `expo prebuild` wipes android/.
// Keystore lives outside the repo in ~/trade-journal-keystore (creds.txt).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const creds = Object.fromEntries(
  fs.readFileSync(path.join(os.homedir(), 'trade-journal-keystore', 'creds.txt'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)));

const propsFile = 'android/gradle.properties';
let props = fs.readFileSync(propsFile, 'utf8')
  .replace(/^org\.gradle\.jvmargs=.*$/m, 'org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m')
  .replace(/^reactNativeArchitectures=.*$/m, 'reactNativeArchitectures=arm64-v8a');
if (!props.includes('TJ_STORE_FILE')) props += `
org.gradle.parallel=false
org.gradle.workers.max=2
kotlin.compiler.execution.strategy=in-process
TJ_STORE_FILE=${creds.store}
TJ_STORE_PASSWORD=${creds.password}
TJ_KEY_ALIAS=${creds.alias}
`;
fs.writeFileSync(propsFile, props);

const gradleFile = 'android/app/build.gradle';
let g = fs.readFileSync(gradleFile, 'utf8');
if (!g.includes('TJ_STORE_FILE')) {
  g = g.replace(/(signingConfigs \{\s*debug \{[^}]*\})/, `$1
        release {
            storeFile file(TJ_STORE_FILE)
            storePassword TJ_STORE_PASSWORD
            keyAlias TJ_KEY_ALIAS
            keyPassword TJ_STORE_PASSWORD
        }`);
  g = g.replace(/(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/, '$1signingConfig signingConfigs.release');
  if (!g.includes('signingConfig signingConfigs.release')) throw new Error('build.gradle layout changed, signing not applied');
}
fs.writeFileSync(gradleFile, g);
console.log('android/ patched: release signing + low-RAM gradle');
