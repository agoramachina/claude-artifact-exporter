// Import JSZip for creating ZIP files
importScripts('jszip.min.js');

// Fetch all conversations from the organization
async function fetchAllConversations(orgId) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;

  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch conversations: ${response.status}`);
  }

  return await response.json();
}

// Fetch full conversation data including all messages
async function fetchConversation(orgId, conversationId) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch conversation: ${response.status}`);
  }

  return await response.json();
}

// Extract artifacts from message text using regex
function extractArtifacts(text) {
  const artifactRegex = /<antArtifact[^>]*>([\s\S]*?)<\/antArtifact>/g;
  const artifacts = [];
  let match;

  while ((match = artifactRegex.exec(text)) !== null) {
    const fullTag = match[0];
    const content = match[1];

    const titleMatch = fullTag.match(/title="([^"]*)/);
    const languageMatch = fullTag.match(/language="([^"]*)/);

    artifacts.push({
      title: titleMatch ? titleMatch[1] : 'Untitled',
      language: languageMatch ? languageMatch[1] : 'txt',
      content: content.trim(),
    });
  }

  return artifacts;
}

// Get file extension from language
function getFileExtension(language) {
  const languageToExt = {
    javascript: '.js',
    html: '.html',
    css: '.css',
    python: '.py',
    java: '.java',
    c: '.c',
    cpp: '.cpp',
    ruby: '.rb',
    php: '.php',
    swift: '.swift',
    go: '.go',
    rust: '.rs',
    typescript: '.ts',
    shell: '.sh',
    sql: '.sql',
    kotlin: '.kt',
    scala: '.scala',
    r: '.r',
    matlab: '.m',
    json: '.json',
    xml: '.xml',
    yaml: '.yaml',
    markdown: '.md',
    text: '.txt',
  };
  return languageToExt[language.toLowerCase()] || '.txt';
}

// Generate unique filename
function getUniqueFileName(title, language, usedNames, conversationFolder = '') {
  let baseName = title.replace(/[^\w\-._/]+/g, '_');
  let extension = getFileExtension(language);

  // Handle path-like titles (e.g., "src/components/Button.jsx")
  const parts = baseName.split('/');
  if (parts.length > 1) {
    const fileName = parts.pop();
    const subDir = parts.join('/');
    baseName = `${conversationFolder}/${subDir}/${fileName}`;
  } else {
    baseName = `${conversationFolder}/${baseName}`;
  }

  let fileName = `${baseName}${extension}`;
  let counter = 1;

  while (usedNames.has(fileName)) {
    fileName = `${baseName}_${counter}${extension}`;
    counter++;
  }

  usedNames.add(fileName);
  return fileName;
}

// Process conversation to extract artifacts
function processConversation(conversation, zip, usedNames) {
  let artifactCount = 0;

  if (!conversation.chat_messages) {
    return artifactCount;
  }

  // Sanitize conversation name for folder
  const conversationName = (conversation.name || 'Untitled').replace(/[^\w\-._]+/g, '_');

  // Process all messages in the conversation
  for (const message of conversation.chat_messages) {
    if (message.sender === 'assistant' && message.content) {
      // Handle both old format (text field) and new format (content array)
      let messageText = '';

      if (Array.isArray(message.content)) {
        // New format: content is an array of content blocks
        for (const content of message.content) {
          if (content.text) {
            messageText += content.text;
          }
        }
      } else if (typeof message.content === 'string') {
        // Old format: content is a string
        messageText = message.content;
      } else if (message.text) {
        // Even older format: direct text field
        messageText = message.text;
      }

      if (messageText) {
        const artifacts = extractArtifacts(messageText);

        for (const artifact of artifacts) {
          const fileName = getUniqueFileName(
            artifact.title,
            artifact.language,
            usedNames,
            conversationName
          );

          zip.file(fileName, artifact.content);
          artifactCount++;
        }
      }
    }
  }

  return artifactCount;
}

// Convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Main export handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'exportArtifacts') {
    (async () => {
      try {
        console.log('Starting bulk artifact export...');

        // Fetch all conversations
        const conversations = await fetchAllConversations(request.orgId);
        console.log(`Found ${conversations.length} conversations`);

        const zip = new JSZip();
        const usedNames = new Set();
        let totalArtifacts = 0;
        let conversationsWithArtifacts = 0;
        let processedCount = 0;

        // Process each conversation
        for (const conv of conversations) {
          try {
            processedCount++;

            // Send progress update
            chrome.runtime.sendMessage({
              action: 'exportProgress',
              current: processedCount,
              total: conversations.length,
              conversationName: conv.name || 'Untitled'
            });

            console.log(`Processing ${processedCount}/${conversations.length}: ${conv.name || conv.uuid}`);

            // Fetch full conversation data
            const fullConv = await fetchConversation(request.orgId, conv.uuid);

            // Extract artifacts from this conversation
            const artifactCount = processConversation(fullConv, zip, usedNames);

            if (artifactCount > 0) {
              totalArtifacts += artifactCount;
              conversationsWithArtifacts++;
              console.log(`  Found ${artifactCount} artifact(s)`);
            }

            // Add delay to avoid overwhelming the API
            await new Promise(resolve => setTimeout(resolve, 500));

          } catch (error) {
            console.error(`Failed to process conversation ${conv.uuid}:`, error);
            // Continue with next conversation even if one fails
          }
        }

        if (totalArtifacts === 0) {
          sendResponse({
            success: false,
            error: 'No artifacts found in any conversations'
          });
          return;
        }

        console.log(`Creating ZIP with ${totalArtifacts} artifacts from ${conversationsWithArtifacts} conversations...`);

        // Generate ZIP file
        const content = await zip.generateAsync({ type: 'blob' });

        // Convert to base64 for download
        const arrayBuffer = await content.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);

        // Download the ZIP
        const timestamp = new Date().toISOString().split('T')[0];
        const filename = `claude-artifacts-${timestamp}.zip`;

        chrome.downloads.download({
          url: `data:application/zip;base64,${base64}`,
          filename: filename,
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError);
            sendResponse({
              success: false,
              error: 'Failed to download ZIP file'
            });
          } else {
            console.log('Export completed successfully!');
            sendResponse({
              success: true,
              artifactCount: totalArtifacts,
              conversationCount: conversationsWithArtifacts,
              totalConversations: conversations.length
            });
          }
        });

      } catch (error) {
        console.error('Export error:', error);
        sendResponse({
          success: false,
          error: error.message
        });
      }
    })();

    return true; // Keep message channel open for async response
  }
});
