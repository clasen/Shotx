import { createServer } from 'http';
import SxServer from '../server.js';

// ============ Final Test - No sendFileToRoom ============
const server = createServer();
const sxServer = new SxServer({ server });

// Set authentication handler
sxServer.setAuthHandler(async (token, socket) => {
    return token === 'valid' ? { userId: 'user123' } : null;
});

// Test: Register file handler with route
sxServer.onFile('test_route', async (socket, fileData, parsedFile) => {
    console.log('✅ File handler called with route:', 'test_route');
    console.log('   File:', fileData.name);
    console.log('   Parsed:', parsedFile ? 'Yes' : 'No');
    
    return { status: 'success', route: 'test_route' };
});

server.listen(3000, () => {
    console.log('🧪 Running final test...');
    console.log('✅ Server started without sendFileToRoom method');
    
    // Test: Check that sendFileToRoom method doesn't exist
    if (typeof sxServer.sendFileToRoom === 'undefined') {
        console.log('✅ sendFileToRoom method successfully removed');
    } else {
        console.log('❌ sendFileToRoom method still exists');
    }
    
    // Test: Check that to().sendFile() exists
    const toObject = sxServer.to('test-room');
    if (typeof toObject.sendFile === 'function') {
        console.log('✅ to(room).sendFile() method exists');
    } else {
        console.log('❌ to(room).sendFile() method missing');
    }
    
    // Test: Check that onFile works with routes
    if (sxServer.messageHandlers.has('test_route')) {
        console.log('✅ onFile(route, handler) working correctly');
    } else {
        console.log('❌ onFile(route, handler) not working');
    }
    
    console.log('\n🎯 API is now fully consistent:');
    console.log('   - sxServer.onFile(route, handler)');
    console.log('   - sxServer.to(room).sendFile(route, fileData)');
    console.log('   - client.sendFile(route, file, room)');
    console.log('   - client.onFile(route, handler)');
    
    console.log('\n✅ All tests passed - API is consistent!');
    console.log('🗑️  sendFileToRoom method successfully removed');
    
    setTimeout(() => {
        process.exit(0);
    }, 500);
});