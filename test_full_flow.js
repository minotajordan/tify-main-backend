const fs = require('fs');

async function testFlow() {
  try {
    const fileContent = 'This is a test file for full flow.';
    const blob = new Blob([fileContent], { type: 'text/plain' });
    const formData = new FormData();
    formData.append('file', blob, 'flow_test.txt');

    console.log('1. Uploading file...');
    const uploadRes = await fetch('http://localhost:3333/api/upload', {
      method: 'POST',
      body: formData
    });

    if (!uploadRes.ok) {
        console.error('Upload failed:', await uploadRes.text());
        return;
    }

    const uploadData = await uploadRes.json();
    console.log('Upload success:', uploadData);

    console.log('2. Creating message with attachment...');
    const messageRes = await fetch('http://localhost:3333/api/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // You might need an Authorization header here if your backend requires it
            // 'Authorization': 'Bearer ...' 
        },
        body: JSON.stringify({
            channelId: 'channel-123', // You might need a valid channel ID
            content: 'Message with attachment from test script',
            priority: 'MEDIUM',
            isEmergency: false,
            categoryId: '31072b7f-c571-11f0-8d01-1be21eee4db9', // Assuming this is valid
            senderId: 'user-123', // Assuming this is valid
            attachments: [uploadData.url]
        })
    });

    if (!messageRes.ok) {
        console.error('Message creation failed:', await messageRes.text());
        // If it fails because of invalid IDs, that's expected in this mocked env, 
        // but we want to see if it accepts the "attachments" field at least.
        return;
    }

    const messageData = await messageRes.json();
    console.log('Message created:', messageData);

  } catch (error) {
    console.error('Error:', error);
  }
}

testFlow();
