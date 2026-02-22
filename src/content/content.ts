// https://stackoverflow.com/questions/49996456/importing-json-file-in-typescript
import manifest from "../../public/manifest.json";

import messageType from '../messages/messageType';

// see 'service worker' console from extension
console.info(manifest.name + " " + manifest.version + " content script started");

chrome.runtime.onMessage.addListener((
        message: messageType,
        // sender: chrome.runtime.MessageSender,
        // sendResponse : (response: any) => void
    ) => {
        console.log(message);
    }
);
