import SxClient from '../client.js';
import { readFile } from 'fs/promises';

// ============ Simple Client Test ============
async function testFileClient() {
    console.log('🔄 Testing file client functionality...');
    
    const client = new SxClient();
    
    // Test 1: Check if sendFile method exists
    if (typeof client.sendFile === 'function') {
        console.log('✅ sendFile method exists');
    } else {
        console.log('❌ sendFile method missing');
        return;
    }
    
    // Test 2: Check if onFile method exists
    if (typeof client.onFile === 'function') {
        console.log('✅ onFile method exists');
    } else {
        console.log('❌ onFile method missing');
        return;
    }
    
    // Test 3: Test _fileToDataUrl method with a simple blob
    const testContent = 'Hello World!';
    const blob = new Blob([testContent], { type: 'text/plain' });
    
    try {
        const dataUrl = await client._fileToDataUrl(blob);
        if (dataUrl.startsWith('data:')) {
            console.log('✅ _fileToDataUrl works correctly');
            console.log('📄 Data URL length:', dataUrl.length);
        } else {
            console.log('❌ _fileToDataUrl returned invalid format');
        }
    } catch (error) {
        console.log('❌ _fileToDataUrl failed:', error.message);
    }
    
    console.log('✅ Client file functionality test completed');
}

testFileClient().catch(console.error);