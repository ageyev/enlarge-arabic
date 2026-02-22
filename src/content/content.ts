// https://stackoverflow.com/questions/49996456/importing-json-file-in-typescript
import manifest from "../../public/manifest.json";

import {enlargeArabicText, restoreOriginalText,} from "./arabic-text-processor";

import messageType from '../messages/messageType';

console.info(manifest.name + " " + manifest.version + " content script started");

chrome.runtime.onMessage.addListener((
        message: messageType,
        // sender: chrome.runtime.MessageSender,
        // sendResponse : (response: any) => void
    ) => {

        // console.info(message);

        if (message.action == "toggle"){
            if (message.enabled) {
                // Apply settings BEFORE enlarging so that spans are styled
                // correctly from the moment they appear (no flash of default values)
                enlargeArabicText();
            } else {
                restoreOriginalText();
                // clearSettings() is called inside restoreOriginalText(),
                // no need to call it again here
            }
            return;
        }
    }
);
