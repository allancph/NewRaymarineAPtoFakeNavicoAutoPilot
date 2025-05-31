// test_socketcan.js
console.log('[TestScript] Starting test_socketcan.js...');
console.log('[TestScript] Attempting to require socketcan from default paths...');

try {
    const sc = require('socketcan');
    console.log('[TestScript] require(\'socketcan\') successful.');

    console.log('[TestScript] Attempting to create raw channel \'can0\'...');
    const channel = sc.createRawChannel('can0', true); // true for timestamps
    console.log('[TestScript] Raw channel \'can0\' created successfully.');

    console.log('[TestScript] Attempting to start channel \'can0\'...');
    channel.start();
    console.log('[TestScript] Channel \'can0\' started successfully.');

    // For a simpler initial test, just start and stop without listening:
    channel.stop();
    console.log('[TestScript] Channel can0 stopped.');
    console.log('[TestScript] test_socketcan.js completed successfully!');
    process.exit(0);

} catch (e) {
    console.error('[TestScript] AN ERROR OCCURRED:', e);
    process.exit(1);
}
